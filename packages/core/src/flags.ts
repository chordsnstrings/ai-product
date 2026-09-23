import { createHash } from 'node:crypto';
import type { Tx } from '@arkiv/db';
import { DomainError, env } from '@arkiv/shared';

/**
 * Feature flags and kill switches (plan 05 §20). Read-only for app code; staff edit via admin.
 *
 * A flag has a default (`enabled` + `rules`) and optional per-environment values under `rules.env`, keyed by
 * APP_ENV: `{"env": {"staging": true, "production": {"pct": 10}}}` — a boolean switches the flag in that
 * environment, an object overrides the default rules there (and may set `enabled`).
 * Kinds: boolean · percentage (`pct`, sticky per workspace) · workspace_allowlist (`workspaces`) ·
 * plan (`plans`: the workspace's plan code must be listed).
 */
interface Rules {
  pct?: number;
  workspaces?: string[];
  plans?: string[];
  enabled?: boolean;
  env?: Record<string, boolean | Rules>;
}

/** Deployment environment for per-environment flag values (APP_ENV, else derived from NODE_ENV). */
export const appEnv = () => env().APP_ENV ?? (env().NODE_ENV === 'production' ? 'production' : env().NODE_ENV);

/** Resolve the default and this environment's value into the effective switch + rules. */
export function effectiveFlag(enabled: boolean, rules: Rules | null | undefined, environment = appEnv()): { enabled: boolean; rules: Rules } {
  const base = rules ?? {};
  const perEnv = base.env?.[environment];
  if (perEnv === undefined) return { enabled, rules: base };
  if (typeof perEnv === 'boolean') return { enabled: perEnv, rules: base };
  return { enabled: perEnv.enabled ?? enabled, rules: { ...base, ...perEnv } };
}

export async function isFlagOn(tx: Tx, key: string, workspaceId?: string): Promise<boolean> {
  const [f] = await tx`select kind, enabled, rules, expires_at from feature_flags where key = ${key}`;
  if (!f) return false;
  const { enabled, rules } = effectiveFlag(f.enabled as boolean, f.rules as Rules);
  if (!enabled) return false;
  if (f.expires_at && new Date(f.expires_at as string) < new Date()) return false;
  switch (f.kind) {
    case 'boolean':
      return true;
    case 'percentage': {
      if (!workspaceId) return (rules.pct ?? 0) >= 100;
      const bucket = parseInt(createHash('sha256').update(`${key}:${workspaceId}`).digest('hex').slice(0, 8), 16) % 100;
      return bucket < (rules.pct ?? 0);
    }
    case 'workspace_allowlist':
      return !!workspaceId && (rules.workspaces ?? []).includes(workspaceId);
    case 'plan': {
      if (!workspaceId) return false;
      const [w] = await tx`select plan_code from workspaces where id = ${workspaceId}`;
      return !!w?.plan_code && (rules.plans ?? []).includes(w.plan_code as string);
    }
    default:
      return false;
  }
}

/**
 * Weights must be finite and non-negative, and at least one must be positive. Zero-weight variants are kept
 * (a paused arm) but never assigned. Used by the assignment below and by the admin editors that store weights.
 */
export function assertVariantWeights(variants: readonly { key: string; weight: number }[]): void {
  if (variants.some((v) => typeof v.weight !== 'number' || !Number.isFinite(v.weight) || v.weight < 0))
    throw new DomainError('INVALID', 'Variant weights must be non-negative numbers.');
  if (!variants.some((v) => v.weight > 0)) throw new DomainError('INVALID', 'At least one variant needs a positive weight.');
}

/**
 * Deterministic variant assignment for experiments (Offer Engine, landing variants): sticky per subject.
 * The hash maps to a uniform point in [0, total) and is compared against cumulative weights, so fractional
 * weights (0.5/0.5, 0.2/0.8) split traffic in proportion rather than collapsing onto one integer bucket.
 */
export function assignVariant(experimentKey: string, subjectId: string, variants: readonly { key: string; weight: number }[]): string {
  assertVariantWeights(variants);
  const total = variants.reduce((s, v) => s + v.weight, 0);
  const unit = parseInt(createHash('sha256').update(`${experimentKey}:${subjectId}`).digest('hex').slice(0, 8), 16) / 2 ** 32;
  const point = unit * total;
  let acc = 0;
  let last: string | null = null;
  for (const v of variants) {
    if (v.weight <= 0) continue;
    acc += v.weight;
    last = v.key;
    if (point < acc) return v.key;
  }
  return last!; // floating-point rounding at the top edge lands on the last positive-weight variant
}

/** Landing/offer rendering must never fail on a misconfigured experiment: fall back to the control content. */
export function assignVariantOrNull(experimentKey: string, subjectId: string, variants: readonly { key: string; weight: number }[] | null | undefined): string | null {
  if (!variants?.length) return null;
  try {
    return assignVariant(experimentKey, subjectId, variants);
  } catch {
    return null;
  }
}

/**
 * Flags past their expiry date and who to tell (plan 05 §20: "flags past expiry alert their owner"). The owner
 * field is an email, a staff member's name, or a staff role (e.g. "growth"); SUPER_ADMINs are the fallback.
 */
export async function expiredFlagAlerts(tx: Tx): Promise<{ key: string; owner: string; expiredAt: string; to: string[] }[]> {
  const flags = await tx`select key, owner, expires_at from feature_flags where expires_at < now() and key not like 'kill.%' order by expires_at`;
  const out: { key: string; owner: string; expiredAt: string; to: string[] }[] = [];
  for (const f of flags) {
    const owner = String(f.owner).trim();
    let to: string[] = owner.includes('@') ? [owner.toLowerCase()] : [];
    if (!to.length) {
      to = (await tx`select email from staff_users where active and (lower(name) = lower(${owner}) or upper(${owner}) = any(roles))`).map((r) => String(r.email));
    }
    if (!to.length) to = (await tx`select email from staff_users where active and 'SUPER_ADMIN' = any(roles)`).map((r) => String(r.email));
    out.push({ key: f.key as string, owner, expiredAt: new Date(f.expires_at as string).toISOString(), to });
  }
  return out;
}
