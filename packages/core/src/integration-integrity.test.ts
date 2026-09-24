import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { ConnectorError, encryptToken, normalizeShopifyProduct, type NormalizedObservation, type ShopifyProduct } from '@arkiv/integrations';
import { parseShopifyProduct } from './ingest';
import {
  applyShopifyProduct,
  archiveShopifyProduct,
  connectSelectedAccounts,
  dateInZone,
  ingestObservations,
  markError,
  observationChanged,
  parsePerformanceCsv,
  saveIntegration,
  stashPendingConnection,
  sweepExpiringTokens,
  sweepStaleIntegrations,
  syncIntegration,
  TRANSIENT_FAILURES_BEFORE_DEGRADED,
} from './performance';
import { analyzeProduct, shopifyExtracted } from './analysis';
import { ingestBytes } from './uploads';
import { decideShopTransfer, listShopTransfers, requestShopTransfer, shopTransferProof, staffApproveShopTransfer } from './shop-transfer';
import { ctxFor, productPhoto } from './testing';
import { parseLocaleNumber } from './csv';

beforeEach(truncateAll);
afterEach(() => vi.unstubAllGlobals());
afterAll(closeAll);

const paid = async () => {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  return { t, ctx: ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID') };
};
const shopifyFixture = () => JSON.parse(readFileSync(new URL('../../integrations/fixtures/shopify-products.json', import.meta.url), 'utf8')) as { data: { products: { nodes: Record<string, unknown>[] } } };
const tiktokFixture = () => JSON.parse(readFileSync(new URL('../../integrations/fixtures/tiktok-report.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const product = (over: Partial<ShopifyProduct> = {}): ShopifyProduct => ({ ...normalizeShopifyProduct(shopifyFixture().data.products.nodes[0]!), ...over });

async function integration(ws: string, provider: 'meta' | 'tiktok' | 'shopify', account = 'acct_1', extra: { timezone?: string } = {}) {
  const [i] = await ownerPool()`insert into integrations (workspace_id, provider, external_account_id, status, token_enc, timezone, currency)
                                values (${ws}, ${provider}, ${account}, 'active', ${encryptToken('tok')}, ${extra.timezone ?? 'America/New_York'}, 'USD') returning id`;
  return i!.id as string;
}

describe('Shopify product identity (§42 "Duplicate import", edge-42-06 / integ-10)', () => {
  it('a product imported from its URL and then synced through the API stays one SKU', async () => {
    const { t, ctx } = await paid();
    // The storefront JSON carries the numeric id; it is stored in the Admin API's gid form.
    const fromUrl = parseShopifyProduct(JSON.stringify({ product: { id: 99, title: 'Dew Serum', body_html: '', vendor: 'Glow Lab', images: [], variants: [{ id: 991, title: '30 ml', price: '38.00', compare_at_price: null, sku: 'DEW-30' }] } }));
    expect(fromUrl?.shopifyProductId).toBe('gid://shopify/Product/99');
    expect(fromUrl?.variants?.[0]?.externalId).toBe('gid://shopify/ProductVariant/991');
    await ownerPool()`insert into skus (workspace_id, catalogue_no, name, status, source_kind, shopify_product_id) values (${t.workspaceId}, 1, 'Dew Serum', 'active', 'url', ${fromUrl!.shopifyProductId!})`;
    expect(await withTenant(t.workspaceId, (tx) => applyShopifyProduct(tx, ctx, 'glow.myshopify.com', product(), 'EUR'))).toBe('updated');
    expect(await ownerPool()`select id from skus`).toHaveLength(1);
  });

  it('concurrent imports of one product create one SKU (unique per workspace and product)', async () => {
    const { t, ctx } = await paid();
    const results = await Promise.all([1, 2, 3].map(() => withTenant(t.workspaceId, (tx) => applyShopifyProduct(tx, ctx, 'glow.myshopify.com', product(), 'EUR'))));
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(await ownerPool()`select id from skus where shopify_product_id = 'gid://shopify/Product/99'`).toHaveLength(1);
    await expect(ownerPool()`insert into skus (workspace_id, catalogue_no, name, status, shopify_product_id) values (${t.workspaceId}, 9, 'dup', 'active', 'gid://shopify/Product/99')`).rejects.toThrow(/skus_shopify_product/);
  });
});

describe('Shopify import: fields, events and the Product Brain pipeline (integ-05, integ-06, arch-07)', () => {
  it('records vendor, SKU code, currency, options, metafields and images; starts analysis; emits PRODUCT_IMPORTED', async () => {
    const { t, ctx } = await paid();
    const i = await integration(t.workspaceId, 'shopify', 'glow.myshopify.com');
    expect(await withTenant(t.workspaceId, (tx) => applyShopifyProduct(tx, ctx, 'glow.myshopify.com', product(), 'EUR', { integrationId: i }))).toBe('created');
    const [sku] = await ownerPool()`select id, status, source_kind, source_url from skus`;
    expect(sku).toMatchObject({ status: 'analyzing', source_kind: 'shopify', source_url: 'https://glow.example/products/dew-serum' });
    const facts = await ownerPool()`select normalized_key, value_text, value_number, value_json, source_url from product_facts where sku_id = ${sku!.id} and status <> 'SUPERSEDED'`;
    const f = (k: string) => facts.find((x) => x.normalized_key === k);
    expect(f('brand')?.value_text).toBe('Glow Lab');
    expect(f('sku_code')?.value_text).toBe('DEW-30');
    expect(f('product_type')?.value_text).toBe('Serum');
    expect(f('price')).toMatchObject({ value_number: 38, value_json: { currency: 'EUR' } });
    expect(f('ingredients')).toMatchObject({ value_text: 'Aqua, Glycerin, Niacinamide, Sodium Hyaluronate', source_url: 'shopify-metafield:custom.ingredients' });
    expect(f('size')?.value_text).toBe('30 ml');
    expect(f('options')?.value_json).toEqual([{ name: 'Size', values: ['30 ml', '50 ml'] }]);
    expect(f('images')?.value_json).toEqual(['https://cdn.shopify.example/dew-front.jpg', 'https://cdn.shopify.example/dew-back.jpg']);
    expect((f('source_snapshot')?.value_json as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    // The analysis project and job: paid pool, no URL read (the store's facts are the source).
    const [p] = await ownerPool()`select id, kind, state from projects where sku_id = ${sku!.id}`;
    expect(p).toMatchObject({ kind: 'preview', state: 'PRODUCT_UPLOADED' });
    const jobs = await ownerPool()`select payload from outbox where queue = 'analyze-product'`;
    expect(jobs.map((j) => j.payload)).toEqual([expect.objectContaining({ skuId: sku!.id, projectId: p!.id })]);
    expect((await ownerPool()`select step_key from progress_steps where subject_id = ${sku!.id} order by position`).map((s) => s.step_key)).not.toContain('read_page');
    const [ev] = await ownerPool()`select payload from events where type = 'PRODUCT_IMPORTED'`;
    expect(ev!.payload).toMatchObject({ source: 'shopify', shopifyProductId: 'gid://shopify/Product/99', integrationId: i });
    // What the analysis reads for this SKU: the Shopify facts, shaped like a page import.
    const x = await withTenant(t.workspaceId, (tx) => shopifyExtracted(tx, sku!.id as string));
    expect(x).toMatchObject({ source: 'shopify', name: 'Dew Serum', brand: 'Glow Lab', priceMicros: 38_000_000, currency: 'EUR', ingredients: expect.stringContaining('Niacinamide'), sizeText: '30 ml', images: expect.arrayContaining(['https://cdn.shopify.example/dew-front.jpg']) });

    // A re-sync with a new price: one PRODUCT_FACT_CHANGED for price, no dispute, no second SKU or analysis.
    await withTenant(t.workspaceId, (tx) => applyShopifyProduct(tx, ctx, 'glow.myshopify.com', product({ variants: product().variants.map((v, n) => (n === 0 ? { ...v, price: 42 } : v)) }), 'EUR'));
    const changed = await ownerPool()`select payload from events where type = 'PRODUCT_FACT_CHANGED' and payload->>'key' = 'price'`;
    expect(changed).toHaveLength(1);
    expect(await ownerPool()`select 1 from product_facts where status = 'DISPUTED'`).toHaveLength(0);
    expect(await ownerPool()`select 1 from outbox where queue = 'analyze-product'`).toHaveLength(1);
    expect(await ownerPool()`select 1 from events where type = 'PRODUCT_IMPORTED'`).toHaveLength(1);
  });

  it('the analysis of a store product reads its Shopify facts (no page fetch) and completes the Product Brain', async () => {
    const { t, ctx } = await paid();
    await withTenant(t.workspaceId, (tx) => applyShopifyProduct(tx, ctx, 'glow.myshopify.com', product({ images: [] }), 'EUR'));
    const [sku] = await ownerPool()`select id from skus`;
    const [p] = await ownerPool()`select id from projects where sku_id = ${sku!.id}`;
    await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto('DEW SERUM'), 'product_photo', sku!.id as string));
    const pageFetch = vi.fn(async () => new Response('should not be called', { status: 500 }));
    vi.stubGlobal('fetch', pageFetch);
    expect(await analyzeProduct(ctx, sku!.id as string, p!.id as string)).toEqual({ status: 'ready' });
    expect(pageFetch).not.toHaveBeenCalled();
    const [s] = await ownerPool()`select name, status from skus where id = ${sku!.id}`;
    expect(s).toEqual({ name: 'Dew Serum', status: 'active' });
    expect(await ownerPool()`select 1 from visual_fingerprints where sku_id = ${sku!.id}`).toHaveLength(1);
    expect((await ownerPool()`select state from projects where id = ${p!.id}`)[0]!.state).toBe('CONCEPTS_READY');
  });

  it('free workspaces import new store products within the daily product allowance', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const made = [];
    for (let n = 1; n <= 5; n++) made.push(await withTenant(t.workspaceId, (tx) => applyShopifyProduct(tx, ctx, 'glow.myshopify.com', product({ id: `gid://shopify/Product/${n}` }), 'EUR')));
    expect(made).toEqual(['created', 'created', 'created', 'skipped', 'skipped']);
    expect(await ownerPool()`select 1 from outbox where queue = 'analyze-product-free'`).toHaveLength(3);
  });

  it('products/delete archives the SKU; an unknown product changes nothing', async () => {
    const { t, ctx } = await paid();
    await withTenant(t.workspaceId, (tx) => applyShopifyProduct(tx, ctx, 'glow.myshopify.com', product(), 'EUR'));
    expect(await withTenant(t.workspaceId, (tx) => archiveShopifyProduct(tx, ctx, '99'))).toBe(true);
    expect(await withTenant(t.workspaceId, (tx) => archiveShopifyProduct(tx, ctx, '12345'))).toBe(false);
    expect((await ownerPool()`select status from skus`)[0]!.status).toBe('archived');
  });
});

describe('TikTok sync through the real adapters (edge-45-07, integ-17, edge-45-05)', () => {
  it('reads campaign types and ad-group windows, pulls GMV Max per store into TIKTOK_GMV_MAX_TOTAL, and records the complete day', async () => {
    const { t, ctx } = await paid();
    const tz = 'Pacific/Auckland';
    const id = await integration(t.workspaceId, 'tiktok', '7001', { timezone: tz });
    const tt = tiktokFixture();
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const p = new URL(url).pathname.replace('/open_api/v1.3/', '');
      paths.push(p);
      const body = { 'report/integrated/get/': tt.report, 'campaign/get/': tt.campaigns, 'adgroup/get/': tt.adgroups, 'gmv_max/campaign/get/': tt.gmvMaxCampaigns, 'gmv_max/store/list/': tt.gmvMaxStores, 'gmv_max/report/get/': tt.gmvMaxReport }[p];
      return body ? json(body) : json({ code: 40006, message: `unexpected ${p}` });
    });
    expect(await syncIntegration(ctx, id)).toEqual({ ok: true });
    const rows = await ownerPool()`select ad_id, measurement_context, campaign_type, attribution_window, adapter_version, spend_micros from performance_observations order by measurement_context`;
    expect(rows).toEqual([
      { ad_id: '7400000000000001', measurement_context: 'TIKTOK_GMV_MAX_TOTAL', campaign_type: 'PRODUCT_GMV_MAX', attribution_window: 'gmv_max', adapter_version: 'tiktok-gmv-max@1', spend_micros: 25_000_000 },
      { ad_id: '1790000000000001', measurement_context: 'TIKTOK_PAID_ATTRIBUTED', campaign_type: 'WEB_CONVERSIONS', attribution_window: '7d_click_1d_view', adapter_version: 'tiktok-report@2', spend_micros: 10_000_000 },
    ]);
    expect(paths).toEqual(expect.arrayContaining(['report/integrated/get/', 'campaign/get/', 'adgroup/get/', 'gmv_max/store/list/', 'gmv_max/report/get/']));
    const [i] = await ownerPool()`select cursor, last_complete_date::text as complete from integrations where id = ${id}`;
    const today = dateInZone(new Date(), tz);
    expect(i!.cursor).toEqual({ lastDate: today, stores: ['7490000000000001'] });
    // Yesterday in the account's own timezone: today there is still filling in.
    expect(i!.complete).toBe(new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10));
  });

  it('a renamed report field degrades the connection and ingests nothing from that page (edge-47-07)', async () => {
    const { t, ctx } = await paid();
    const id = await integration(t.workspaceId, 'tiktok', '7001');
    vi.stubGlobal('fetch', async () => json({ code: 0, message: 'OK', data: { list: [{ dimensions: { ad_id: '1', stat_time_day: '2026-09-20 00:00:00' }, metrics: { cost: '10', impressions: '100' } }], page_info: { page: 1, total_page: 1 } } }));
    expect(await syncIntegration(ctx, id)).toEqual({ ok: false, error: 'schema_changed' });
    expect(await ownerPool()`select 1 from performance_observations`).toHaveLength(0);
    const [i] = await ownerPool()`select status, error from integrations where id = ${id}`;
    expect(i).toMatchObject({ status: 'degraded', error: { kind: 'schema_changed' } });
    expect((i!.error as { nextRetryAt?: string }).nextRetryAt).toBeUndefined(); // waits for an adapter fix, not a retry loop
  });
});

