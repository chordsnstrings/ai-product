import { env, type MeasurementContext } from '@arkiv/shared';
import { hmacB64, hmacHex, safeEqual } from './crypto';

/**
 * Read-only platform connectors (§27–30). V1 requests minimum scopes and never writes budgets, bids or
 * campaigns. Each adapter is versioned and normalizes into our canonical PerformanceObservation (§30).
 */

export class ConnectorError extends Error {
  constructor(
    public readonly provider: 'shopify' | 'meta' | 'tiktok',
    public readonly kind: 'auth_revoked' | 'rate_limited' | 'partial_scopes' | 'schema_changed' | 'network' | 'invalid',
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(`[${provider}] ${message}`);
  }
}

export interface NormalizedObservation {
  platform: 'meta' | 'tiktok';
  accountId: string;
  campaignId: string | null;
  adgroupId: string | null;
  adId: string;
  adName: string | null;
  date: string;
  currency: string;
  spendMicros: number;
  impressions: number;
  reach: number | null;
  frequency: number | null;
  clicks: number;
  outboundClicks: number | null;
  videoStarts: number | null;
  video25: number | null;
  video50: number | null;
  video75: number | null;
  video100: number | null;
  avgWatchMs: number | null;
  addToCart: number | null;
  checkout: number | null;
  purchases: number;
  purchaseValueMicros: number;
  attributionModel: string | null;
  attributionWindow: string;
  optimizationEvent: string | null;
  campaignType: string | null;
  measurementContext: MeasurementContext;
}

const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));
const numOrNull = (v: unknown) => (v == null || v === '' ? null : Number(v));
const micros = (v: unknown) => Math.round(num(v) * 1_000_000);

// ───────────── Shopify (§28) ─────────────
export const SHOPIFY_SCOPES = ['read_products'];

export function shopifyInstallUrl(shop: string, state: string): string {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) throw new ConnectorError('shopify', 'invalid', 'Enter your .myshopify.com domain');
  const q = new URLSearchParams({ client_id: env().SHOPIFY_API_KEY ?? 'dev', scope: SHOPIFY_SCOPES.join(','), redirect_uri: `${env().APP_URL}/api/integrations/shopify/callback`, state });
  return `https://${shop}/admin/oauth/authorize?${q}`;
}

/** Verify the OAuth callback query HMAC (hex, sorted params without `hmac`). */
export function verifyShopifyQuery(query: Record<string, string>): boolean {
  const { hmac, signature: _s, ...rest } = query;
  if (!hmac) return false;
  const msg = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('&');
  return safeEqual(hmacHex(env().SHOPIFY_API_SECRET ?? 'dev', msg), hmac);
}

/** Verify a webhook (base64 HMAC over the raw body). */
export function verifyShopifyWebhook(rawBody: string | Buffer, header: string | null): boolean {
  if (!header) return false;
  return safeEqual(hmacB64(env().SHOPIFY_API_SECRET ?? 'dev', rawBody), header);
}

export async function shopifyExchangeCode(shop: string, code: string): Promise<{ accessToken: string; scopes: string[] }> {
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env().SHOPIFY_API_KEY, client_secret: env().SHOPIFY_API_SECRET, code }),
  });
  if (!r.ok) throw new ConnectorError('shopify', 'auth_revoked', `token exchange failed (${r.status})`);
  const j = (await r.json()) as { access_token: string; scope: string };
  return { accessToken: j.access_token, scopes: j.scope.split(',') };
}

export interface ShopifyProduct {
  id: string;
  title: string;
  descriptionText: string;
  status: string;
  vendor: string | null;
  images: string[];
  variants: { id: string; title: string; price: number; compareAtPrice: number | null; sku: string | null; barcode: string | null }[];
  updatedAt: string;
}

const PRODUCTS_QUERY = `query Products($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id title description status vendor updatedAt
      media(first: 6) { nodes { ... on MediaImage { image { url } } } }
      variants(first: 20) { nodes { id title price compareAtPrice sku barcode } } }
  }
}`;

