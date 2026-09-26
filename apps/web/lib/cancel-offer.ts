/**
 * The one honest alternative the cancel flow may offer (A9; standard §48 "Seasonal pause: offer honest
 * pause/downgrade where commercially sensible; preserve memory"): Launch, for a customer on a larger plan whose
 * reason is price, value or paused ads. Never on a past-due plan (it ends today) and never on Launch itself.
 */
export function downgradeOffer(reason: string, planCode: string, pastDue: boolean): 'price' | 'seasonal' | null {
  if (pastDue || planCode === 'LAUNCH') return null;
  if (reason === 'too_expensive' || reason === 'not_enough_value') return 'price';
  if (reason === 'paused_ads') return 'seasonal';
  return null;
}
