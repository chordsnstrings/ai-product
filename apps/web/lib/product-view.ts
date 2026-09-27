import { formatDate } from '@arkiv/shared/format';

/**
 * Product Brain presentation helpers (plan 03 A4): each asset's rights status ("Assets (library with rights
 * status)") and yes/no offer facts.
 */

/** Uploaded footage whose use in ads rests on the merchant's rights attestation (standard §40). */
export const RIGHTS_KINDS: ReadonlySet<string> = new Set(['creator_footage', 'historical_creative']);

export interface AssetRights {
  kind: string;
  source: string;
  rightsAttestedAt: Date | string | null;
  rightsExpiresAt: Date | string | null;
  rightsFrozenAt: Date | string | null;
}

export type RightsStatus = { state: 'attested' | 'missing' | 'expired' | 'frozen' | 'not_applicable'; label: string | null };

/** The rights chip for one asset; product photos and generated work carry none. */
export function rightsStatus(a: AssetRights, now = new Date()): RightsStatus {
  if (!RIGHTS_KINDS.has(a.kind)) return { state: 'not_applicable', label: null };
  if (a.rightsFrozenAt) return { state: 'frozen', label: 'Rights on hold: not used in new ads' };
  if (a.rightsExpiresAt && new Date(a.rightsExpiresAt).getTime() <= now.getTime()) return { state: 'expired', label: 'Rights expired: not used in new ads' };
  if (!a.rightsAttestedAt) return { state: 'missing', label: 'Rights not attested' };
  return { state: 'attested', label: `Rights attested${a.rightsExpiresAt ? ` · expires ${formatDate(a.rightsExpiresAt)}` : ''}` };
}

/** Offer facts stored as booleans (subscription available, bundle eligible), read from any stored form. */
export function yesNo(v: { valueText: string | null; valueNumber: number | null; valueJson: unknown } | null | undefined): boolean | null {
  if (!v) return null;
  if (typeof v.valueJson === 'boolean') return v.valueJson;
  const t = (v.valueText ?? '').trim().toLowerCase();
  if (['yes', 'true', 'y', '1'].includes(t)) return true;
  if (['no', 'false', 'n', '0'].includes(t)) return false;
  return null;
}
