import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADAPTER_VERSIONS,
  API_VERSIONS,
  ConnectorError,
  META_API,
  TIKTOK_API,
  metaErrorKind,
  metaExchangeCode,
  metaFetchAdStatuses,
  metaFetchInsights,
  normalizeMetaInsight,
  normalizeTikTokGmvMaxRow,
  normalizeTikTokRow,
  shopifyFetchProduct,
  shopifyFetchProducts,
  shopifyGid,
  shopifyMetafieldFacts,
  shopifyNumericId,
  tiktokAttributionWindow,
  tiktokErrorKind,
  tiktokFetchAdgroupWindows,
  tiktokFetchAdStatuses,
  tiktokFetchCampaignTypes,
  tiktokFetchGmvMaxReport,
  tiktokFetchGmvMaxStores,
  tiktokFetchReport,
  unavailableFeatures,
} from './connectors';

/**
 * Contract tests (standard §51 "contract tests for Shopify/Meta/TikTok adapters using recorded fixtures and
 * schema-version checks"). Each adapter is run against a stubbed fetch: the exact request (URL, API version,
 * headers, body) is asserted, the fixture is parsed, and every error class maps as the sync expects — including
 * a changed response shape, which must fail safely (schema_changed) rather than ingest zeros.
 */

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; init?: RequestInit };
function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}
const kindOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof ConnectorError ? e.kind : `other: ${(e as Error).message}`));

afterEach(() => vi.unstubAllGlobals());

describe('API version pins (schema-version checks)', () => {
  it('calls exactly the pinned platform API versions', () => {
    expect(API_VERSIONS).toEqual({ shopify: '2026-07', meta: 'v23.0', tiktok: 'v1.3' });
    expect(META_API).toBe('https://graph.facebook.com/v23.0');
    expect(TIKTOK_API).toBe('https://business-api.tiktok.com/open_api/v1.3');
    expect(ADAPTER_VERSIONS).toMatchObject({ meta: expect.stringMatching(/^meta-insights@\d+$/), tiktok: expect.stringMatching(/^tiktok-report@\d+$/), shopify: expect.stringMatching(/^shopify-products@\d+$/) });
  });
});

