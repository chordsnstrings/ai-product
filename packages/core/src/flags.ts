import { createHash } from 'node:crypto';
import type { Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';

/** Feature flags and kill switches (plan 05 §20). Read-only for app code; staff edit via admin. */
export async function isFlagOn(tx: Tx, key: string, workspaceId?: string): Promise<boolean> {
  const [f] = await tx`select kind, enabled, rules, expires_at from feature_flags where key = ${key}`;
  if (!f || !f.enabled) return false;
  if (f.expires_at && new Date(f.expires_at as string) < new Date()) return false;
  const rules = (f.rules ?? {}) as { pct?: number; workspaces?: string[]; plans?: string[] };
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
