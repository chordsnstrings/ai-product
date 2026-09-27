import { describe, expect, it } from 'vitest';
import { downgradeOffer } from './cancel-offer';

describe('cancel flow alternative (A9, standard §48 seasonal pause)', () => {
  it('offers Launch for price, value and paused ads — never on Launch or a past-due plan', () => {
    expect(downgradeOffer('too_expensive', 'GROWTH', false)).toBe('price');
    expect(downgradeOffer('not_enough_value', 'SCALE', false)).toBe('price');
    expect(downgradeOffer('paused_ads', 'GROWTH', false)).toBe('seasonal');
    expect(downgradeOffer('paused_ads', 'LAUNCH', false)).toBeNull();
    expect(downgradeOffer('paused_ads', 'GROWTH', true)).toBeNull();
    expect(downgradeOffer('switching', 'GROWTH', false)).toBeNull();
  });
});
