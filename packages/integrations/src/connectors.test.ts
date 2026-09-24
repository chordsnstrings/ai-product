import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, signState, verifyState } from './crypto';
import { hmacHex } from './crypto';
import { normalizeMetaInsight, normalizeShopifyProduct, normalizeTikTokRow, verifyShopifyQuery } from './connectors';

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

describe('Shopify product normalization (§42 variants)', () => {
  it('keeps each variant’s options, availability and image; drops the "Default Title" placeholder', () => {
    const p = normalizeShopifyProduct({
      id: 'gid://shopify/Product/1', title: 'Glow Serum', description: 'x', status: 'ACTIVE', vendor: 'Lumen', updatedAt: '2026-09-01',
      media: { nodes: [{ image: { url: 'https://cdn/p.jpg' } }] },
      variants: { nodes: [
        { id: 'gid://shopify/ProductVariant/11', title: '30 ml', price: '38.00', compareAtPrice: null, sku: 'GS30', barcode: null, availableForSale: true, selectedOptions: [{ name: 'Size', value: '30 ml' }], image: { url: 'https://cdn/30.jpg' } },
        { id: 'gid://shopify/ProductVariant/12', title: '50 ml', price: '52.00', compareAtPrice: '58.00', sku: 'GS50', barcode: '0123', availableForSale: false, selectedOptions: [{ name: 'Size', value: '50 ml' }], image: null },
      ] },
    });
    expect(p.variants).toEqual([
      { id: 'gid://shopify/ProductVariant/11', title: '30 ml', price: 38, compareAtPrice: null, sku: 'GS30', barcode: null, options: { Size: '30 ml' }, available: true, imageUrl: 'https://cdn/30.jpg' },
      { id: 'gid://shopify/ProductVariant/12', title: '50 ml', price: 52, compareAtPrice: 58, sku: 'GS50', barcode: '0123', options: { Size: '50 ml' }, available: false, imageUrl: null },
    ]);
    const single = normalizeShopifyProduct({ id: '2', title: 'Balm', status: 'ACTIVE', variants: { nodes: [{ id: '21', title: 'Default Title', price: '20', selectedOptions: [{ name: 'Title', value: 'Default Title' }] }] } });
    expect(single.variants[0]!.options).toEqual({});
  });
});