export async function shopifyFetchProducts(shop: string, token: string, cursor: string | null): Promise<{ products: ShopifyProduct[]; next: string | null }> {
  const r = await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
  });
  if (r.status === 401 || r.status === 403) throw new ConnectorError('shopify', 'auth_revoked', 'access revoked');
  if (r.status === 429) throw new ConnectorError('shopify', 'rate_limited', 'throttled', Number(r.headers.get('retry-after') ?? 2));
  const j = (await r.json()) as { data?: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Record<string, unknown>[] } }; errors?: unknown };
  if (!j.data) throw new ConnectorError('shopify', 'schema_changed', `unexpected response: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return { products: j.data.products.nodes.map(normalizeShopifyProduct), next: j.data.products.pageInfo.hasNextPage ? j.data.products.pageInfo.endCursor : null };
}

export function normalizeShopifyProduct(n: Record<string, unknown>): ShopifyProduct {
  const media = ((n.media as { nodes: { image?: { url: string } }[] })?.nodes ?? []).map((m) => m.image?.url).filter(Boolean) as string[];
  const variants = ((n.variants as { nodes: Record<string, unknown>[] })?.nodes ?? []).map((v) => ({
    id: String(v.id),
    title: String(v.title),
    price: num(v.price),
    compareAtPrice: numOrNull(v.compareAtPrice),
    sku: (v.sku as string) || null,
    barcode: (v.barcode as string) || null,
  }));
  return { id: String(n.id), title: String(n.title), descriptionText: String(n.description ?? ''), status: String(n.status), vendor: (n.vendor as string) ?? null, images: media, variants, updatedAt: String(n.updatedAt) };
}

// ───────────── Meta Marketing API (§29) ─────────────
export const META_SCOPES = ['ads_read'];
export const META_API = 'https://graph.facebook.com/v23.0';

export function metaAuthUrl(state: string) {
  const q = new URLSearchParams({ client_id: env().META_APP_ID ?? 'dev', redirect_uri: `${env().APP_URL}/api/integrations/meta/callback`, state, scope: META_SCOPES.join(','), response_type: 'code' });
  return `https://www.facebook.com/v23.0/dialog/oauth?${q}`;
}

export const META_INSIGHT_FIELDS = [
  'account_id', 'account_currency', 'campaign_id', 'adset_id', 'ad_id', 'ad_name', 'date_start', 'spend', 'impressions', 'reach',
  'frequency', 'clicks', 'outbound_clicks', 'video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p100_watched_actions', 'video_avg_time_watched_actions', 'actions', 'action_values', 'optimization_goal', 'objective',
];

type MetaAction = { action_type: string; value: string };
const actionVal = (arr: unknown, type: string) => num(((arr as MetaAction[]) ?? []).find((a) => a.action_type === type)?.value);

/** Normalize one Meta insights row (ad-level, daily, stated attribution window). We compute CTR/CVR ourselves. */
export function normalizeMetaInsight(r: Record<string, unknown>, attributionWindow = '7d_click_1d_view'): NormalizedObservation {
  return {
    platform: 'meta',
    accountId: String(r.account_id),
    campaignId: (r.campaign_id as string) ?? null,
    adgroupId: (r.adset_id as string) ?? null,
    adId: String(r.ad_id),
    adName: (r.ad_name as string) ?? null,
    date: String(r.date_start),
    currency: String(r.account_currency ?? 'USD'),
    spendMicros: micros(r.spend),
    impressions: num(r.impressions),
    reach: numOrNull(r.reach),
    frequency: numOrNull(r.frequency),
    clicks: num(r.clicks),
    outboundClicks: actionVal(r.outbound_clicks, 'outbound_click') || null,
    videoStarts: actionVal(r.video_play_actions, 'video_view') || null,
    video25: actionVal(r.video_p25_watched_actions, 'video_view') || null,
    video50: actionVal(r.video_p50_watched_actions, 'video_view') || null,
    video75: actionVal(r.video_p75_watched_actions, 'video_view') || null,
    video100: actionVal(r.video_p100_watched_actions, 'video_view') || null,
    avgWatchMs: actionVal(r.video_avg_time_watched_actions, 'video_view') * 1000 || null,
    addToCart: actionVal(r.actions, 'offsite_conversion.fb_pixel_add_to_cart') || null,
    checkout: actionVal(r.actions, 'offsite_conversion.fb_pixel_initiate_checkout') || null,
    purchases: actionVal(r.actions, 'offsite_conversion.fb_pixel_purchase') || actionVal(r.actions, 'purchase'),
    purchaseValueMicros: micros(actionVal(r.action_values, 'offsite_conversion.fb_pixel_purchase') || actionVal(r.action_values, 'purchase')),
    attributionModel: 'meta_default',
    attributionWindow,
    optimizationEvent: (r.optimization_goal as string) ?? null,
    campaignType: (r.objective as string) ?? null,
    measurementContext: 'META_PAID_ATTRIBUTED',
  };
}

