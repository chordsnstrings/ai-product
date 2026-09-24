/** Pure helpers behind the funnel screens (apps/web/components/flow.tsx), kept here so they can be unit-tested. */

/** Source of a disputed candidate, in customer words (plan 03 P4 "$38.00 · from your page"). */
const FROM_WORDS: Record<string, string> = { shopify: 'from your store', product_page: 'from your page', json_ld: 'from your page', photo_ocr: 'from your photo', import: 'from your import', vision: 'from your photo' };

/**
 * Distinct candidate values of a disputed fact, each with where it came from — one tap picks one (plan 03 P4
 * "a correction must take ≤ 1 tap per fact", surf-17). Prices read as money.
 */
export function disputeChoices(key: string, candidates: { value: string; source: string }[]): { value: string; label: string }[] {
  const seen = new Map<string, { value: string; label: string }>();
  for (const c of candidates) {
    const v = c.value.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    const n = Number(v.replace(/[^0-9.]/g, ''));
    const shown = key.includes('price') && Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : v;
    seen.set(v.toLowerCase(), { value: v, label: `${shown} · ${FROM_WORDS[c.source] ?? 'from another source'}` });
  }
  return [...seen.values()];
}
