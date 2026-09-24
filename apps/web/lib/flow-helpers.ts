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

/** Where a concept's customer tension came from (plan 03 P5 "Customer tension (with source if from reviews)"). */
const TENSION_SOURCE: Record<string, string> = { reviews: 'From your reviews', category_pattern: 'Category pattern', product_page: 'From your product page', performance: 'From your results' };
export const tensionSourceWords = (source: string): string => TENSION_SOURCE[source] ?? 'Our read';

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(micros % 1_000_000 === 0 ? 0 : 2)}`;

/**
 * A concept's estimated entitlement in the customer's terms (standard §13): one Creative Test for a subscriber;
 * in the funnel, the intro ad while its offer is live, otherwise the one-time price.
 */
export function conceptCost(projectKind: string, quote: { kind: string; status: string; priceMicros: number }): string {
  if (projectKind === 'creative_test') return '1 Creative Test';
  if (quote.kind === 'taste' && quote.status === 'active') return `Included in your ${usd(quote.priceMicros)} intro ad`;
  return `One ad · ${usd(quote.priceMicros)} one-time`;
}

/**
 * P9 while the project waits at the storyboard (plan 03 P8 edge cases): only a checkout that is actually pending
 * (or just paid) earns "Confirming your payment"; with none, the customer belongs back on the storyboard where the
 * offer still is. Null when the project is not waiting for a payment at all.
 */
export function awaitingPayment(v: { project: { state: string; resumable: boolean }; purchase: { status: string } | null }): 'confirming' | 'unpaid' | null {
  if (v.project.state !== 'STORYBOARD_READY' || v.project.resumable) return null;
  return v.purchase?.status === 'pending' || v.purchase?.status === 'paid' ? 'confirming' : 'unpaid';
}