export async function metaFetchInsights(token: string, accountId: string, since: string, until: string, after: string | null) {
  const q = new URLSearchParams({
    access_token: token,
    level: 'ad',
    time_increment: '1',
    fields: META_INSIGHT_FIELDS.join(','),
    time_range: JSON.stringify({ since, until }),
    action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
    limit: '200',
  });
  if (after) q.set('after', after);
  const r = await fetch(`${META_API}/act_${accountId.replace(/^act_/, '')}/insights?${q}`);
  const j = (await r.json()) as { data?: Record<string, unknown>[]; paging?: { cursors?: { after?: string }; next?: string }; error?: { code: number; message: string } };
  if (j.error) {
    if (j.error.code === 190) throw new ConnectorError('meta', 'auth_revoked', j.error.message);
    if ([4, 17, 32, 613].includes(j.error.code)) throw new ConnectorError('meta', 'rate_limited', j.error.message, 60);
    if (j.error.code === 200 || j.error.code === 10) throw new ConnectorError('meta', 'partial_scopes', j.error.message);
    throw new ConnectorError('meta', 'invalid', j.error.message);
  }
  return { rows: (j.data ?? []).map((r) => normalizeMetaInsight(r)), next: j.paging?.next ? (j.paging.cursors?.after ?? null) : null };
}

// ───────────── TikTok API for Business (§30) ─────────────
export const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';

export function tiktokAuthUrl(state: string) {
  const q = new URLSearchParams({ app_id: env().TIKTOK_APP_ID ?? 'dev', state, redirect_uri: `${env().APP_URL}/api/integrations/tiktok/callback` });
  return `https://business-api.tiktok.com/portal/auth?${q}`;
}

/**
 * GMV Max results include organic + affiliate traffic and are NOT comparable with paid-only attribution (§30):
 * they get their own measurement_context.
 */
export function normalizeTikTokRow(r: { dimensions: Record<string, string>; metrics: Record<string, string> }, advertiserId: string, currency: string, campaignType: string | null): NormalizedObservation {
  const m = r.metrics;
  const gmvMax = campaignType === 'GMV_MAX' || campaignType === 'PRODUCT_GMV_MAX';
  return {
    platform: 'tiktok',
    accountId: advertiserId,
    campaignId: m.campaign_id ?? null,
    adgroupId: m.adgroup_id ?? null,
    adId: r.dimensions.ad_id!,
    adName: m.ad_name ?? null,
    date: (r.dimensions.stat_time_day ?? '').slice(0, 10),
    currency,
    spendMicros: micros(m.spend),
    impressions: num(m.impressions),
    reach: numOrNull(m.reach),
    frequency: numOrNull(m.frequency),
    clicks: num(m.clicks),
    outboundClicks: null,
    videoStarts: numOrNull(m.video_play_actions),
    video25: numOrNull(m.video_views_p25),
    video50: numOrNull(m.video_views_p50),
    video75: numOrNull(m.video_views_p75),
    video100: numOrNull(m.video_views_p100),
    avgWatchMs: m.average_video_play ? num(m.average_video_play) * 1000 : null,
    addToCart: numOrNull(m.onsite_add_to_cart ?? m.add_to_cart),
    checkout: numOrNull(m.onsite_initiate_checkout_count ?? m.initiate_checkout),
    purchases: num(m.complete_payment ?? m.onsite_shopping),
    purchaseValueMicros: micros(m.total_complete_payment_rate ?? m.gross_revenue ?? m.onsite_shopping_value),
    attributionModel: gmvMax ? 'gmv_max_total' : 'tiktok_default',
    attributionWindow: gmvMax ? 'gmv_max' : '7d_click_1d_view',
    optimizationEvent: m.optimization_event ?? null,
    campaignType,
    measurementContext: gmvMax ? 'TIKTOK_GMV_MAX_TOTAL' : 'TIKTOK_PAID_ATTRIBUTED',
  };
}