describe('platform-deleted creatives (§48, edge-48-14)', () => {
  it('marks a creative whose ads Meta reports deleted, and clears the mark if the ad is back', async () => {
    const { t, ctx } = await paid();
    const id = await integration(t.workspaceId, 'meta', 'act_1');
    const [sku] = await ownerPool()`insert into skus (workspace_id, catalogue_no, name, status) values (${t.workspaceId}, 1, 'Dew', 'active') returning id`;
    const [cr] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin, platform_refs) values (${t.workspaceId}, ${sku!.id}, 'imported', ${ownerPool().json({ meta_ad_ids: ['ad-9'] })}) returning id`;
    let status = 'DELETED';
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/insights')) {
        return json({ data: [{ account_id: '1', ad_id: 'ad-9', date_start: '2026-09-20', spend: '1', impressions: '10', clicks: '1' }] });
      }
      return json({ 'ad-9': { id: 'ad-9', effective_status: status } });
    });
    expect(await syncIntegration(ctx, id)).toEqual({ ok: true });
    expect((await ownerPool()`select source_deleted_at from creatives where id = ${cr!.id}`)[0]!.source_deleted_at).not.toBeNull();
    // Nothing is synthesised for the deleted ad: only the row the platform reported exists.
    expect(await ownerPool()`select 1 from performance_observations where ad_id = 'ad-9'`).toHaveLength(1);
    status = 'ACTIVE';
    await syncIntegration(ctx, id);
    expect((await ownerPool()`select source_deleted_at from creatives where id = ${cr!.id}`)[0]!.source_deleted_at).toBeNull();
  });
});

describe('sync failures, backoff and freshness (integ-27, arch-08, integ-16)', () => {
  it('a transient outage keeps the connection active and retries with backoff; repeated failures degrade it; recovery is announced', async () => {
    const { t, ctx } = await paid();
    const id = await integration(t.workspaceId, 'meta');
    const first = await markError(ctx, id, new ConnectorError('meta', 'network', 'Service temporarily unavailable'));
    expect(first.status).toBe('active');
    expect(first.nextRetryAt!.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(await ownerPool()`select 1 from outbox where queue = 'sync-integration' and singleton_key = ${`sync:${id}:retry`}`).toHaveLength(1);
    expect(await ownerPool()`select 1 from events where type = 'INTEGRATION_DEGRADED'`).toHaveLength(0);
    let last = first;
    for (let n = 2; n <= TRANSIENT_FAILURES_BEFORE_DEGRADED; n++) last = await markError(ctx, id, new ConnectorError('meta', 'network', 'still down'));
    expect(last.status).toBe('degraded');
    expect(await ownerPool()`select payload from events where type = 'DATA_FRESHNESS_CHANGED'`).toEqual([{ payload: { status: 'degraded', from: 'active' } }]);
    const [i] = await ownerPool()`select error from integrations where id = ${id}`;
    expect(i!.error).toMatchObject({ kind: 'network', failures: TRANSIENT_FAILURES_BEFORE_DEGRADED });
    // A successful sync resets it and says so.
    vi.stubGlobal('fetch', async () => json({ data: [] }));
    expect(await syncIntegration(ctx, id)).toEqual({ ok: true });
    expect((await ownerPool()`select status, error from integrations where id = ${id}`)[0]).toEqual({ status: 'active', error: null });
    expect((await ownerPool()`select payload from events where type = 'DATA_FRESHNESS_CHANGED' order by seq`).at(-1)!.payload).toEqual({ status: 'active', from: 'degraded' });
  });

  it('revoked access emails the owners once', async () => {
    const { t, ctx } = await paid();
    const id = await integration(t.workspaceId, 'meta');
    await markError(ctx, id, new ConnectorError('meta', 'auth_revoked', 'expired'));
    await markError(ctx, id, new ConnectorError('meta', 'auth_revoked', 'expired'));
    const mails = await ownerPool()`select payload from outbox where queue = 'send-email'`;
    expect(mails.map((m) => [m.payload.template, m.payload.provider])).toEqual([['integration_disconnected', 'Meta']]);
    expect(await ownerPool()`select 1 from outbox where queue = 'sync-integration'`).toHaveLength(0);
  });

  it('announces a connection stale once after FRESHNESS_DAYS', async () => {
    const { t } = await paid();
    const id = await integration(t.workspaceId, 'meta');
    await ownerPool()`update integrations set last_success_at = now() - interval '8 days' where id = ${id}`;
    expect(await sweepStaleIntegrations()).toBe(1);
    expect(await sweepStaleIntegrations()).toBe(0);
    expect(await ownerPool()`select payload from events where type = 'DATA_FRESHNESS_CHANGED'`).toEqual([{ payload: { status: 'stale', from: 'active', days: 7 } }]);
  });

  it('warns a week before a token expires, once, and revokes it at expiry', async () => {
    const { t } = await paid();
    const soon = await integration(t.workspaceId, 'meta', 'act_soon');
    const gone = await integration(t.workspaceId, 'meta', 'act_gone');
    const later = await integration(t.workspaceId, 'meta', 'act_later');
    await ownerPool()`update integrations set token_expires_at = case id when ${soon} then now() + interval '3 days' when ${gone} then now() - interval '1 hour' else now() + interval '40 days' end
                      where id in (${soon}, ${gone}, ${later})`;
    expect(await sweepExpiringTokens()).toEqual({ warned: 1, expired: 1 });
    expect(await sweepExpiringTokens()).toEqual({ warned: 0, expired: 0 });
    const rows = await ownerPool()`select external_account_id, status, token_enc is null as dropped from integrations order by external_account_id`;
    expect(rows).toEqual([
      { external_account_id: 'act_gone', status: 'revoked', dropped: true },
      { external_account_id: 'act_later', status: 'active', dropped: false },
      { external_account_id: 'act_soon', status: 'active', dropped: false },
    ]);
    const mails = await ownerPool()`select payload from outbox where queue = 'send-email' order by created_at`;
    expect(mails.map((m) => m.payload.template).sort()).toEqual(['integration_disconnected', 'integration_expiring']);
  });

  it('the account picker carries the granted permissions and token expiry to the connection', async () => {
    const { t, ctx } = await paid();
    const expiresAt = new Date(Date.now() + 60 * 86400_000);
    const pendingId = await withTenant(t.workspaceId, (tx) => stashPendingConnection(tx, ctx, 'meta', 'tok', [{ id: 'act_1', name: 'Glow', currency: 'USD', timezone: null }], 'fb-1', { scopes: ['public_profile'], expiresAt }));
    await withTenant(t.workspaceId, (tx) => connectSelectedAccounts(tx, ctx, pendingId, ['act_1']));
    const [i] = await ownerPool()`select scopes, token_expires_at from integrations`;
    expect(i!.scopes).toEqual(['public_profile']);
    expect(new Date(i!.token_expires_at as string).getTime()).toBe(expiresAt.getTime());
  });
});

describe('late-arriving revisions (integ-37, x-races-16)', () => {
  const row = (over: Partial<NormalizedObservation> = {}): NormalizedObservation => ({
    platform: 'meta', accountId: 'act_1', campaignId: 'c1', adgroupId: 'as1', adId: 'ad-1', adName: 'ad', date: '2026-09-10', currency: 'USD',
    spendMicros: 1_000_000, impressions: 1000, reach: 900, frequency: 1.11, clicks: 10, outboundClicks: 8, videoStarts: 500, video25: 300, video50: 200, video75: 100, video100: 50,
    avgWatchMs: 3000, addToCart: 2, checkout: 1, purchases: 1, purchaseValueMicros: 40_000_000, attributionModel: 'meta_default', attributionWindow: '7d_click_1d_view',
    optimizationEvent: null, campaignType: null, measurementContext: 'META_PAID_ATTRIBUTED', ...over,
  });

  it('a change to any reported value is a revision (add to cart, video starts), an identical re-pull is not', async () => {
    const { t, ctx } = await paid();
    const ingest = (o: NormalizedObservation) => withTenant(t.workspaceId, (tx) => ingestObservations(tx, ctx, null, [o]));
    expect(await ingest(row())).toEqual({ inserted: 1, revised: 0 });
    expect(await ingest(row())).toEqual({ inserted: 0, revised: 0 });
    expect(await ingest(row({ addToCart: 5 }))).toEqual({ inserted: 1, revised: 1 });
    expect(await ingest(row({ addToCart: 5, videoStarts: 520 }))).toEqual({ inserted: 1, revised: 1 });
    const live = await ownerPool()`select revision, add_to_cart, video_starts from performance_observations where superseded_at is null`;
    expect(live).toEqual([{ revision: 3, add_to_cart: 5, video_starts: 520 }]);
    expect(observationChanged({ ...live[0], frequency: '1.11' }, row({ frequency: 1.11 }))).toBe(true); // other columns differ
  });

  it('concurrent writers of the same key serialise: one current revision, no unique violation', async () => {
    const { t, ctx } = await paid();
    await Promise.all([1, 2, 3, 4].map((n) => withTenant(t.workspaceId, (tx) => ingestObservations(tx, ctx, null, [row({ purchases: n })]))));
    expect(await ownerPool()`select 1 from performance_observations where superseded_at is null`).toHaveLength(1);
    expect((await ownerPool()`select count(*)::int as n from performance_observations`)[0]!.n).toBe(4);
  });
});

describe('Ads Manager CSV import (integ-41)', () => {
  it('reads quoted names with commas, the currency from the spend header and locale numbers', () => {
    const csv = [
      'Reporting starts,Ad name,Ad ID,Amount spent (EUR),Impressions,Link clicks,Purchases,Purchases conversion value,Attribution setting',
      '2026-09-20,"Dew, texture close-up AK-014-B",123,"1,234.50","12,000",150,4,"152.00",7-day click or 1-day view',
    ].join('\n');
    const [r] = parsePerformanceCsv(csv, 'meta');
    expect(r).toMatchObject({ adName: 'Dew, texture close-up AK-014-B', adId: '123', currency: 'EUR', spendMicros: 1_234_500_000, impressions: 12000, clicks: 150, purchases: 4, purchaseValueMicros: 152_000_000, attributionWindow: '7d_click_1d_view' });
    // A semicolon-delimited European export with decimal commas.
    const eu = parsePerformanceCsv('Reporting starts;Ad name;Amount spent (EUR);Impressions;Link clicks;Purchases\n2026-09-20;Dew;1.234,50;12.000;150;4', 'meta');
    expect(eu[0]).toMatchObject({ spendMicros: 1_234_500_000, impressions: 12000, currency: 'EUR' });
  });

  it('never reads Results as purchases, and refuses unreadable numbers', () => {
    expect(() => parsePerformanceCsv('Reporting starts,Ad name,Amount spent (USD),Impressions,Link clicks,Results\n2026-09-20,x,10,100,5,3', 'meta')).toThrow(/Purchases column/);
    expect(() => parsePerformanceCsv('Reporting starts,Ad name,Amount spent (USD),Impressions,Link clicks,Purchases\n2026-09-20,x,ten,100,5,3', 'meta')).toThrow(/“ten”/);
    expect(parsePerformanceCsv('Reporting starts,Ad name,Amount spent (USD),Impressions,Link clicks\n2026-09-20,x,10,100,5', 'meta')[0]!.purchases).toBe(0);
    expect(parsePerformanceCsv('By Day,Ad name,Cost,Impressions,Clicks (destination),Complete payment\n2026-09-20,x,10,100,5,2', 'tiktok', { currency: 'GBP' })[0]).toMatchObject({ currency: 'GBP', purchases: 2 });
    expect([parseLocaleNumber('$1,234'), parseLocaleNumber('1 234,5'), parseLocaleNumber('12%'), parseLocaleNumber('--'), parseLocaleNumber('1,23,4')]).toEqual([1234, 1234.5, 12, 0, NaN]);
  });
});

describe('Shopify store transfer (plan 02 §3 layer 8, integ-04)', () => {
  async function twoWorkspaces() {
    const owner = await paid();
    const other = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID', email: 'jordan@brand.example' });
    const otherCtx = ctxFor(other.workspaceId, other.userId, 'OWNER', 'ACTIVE_PAID');
    await withTenant(owner.t.workspaceId, (tx) => saveIntegration(tx, owner.ctx, { provider: 'shopify', externalAccountId: 'glow.myshopify.com', token: 'tok', scopes: ['read_products'] }));
    return { owner, other, otherCtx };
  }

  it('a second workspace is told whose store it is (masked) and can request a transfer the owner approves', async () => {
    const { owner, other, otherCtx } = await twoWorkspaces();
    const err = await withTenant(other.workspaceId, (tx) => saveIntegration(tx, otherCtx, { provider: 'shopify', externalAccountId: 'glow.myshopify.com', token: 't2', scopes: ['read_products'] })).catch((e: unknown) => e as { code: string; message: string; details: Record<string, unknown> });
    expect(err).toMatchObject({ code: 'CONFLICT', details: { transfer: true, shop: 'glow.myshopify.com', ownerHint: expect.stringMatching(/^u•••@example\.com$/) } });
    expect(await ownerPool()`select 1 from integrations where workspace_id = ${other.workspaceId}`).toHaveLength(0);

    const proof = shopTransferProof({ shop: 'glow.myshopify.com', workspaceId: other.workspaceId, userId: other.userId, scopes: ['read_products'] });
    // The proof is bound to the workspace and user that did the OAuth.
    await expect(withTenant(owner.t.workspaceId, (tx) => requestShopTransfer(tx, owner.ctx, proof, 'x@y.z'))).rejects.toThrow(/expired/);
    const requestId = await withTenant(other.workspaceId, (tx) => requestShopTransfer(tx, otherCtx, proof, other.email));
    expect(await withTenant(other.workspaceId, (tx) => requestShopTransfer(tx, otherCtx, proof, other.email))).toBe(requestId); // one pending per shop
    // The owner's workspace is emailed (its own outbox), and sees the request with the requester masked.
    expect((await ownerPool()`select workspace_id, payload from outbox where queue = 'send-email'`).map((m) => [m.workspace_id, m.payload.template])).toEqual([[owner.t.workspaceId, 'shop_transfer_request']]);
    const seen = await withTenant(owner.t.workspaceId, (tx) => listShopTransfers(tx, owner.t.workspaceId));
    expect(seen).toEqual([expect.objectContaining({ id: requestId, direction: 'incoming', requester: 'j•••@brand.example', status: 'pending' })]);
    expect((await withTenant(other.workspaceId, (tx) => listShopTransfers(tx, other.workspaceId)))[0]).toMatchObject({ direction: 'outgoing', requester: 'jordan@brand.example' });
    // The requester can't decide its own request (RLS: only the owning workspace updates it).
    expect(await withTenant(other.workspaceId, (tx) => tx`update shop_transfer_requests set status = 'approved' where id = ${requestId} returning id`)).toHaveLength(0);
    // A third workspace sees nothing of it.
    const third = await makeTenant();
    expect(await withTenant(third.workspaceId, (tx) => tx`select 1 from shop_transfer_requests`)).toHaveLength(0);

    // Only the owner decides; approval releases the store and the requester can connect it.
    await expect(withTenant(owner.t.workspaceId, (tx) => decideShopTransfer(tx, { ...owner.ctx, role: 'ADMIN' }, requestId, 'approve'))).rejects.toThrow(/owner/);
    await withTenant(owner.t.workspaceId, (tx) => decideShopTransfer(tx, owner.ctx, requestId, 'approve'));
    expect((await ownerPool()`select status from integrations where workspace_id = ${owner.t.workspaceId}`)[0]!.status).toBe('disconnected');
    await withTenant(other.workspaceId, (tx) => saveIntegration(tx, otherCtx, { provider: 'shopify', externalAccountId: 'glow.myshopify.com', token: 't2', scopes: ['read_products'] }));
    expect((await ownerPool()`select workspace_id from shopify_shops`)[0]!.workspace_id).toBe(other.workspaceId);
  });

  it('staff approve only after 14 days, with the OAuth proof, audited by the console action', async () => {
    const { owner, other, otherCtx } = await twoWorkspaces();
    const proof = shopTransferProof({ shop: 'glow.myshopify.com', workspaceId: other.workspaceId, userId: other.userId, scopes: [] });
    const requestId = await withTenant(other.workspaceId, (tx) => requestShopTransfer(tx, otherCtx, proof, other.email));
    const staff = { staffId: '00000000-0000-0000-0000-00000000000a', email: 'ops@arkiv.example', name: 'Ops', roles: ['ops'] } as never;
    await expect(withAdmin((tx) => staffApproveShopTransfer(tx, staff, requestId, 'owner unreachable'))).rejects.toThrow(/14 days/);
    await ownerPool()`update shop_transfer_requests set created_at = now() - interval '15 days' where id = ${requestId}`;
    const r = await withAdmin((tx) => staffApproveShopTransfer(tx, staff, requestId, 'owner unreachable'));
    expect(r).toEqual({ shop: 'glow.myshopify.com', fromWorkspaceId: owner.t.workspaceId, toWorkspaceId: other.workspaceId });
    expect(await ownerPool()`select 1 from shopify_shops`).toHaveLength(0);
    expect((await ownerPool()`select payload, actor from events where type = 'INTEGRATION_DISCONNECTED' and workspace_id = ${owner.t.workspaceId}`)[0]).toMatchObject({ payload: { reason: 'shop_transfer_staff' }, actor: expect.stringMatching(/^staff:/) });
  });
});
