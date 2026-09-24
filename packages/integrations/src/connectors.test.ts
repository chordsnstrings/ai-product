import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, signState, verifyState } from './crypto';
import { hmacHex } from './crypto';
import { normalizeMetaInsight, normalizeTikTokRow, verifyShopifyQuery } from './connectors';

/** Replaces the character at `i` with a different one, so the string always changes. */
const flipChar = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

/** Contract tests with recorded-shape fixtures (§51). */
describe('token encryption', () => {
  it('round-trips and detects tampering', () => {
    const e = encryptToken('shpat_secret');
    expect(e).not.toContain('shpat');
    expect(decryptToken(e)).toBe('shpat_secret');
    // The ciphertext is 12 bytes (16 base64url characters, no padding bits), so every character is significant.
    expect(() => decryptToken(flipChar(e, e.length - 2))).toThrow();
  });
  it('signs and expires OAuth state', () => {
    const s = signState({ workspaceId: 'w', userId: 'u' });
    expect(verifyState(s)?.workspaceId).toBe('w');
    expect(verifyState(flipChar(s, s.length - 1))).toBeNull();
  });
});

describe('Shopify OAuth HMAC', () => {
  it('verifies sorted-param hex HMAC', () => {
    const q = { code: 'abc', shop: 'glow.myshopify.com', state: 's', timestamp: '1700000000' };
    const msg = 'code=abc&shop=glow.myshopify.com&state=s&timestamp=1700000000';
    expect(verifyShopifyQuery({ ...q, hmac: hmacHex('dev', msg) })).toBe(true);
    expect(verifyShopifyQuery({ ...q, hmac: 'bad' })).toBe(false);
  });
});

describe('Meta insights normalization', () => {
  it('stores raw counts + attribution context, not derived ratios', () => {
    const o = normalizeMetaInsight({
      account_id: '123', account_currency: 'USD', ad_id: '999', ad_name: 'Texture AK-014-B', date_start: '2026-09-20',
      spend: '42.50', impressions: '10000', clicks: '150', reach: '8000', frequency: '1.25',
      video_play_actions: [{ action_type: 'video_view', value: '6000' }],
      video_p75_watched_actions: [{ action_type: 'video_view', value: '1200' }],
      actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '4' }],
      action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '152.00' }],
    });
    expect(o.spendMicros).toBe(42_500_000);
    expect(o.purchases).toBe(4);
    expect(o.purchaseValueMicros).toBe(152_000_000);
    expect(o.video75).toBe(1200);
    expect(o.measurementContext).toBe('META_PAID_ATTRIBUTED');
    expect(o.attributionWindow).toBe('7d_click_1d_view');
  });
});

describe('TikTok normalization', () => {
  it('keeps GMV Max in its own measurement context (§30, §45)', () => {
    const row = { dimensions: { ad_id: '1', stat_time_day: '2026-09-20 00:00:00' }, metrics: { spend: '10', impressions: '5000', clicks: '40', complete_payment: '3' } };
    expect(normalizeTikTokRow(row, 'adv', 'USD', 'GMV_MAX').measurementContext).toBe('TIKTOK_GMV_MAX_TOTAL');
    expect(normalizeTikTokRow(row, 'adv', 'USD', null).measurementContext).toBe('TIKTOK_PAID_ATTRIBUTED');
  });
});