export async function tiktokFetchReport(token: string, advertiserId: string, start: string, end: string, page: number) {
  const q = new URLSearchParams({
    advertiser_id: advertiserId,
    report_type: 'BASIC',
    data_level: 'AUCTION_AD',
    dimensions: JSON.stringify(['ad_id', 'stat_time_day']),
    metrics: JSON.stringify(['spend', 'impressions', 'reach', 'frequency', 'clicks', 'video_play_actions', 'video_views_p25', 'video_views_p50', 'video_views_p75', 'video_views_p100', 'average_video_play', 'complete_payment', 'total_complete_payment_rate', 'campaign_id', 'adgroup_id', 'ad_name']),
    start_date: start,
    end_date: end,
    page: String(page),
    page_size: '200',
  });
  const r = await fetch(`${TIKTOK_API}/report/integrated/get/?${q}`, { headers: { 'Access-Token': token } });
  const j = (await r.json()) as { code: number; message: string; data?: { list: { dimensions: Record<string, string>; metrics: Record<string, string> }[]; page_info: { page: number; total_page: number } } };
  if (j.code === 40001 || j.code === 40105) throw new ConnectorError('tiktok', 'auth_revoked', j.message);
  if (j.code === 40100 || j.code === 50002) throw new ConnectorError('tiktok', 'rate_limited', j.message, 60);
  if (j.code !== 0) throw new ConnectorError('tiktok', 'invalid', j.message);
  return { list: j.data?.list ?? [], hasMore: (j.data?.page_info.page ?? 1) < (j.data?.page_info.total_page ?? 1) };
}

// ───────────── OAuth code exchange (Meta, TikTok) ─────────────

export interface AdAccount {
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
}

/** Meta: code → short-lived → long-lived (~60 day) user token, plus the ad accounts it can read. */
export async function metaExchangeCode(code: string): Promise<{ accessToken: string; accounts: AdAccount[] }> {
  const e = env();
  const q = new URLSearchParams({ client_id: e.META_APP_ID ?? '', client_secret: e.META_APP_SECRET ?? '', redirect_uri: `${e.APP_URL}/api/integrations/meta/callback`, code });
  const r1 = await fetch(`${META_API}/oauth/access_token?${q}`);
  const j1 = (await r1.json()) as { access_token?: string; error?: { message: string } };
  if (!j1.access_token) throw new ConnectorError('meta', 'auth_revoked', j1.error?.message ?? 'token exchange failed');
  const q2 = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: e.META_APP_ID ?? '', client_secret: e.META_APP_SECRET ?? '', fb_exchange_token: j1.access_token });
  const j2 = (await (await fetch(`${META_API}/oauth/access_token?${q2}`)).json()) as { access_token?: string };
  const token = j2.access_token ?? j1.access_token;
  const acc = (await (await fetch(`${META_API}/me/adaccounts?${new URLSearchParams({ fields: 'account_id,name,currency,timezone_name', limit: '50', access_token: token })}`)).json()) as {
    data?: { account_id: string; name: string; currency?: string; timezone_name?: string }[];
  };
  return { accessToken: token, accounts: (acc.data ?? []).map((a) => ({ id: `act_${a.account_id}`, name: a.name, currency: a.currency ?? null, timezone: a.timezone_name ?? null })) };
}

/** TikTok Business: auth_code → long-lived access token + authorised advertiser ids. */
export async function tiktokExchangeCode(authCode: string): Promise<{ accessToken: string; accounts: AdAccount[] }> {
  const e = env();
  const r = await fetch(`${TIKTOK_API}/oauth2/access_token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: e.TIKTOK_APP_ID, secret: e.TIKTOK_APP_SECRET, auth_code: authCode }),
  });
  const j = (await r.json()) as { code: number; message: string; data?: { access_token: string; advertiser_ids: string[] } };
  if (j.code !== 0 || !j.data) throw new ConnectorError('tiktok', 'auth_revoked', j.message);
  return { accessToken: j.data.access_token, accounts: j.data.advertiser_ids.map((id) => ({ id, name: `Advertiser ${id}`, currency: null, timezone: null })) };
}
