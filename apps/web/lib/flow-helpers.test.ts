import { describe, expect, it } from 'vitest';
import { awaitingPayment, conceptCost, disputeChoices, tensionSourceWords } from './flow-helpers';

describe('disputed fact choices (plan 03 P4, one tap per fact)', () => {
  it('offers each distinct value once with its source in customer words; prices read as money', () => {
    expect(
      disputeChoices('price', [
        { value: '38', source: 'product_page' },
        { value: '42', source: 'photo_ocr' },
        { value: '38', source: 'json_ld' },
      ]),
    ).toEqual([
      { value: '38', label: '$38.00 · from your page' },
      { value: '42', label: '$42.00 · from your photo' },
    ]);
    expect(disputeChoices('size', [{ value: '30 ml', source: 'shopify' }, { value: '30 ML', source: 'photo_ocr' }, { value: ' ', source: 'import' }])).toEqual([{ value: '30 ml', label: '30 ml · from your store' }]);
  });
});

describe('concept card cost and evidence (standard §13, plan 03 P5)', () => {
  it('states the estimated entitlement in the customer’s terms', () => {
    expect(conceptCost('creative_test', { kind: 'taste', status: 'active', priceMicros: 19_000_000 })).toBe('1 Creative Test');
    expect(conceptCost('preview', { kind: 'taste', status: 'active', priceMicros: 19_000_000 })).toBe('Included in your $19 intro ad');
    expect(conceptCost('preview', { kind: 'standalone', status: 'none', priceMicros: 49_500_000 })).toBe('One ad · $49.50 one-time');
  });
  it('names where the customer tension came from', () => {
    expect(tensionSourceWords('reviews')).toBe('From your reviews');
    expect(tensionSourceWords('nonsense')).toBe('Our read');
  });
});

describe('waiting for payment on P9 (plan 03 P8)', () => {
  const at = (state: string, purchase: string | null, resumable = false) => awaitingPayment({ project: { state, resumable }, purchase: purchase ? { status: purchase } : null });
  it('confirms only a real checkout; otherwise sends the customer back to the storyboard', () => {
    expect(at('STORYBOARD_READY', 'pending')).toBe('confirming');
    expect(at('STORYBOARD_READY', 'paid')).toBe('confirming');
    expect(at('STORYBOARD_READY', null)).toBe('unpaid');
    expect(at('STORYBOARD_READY', 'expired')).toBe('unpaid');
    expect(at('STORYBOARD_READY', null, true)).toBeNull();
    expect(at('RENDERING', 'paid')).toBeNull();
  });
});