describe('Shopify Admin GraphQL products contract', () => {
  it('posts the products query to the pinned version with the shop token and parses the recorded page', async () => {
    const calls = stub(() => json(fixture('shopify-products.json')));
    const page = await shopifyFetchProducts('glow.myshopify.com', 'shpat_x', null);
    expect(calls[0]!.url).toBe('https://glow.myshopify.com/admin/api/2026-07/graphql.json');
    expect(calls[0]!.init?.method).toBe('POST');
    expect((calls[0]!.init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_x');
    const body = JSON.parse(String(calls[0]!.init?.body)) as { query: string; variables: { cursor: string | null } };
    expect(body.variables).toEqual({ cursor: null });
    for (const field of ['handle', 'productType', 'onlineStoreUrl', 'options { name values }', 'metafields(first: 20)', 'shop { currencyCode ianaTimezone }', 'availableForSale']) expect(body.query).toContain(field);
    expect(page).toMatchObject({ currency: 'EUR', timezone: 'Europe/Berlin', next: 'eyJsYXN0X2lkIjo5OX0=' });
    const p = page.products[0]!;
    expect(p).toMatchObject({
      id: 'gid://shopify/Product/99', title: 'Dew Serum', handle: 'dew-serum', productType: 'Serum', vendor: 'Glow Lab', status: 'ACTIVE',
      onlineStoreUrl: 'https://glow.example/products/dew-serum', images: ['https://cdn.shopify.example/dew-front.jpg', 'https://cdn.shopify.example/dew-back.jpg'],
      options: [{ name: 'Size', values: ['30 ml', '50 ml'] }],
    });
    expect(p.variants.map((v) => [v.id, v.price, v.compareAtPrice, v.sku, v.available])).toEqual([
      ['gid://shopify/ProductVariant/991', 38, null, 'DEW-30', true],
      ['gid://shopify/ProductVariant/992', 52, 58, 'DEW-50', false],
    ]);
    // Metafields that state product truth become facts; a rating metafield does not.
    expect(shopifyMetafieldFacts(p.metafields ?? [])).toEqual([
      { key: 'ingredients', value: 'Aqua, Glycerin, Niacinamide, Sodium Hyaluronate', source: 'custom.ingredients' },
      { key: 'size', value: '30 ml', source: 'custom.volume' },
    ]);
  });

  it('fetches one product by either id form (webhook) and reports a deleted product as null', async () => {
    const node = fixture<{ data: { products: { nodes: Record<string, unknown>[] } } }>('shopify-products.json').data.products.nodes[0];
    const calls = stub((_u, init) => (JSON.parse(String(init?.body)).variables.id === 'gid://shopify/Product/99' ? json({ data: { shop: { currencyCode: 'EUR' }, product: node } }) : json({ data: { shop: {}, product: null } })));
    expect((await shopifyFetchProduct('glow.myshopify.com', 't', '99')).product?.id).toBe('gid://shopify/Product/99');
    expect((await shopifyFetchProduct('glow.myshopify.com', 't', 'gid://shopify/Product/5')).product).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('maps errors: 401 revoked, 429 and THROTTLED rate-limited, 5xx transient, a changed shape schema_changed', async () => {
    stub(() => new Response('', { status: 401 }));
    expect(await kindOf(shopifyFetchProducts('s.myshopify.com', 't', null))).toBe('auth_revoked');
    stub(() => new Response('', { status: 429, headers: { 'retry-after': '4' } }));
    expect(await kindOf(shopifyFetchProducts('s.myshopify.com', 't', null))).toBe('rate_limited');
    stub(() => json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }));
    expect(await kindOf(shopifyFetchProducts('s.myshopify.com', 't', null))).toBe('rate_limited');
    stub(() => new Response('<html>502</html>', { status: 502 }));
    expect(await kindOf(shopifyFetchProducts('s.myshopify.com', 't', null))).toBe('network');
    stub(() => json({ data: { shop: {}, productz: { nodes: [] } } }));
    expect(await kindOf(shopifyFetchProducts('s.myshopify.com', 't', null))).toBe('schema_changed');
    stub(() => json({ data: { shop: {}, products: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/Product/1', name: 'renamed title field', status: 'ACTIVE' }] } } }));
    expect(await kindOf(shopifyFetchProducts('s.myshopify.com', 't', null))).toBe('schema_changed');
    stub(() => {
      throw new TypeError('fetch failed');
    });
    expect(await kindOf(shopifyFetchProducts('s.myshopify.com', 't', null))).toBe('network');
  });

  it('keeps one id form: storefront numeric ids and GraphQL gids name the same product', () => {
    expect(shopifyGid('Product', 99)).toBe('gid://shopify/Product/99');
    expect(shopifyGid('Product', 'gid://shopify/Product/99')).toBe('gid://shopify/Product/99');
    expect(shopifyGid('ProductVariant', '991')).toBe('gid://shopify/ProductVariant/991');
    expect(shopifyNumericId('gid://shopify/Product/99')).toBe('99');
  });
});

describe('Meta Marketing API insights contract', () => {
  it('requests ad-level daily insights with the stated windows and placement breakdown, and normalizes the recorded row', async () => {
    const calls = stub(() => json(fixture('meta-insights.json')));
    const page = await metaFetchInsights('tok', 'act_1234567890', '2026-09-01', '2026-09-20', null);
    const u = new URL(calls[0]!.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://graph.facebook.com/v23.0/act_1234567890/insights');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      level: 'ad', time_increment: '1', breakdowns: 'publisher_platform,platform_position', action_attribution_windows: '["7d_click","1d_view"]',
      time_range: '{"since":"2026-09-01","until":"2026-09-20"}', limit: '200',
    });
    expect(page.next).toBe('QVFIUjZA');
    expect(page.rows[0]).toMatchObject({
      platform: 'meta', adId: '2385000000003', date: '2026-09-20', currency: 'USD', spendMicros: 42_500_000, impressions: 10000, reach: 8000, clicks: 150,
      outboundClicks: 120, videoStarts: 6000, video25: 3000, video75: 1200, video100: 800, avgWatchMs: 4200, addToCart: 12, checkout: 7, purchases: 4,
      purchaseValueMicros: 152_000_000, attributionWindow: '7d_click_1d_view', measurementContext: 'META_PAID_ATTRIBUTED', placement: 'instagram:reels',
      adapterVersion: ADAPTER_VERSIONS.meta,
    });
  });

  it('refuses a row whose required fields were renamed instead of reading them as zero', () => {
    const row = { ...fixture<{ data: Record<string, unknown>[] }>('meta-insights.json').data[0]! };
    const renamed = { ...row, amount_spent: row.spend };
    delete (renamed as Record<string, unknown>).spend;
    expect(() => normalizeMetaInsight(renamed)).toThrow(ConnectorError);
    expect(() => normalizeMetaInsight({ ...row, impressions: 'n/a' })).toThrow(/impressions/);
  });

  it('maps Graph errors: 190 revoked, throttles, permissions, transient service errors retried, request errors invalid', async () => {
    expect(metaErrorKind({ code: 190, message: 'expired' })).toBe('auth_revoked');
    expect(metaErrorKind({ code: 17, message: 'User request limit reached' })).toBe('rate_limited');
    expect(metaErrorKind({ code: 200, message: 'Requires ads_read' })).toBe('partial_scopes');
    expect(metaErrorKind({ code: 2, message: 'Service temporarily unavailable' })).toBe('network');
    expect(metaErrorKind({ code: 1, message: 'An unknown error occurred' })).toBe('network');
    expect(metaErrorKind({ code: 100, message: 'Invalid parameter', is_transient: true })).toBe('network');
    expect(metaErrorKind({ code: 100, message: 'Invalid parameter' })).toBe('invalid');
    stub(() => json({ error: { code: 2, message: 'Service temporarily unavailable', is_transient: true } }, 500));
    expect(await kindOf(metaFetchInsights('t', '1', 'a', 'b', null))).toBe('network');
    stub(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await kindOf(metaFetchInsights('t', '1', 'a', 'b', null))).toBe('network');
    stub(() => json({ data: { rows: [] } }));
    expect(await kindOf(metaFetchInsights('t', '1', 'a', 'b', null))).toBe('schema_changed');
  });

  it('exchanges the code for a long-lived token with its expiry and the permissions actually granted', async () => {
    const now = Date.parse('2026-09-24T00:00:00Z');
    stub((url) => {
      if (url.includes('grant_type=fb_exchange_token')) return json({ access_token: 'long', token_type: 'bearer', expires_in: 5_184_000 });
      if (url.includes('/oauth/access_token')) return json({ access_token: 'short', expires_in: 3600 });
      if (url.includes('/me/adaccounts')) return json({ data: [{ account_id: '1234567890', name: 'Glow Lab', currency: 'USD', timezone_name: 'America/New_York' }] });
      if (url.includes('/me/permissions')) return json({ data: [{ permission: 'ads_read', status: 'declined' }, { permission: 'public_profile', status: 'granted' }] });
      return json({ id: 'fb-user-1' });
    });
    const r = await metaExchangeCode('code', now);
    expect(r).toMatchObject({ accessToken: 'long', platformUserId: 'fb-user-1', scopes: ['public_profile'], accounts: [{ id: 'act_1234567890', currency: 'USD', timezone: 'America/New_York' }] });
    expect(r.expiresAt?.toISOString()).toBe('2026-11-23T00:00:00.000Z');
    // The declined permission is exactly what the merchant is told is unavailable (§47 "Partial scopes").
    expect(unavailableFeatures('meta', r.scopes)).toEqual([{ scope: 'ads_read', features: expect.arrayContaining(['Video watch metrics']) }]);
    expect(unavailableFeatures('meta', ['ads_read'])).toEqual([]);
  });

  it('reads ad statuses; an id Meta says does not exist is deleted, one it did not answer for stays unknown', async () => {
    stub((url) => {
      const ids = new URL(url).searchParams.get('ids')!.split(',');
      if (ids.includes('gone')) {
        if (ids.length > 1) return json({ error: { code: 100, message: '(#100) Some of the aliases you requested do not exist: gone' } });
        return json({ error: { code: 100, message: 'Object with ID gone does not exist' } });
      }
      return json(Object.fromEntries(ids.filter((i) => i !== 'silent').map((i) => [i, { id: i, effective_status: i === 'arch' ? 'ARCHIVED' : 'ACTIVE', ...(i === 'live' ? { creative: { id: '2385', video_id: '9911' } } : {}) }])));
    });
    const s = await metaFetchAdStatuses('t', ['live', 'arch', 'gone', 'silent']);
    // The creative (and video) each ad serves is read too (§48: an edit outside Arkiv changes it).
    expect(Object.fromEntries(s)).toEqual({ live: { status: 'ACTIVE', deleted: false, creativeRef: '2385:9911' }, arch: { status: 'ARCHIVED', deleted: true, creativeRef: null }, gone: { status: 'DELETED', deleted: true } });
  });
});

describe('TikTok API for Business reporting contract', () => {
  const tt = fixture<Record<string, unknown>>('tiktok-report.json');

  it('requests the BASIC ad report with the access token and normalizes the recorded row', async () => {
    const calls = stub(() => json(tt.report));
    const page = await tiktokFetchReport('tok', '7001', '2026-09-01', '2026-09-20', 1);
    const u = new URL(calls[0]!.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/');
    expect((calls[0]!.init?.headers as Record<string, string>)['Access-Token']).toBe('tok');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ advertiser_id: '7001', report_type: 'BASIC', data_level: 'AUCTION_AD', start_date: '2026-09-01', end_date: '2026-09-20', page: '1' });
    expect(JSON.parse(u.searchParams.get('metrics')!)).toEqual(expect.arrayContaining(['spend', 'impressions', 'campaign_id', 'adgroup_id', 'complete_payment']));
    expect(page.hasMore).toBe(false);
    const o = normalizeTikTokRow(page.list[0]!, '7001', 'USD', 'WEB_CONVERSIONS');
    expect(o).toMatchObject({ adId: '1790000000000001', date: '2026-09-20', spendMicros: 10_000_000, impressions: 5000, clicks: 40, purchases: 3, campaignId: '1780000000000001', adgroupId: '1770000000000001', measurementContext: 'TIKTOK_PAID_ATTRIBUTED', campaignType: 'WEB_CONVERSIONS', adapterVersion: ADAPTER_VERSIONS.tiktok });
  });

  it('refuses a report row whose metric names changed', () => {
    const row = (tt.report as { data: { list: { dimensions: Record<string, string>; metrics: Record<string, string> }[] } }).data.list[0]!;
    const { spend, ...rest } = row.metrics;
    expect(() => normalizeTikTokRow({ dimensions: row.dimensions, metrics: { ...rest, cost: spend! } }, '7001', 'USD', null)).toThrow(/spend/);
    expect(() => normalizeTikTokRow({ dimensions: { stat_time_day: '2026-09-20' }, metrics: row.metrics }, '7001', 'USD', null)).toThrow(ConnectorError);
  });

  it('resolves campaign types (GMV Max wins) and ad-group attribution windows', async () => {
    const calls = stub((url) => (url.includes('/gmv_max/campaign/get/') ? json(tt.gmvMaxCampaigns) : url.includes('/campaign/get/') ? json(tt.campaigns) : json(tt.adgroups)));
    const types = await tiktokFetchCampaignTypes('tok', '7001', ['1780000000000001', '1780000000000009']);
    expect(Object.fromEntries(types)).toEqual({ '1780000000000001': 'WEB_CONVERSIONS', '1780000000000009': 'PRODUCT_GMV_MAX' });
    expect(JSON.parse(new URL(calls[0]!.url).searchParams.get('filtering')!)).toEqual({ campaign_ids: ['1780000000000001', '1780000000000009'] });
    expect(Object.fromEntries(await tiktokFetchAdgroupWindows('tok', '7001', ['1770000000000001']))).toEqual({ '1770000000000001': '7d_click_1d_view' });
    expect(tiktokAttributionWindow('ONE_DAY', 'OFF')).toBe('1d_click');
    expect(tiktokAttributionWindow('OFF', 'OFF')).toBeNull();
  });

  it('reads GMV Max per store into its own total-channel context', async () => {
    const calls = stub((url) => (url.includes('/gmv_max/store/list/') ? json(tt.gmvMaxStores) : json(tt.gmvMaxReport)));
    const stores = await tiktokFetchGmvMaxStores('tok', '7001');
    expect(stores).toEqual(['7490000000000001']);
    const page = await tiktokFetchGmvMaxReport('tok', '7001', stores, '2026-09-01', '2026-09-20', 1);
    const u = new URL(calls[1]!.url);
    expect(u.pathname).toBe('/open_api/v1.3/gmv_max/report/get/');
    expect(JSON.parse(u.searchParams.get('store_ids')!)).toEqual(['7490000000000001']);
    const o = normalizeTikTokGmvMaxRow(page.list[0]!, '7001', 'USD');
    expect(o).toMatchObject({ adId: '7400000000000001', campaignId: '1780000000000009', spendMicros: 25_000_000, purchases: 6, purchaseValueMicros: 228_000_000, impressions: 12000, clicks: 180, measurementContext: 'TIKTOK_GMV_MAX_TOTAL', attributionWindow: 'gmv_max', adapterVersion: ADAPTER_VERSIONS.tiktokGmvMax });
  });

  it('reads deleted ads; maps TikTok codes to error classes', async () => {
    stub(() => json(tt.ads));
    expect(Object.fromEntries(await tiktokFetchAdStatuses('tok', '7001', ['1790000000000001', '1790000000000002']))).toEqual({ '1790000000000001': { status: 'AD_STATUS_DELETE', deleted: true, creativeRef: null } });
    expect(tiktokErrorKind(40105)).toBe('auth_revoked');
    expect(tiktokErrorKind(40100)).toBe('rate_limited');
    expect(tiktokErrorKind(40002)).toBe('partial_scopes');
    expect(tiktokErrorKind(51021)).toBe('network');
    expect(tiktokErrorKind(40006)).toBe('invalid');
    stub(() => json({ code: 50000, message: 'System error' }));
    expect(await kindOf(tiktokFetchReport('t', '1', 'a', 'b', 1))).toBe('network');
    stub(() => new Response('upstream', { status: 503 }));
    expect(await kindOf(tiktokFetchReport('t', '1', 'a', 'b', 1))).toBe('network');
    stub(() => json({ message: 'no code field' }));
    expect(await kindOf(tiktokFetchReport('t', '1', 'a', 'b', 1))).toBe('schema_changed');
  });
});
