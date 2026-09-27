/**
 * Claims Vault presentation helpers (plan 03 A5): who changed a claim and what the change was, in the merchant's
 * words, and when our compliance team's review of a RESTRICTED claim is due.
 */

/** How long our compliance team takes to review a RESTRICTED claim (plan 03 A5 edge, plan 05 §14). */
export const COMPLIANCE_REVIEW_BUSINESS_DAYS = 2;

/** `from` plus `days` business days (Saturdays and Sundays skipped), in UTC. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

/** A market code as a country name ("US" → "United States"); an unknown code is shown as it is. */
export function marketName(code: string): string {
  try {
    return new Intl.DisplayNames('en', { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** A version-history change kind (claim_versions.change), in words. */
export const CLAIM_CHANGE_WORDS: Record<string, string> = {
  created: 'Added',
  wording_added: 'Another wording found',
  approved: 'Approved',
  blocked: 'Blocked',
  restricted: 'Sent to our compliance team',
  evidence_expiring: 'Back to review: evidence expiring',
};

/**
 * Who made a change, from the stored actor reference (`user:<id>`, `staff:<id>`, `system:<job>`): a member by
 * name when known, Arkiv staff as our compliance team, and automatic changes as such. Never a raw id.
 */
export function claimActorLabel(actor: string, members: ReadonlyMap<string, string>): string {
  const [kind, rest = ''] = actor.split(':', 2) as [string, string | undefined];
  if (kind === 'user') return members.get(rest) ?? 'A former member';
  if (kind === 'staff') return 'Arkiv compliance team';
  if (kind === 'system') return 'Automatic check';
  if (kind === 'provisional') return 'You (before signing up)';
  return 'Arkiv';
}
