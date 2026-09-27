/**
 * The header's data-freshness chip (plan 03 Part B: "a data freshness chip ("Meta synced 2h ago")"): the platform
 * and its sync label, in the merchant's words.
 */
const NAME: Record<string, string> = { meta: 'Meta', tiktok: 'TikTok', shopify: 'Shopify' };

export function freshnessChip(f: { provider: string; label: string }): string {
  const name = NAME[f.provider] ?? f.provider;
  const lower = `${f.label.charAt(0).toLowerCase()}${f.label.slice(1)}`;
  // "Synced 2h ago" → "Meta synced 2h ago"; other labels ("Access revoked — reconnect") keep their words.
  return /^Synced /.test(f.label) ? `${name} ${lower}` : `${name}: ${lower}`;
}

/** One chip per platform: several accounts on one platform show the least fresh one (what may be incomplete). */
export function freshnessChips<F extends { provider: string; label: string; stale: boolean; lastSuccessAt: string | null }>(rows: readonly F[]): { key: string; text: string; stale: boolean }[] {
  const worst = new Map<string, F>();
  const older = (a: F, b: F) => (a.lastSuccessAt ?? '') < (b.lastSuccessAt ?? '');
  for (const r of rows) {
    const cur = worst.get(r.provider);
    if (!cur || (r.stale && !cur.stale) || (r.stale === cur.stale && older(r, cur))) worst.set(r.provider, r);
  }
  return [...worst.values()].map((r) => ({ key: r.provider, text: freshnessChip(r), stale: r.stale }));
}
