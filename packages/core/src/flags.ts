import { createHash } from 'node:crypto';
import type { Tx } from '@arkiv/db';

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

/** Deterministic variant assignment for experiments (Offer Engine, landing variants): sticky per subject. */
export function assignVariant(experimentKey: string, subjectId: string, variants: { key: string; weight: number }[]): string {
  const total = variants.reduce((s, v) => s + v.weight, 0);
  const h = parseInt(createHash('sha256').update(`${experimentKey}:${subjectId}`).digest('hex').slice(0, 8), 16) % total;
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (h < acc) return v.key;
  }
  return variants[variants.length - 1]!.key;
}
