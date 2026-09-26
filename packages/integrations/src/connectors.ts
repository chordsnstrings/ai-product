import { env, type MeasurementContext } from '@arkiv/shared';
import { createHmac } from 'node:crypto';
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
  /**
   * Publisher platform × position (e.g. `instagram:reels`), or 'all' when the source has no placement breakdown.
   * Placements are stored separately and only aggregated under a compatible context (§45).
   */
  placement?: string;
  /** IANA timezone the source reports daily dates in (§47); defaults to the connection's timezone. */
  sourceTimezone?: string | null;
  /** The row adapter that produced this observation (ADAPTER_VERSIONS; §47 "adapter versioning"). */
  adapterVersion?: string;
}

// ───────────── Connector policies (plan 05 §16, standard §31) ─────────────

/** Platform API versions this build calls. Staff track their deprecation/sunset dates (setting integrations.api_versions). */
export const API_VERSIONS = { shopify: '2026-07', meta: 'v23.0', tiktok: 'v1.3' } as const;
export type ConnectorProvider = keyof typeof API_VERSIONS;

export interface ConnectorPolicy {
  label: string;
  /**
   * Freshness policy (standard §31): a connection whose last successful sync is older than this is stale. Ad
   * platforms sync daily, so two days means a missed sync; the Shopify catalogue changes slowly and is also pushed
   * by webhooks.
   */
  freshnessHours: number;
  /** Scopes we ask for at authorization (read-only, minimum; §27). Empty when the platform sets them per app. */
  requestedScopes: readonly string[];
}

/** Scopes requested but not granted (a partial-scope connection, §47). */
export function missingScopes(provider: ConnectorProvider, granted: readonly string[] | null | undefined): string[] {
  const have = new Set((granted ?? []).map((g) => g.trim()));
  return CONNECTOR_POLICY[provider].requestedScopes.filter((s) => !have.has(s));
}

const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));
const numOrNull = (v: unknown) => (v == null || v === '' ? null : Number(v));
const micros = (v: unknown) => Math.round(num(v) * 1_000_000);

// ───────────── Adapter versions and response contracts (§47 "API schema change") ─────────────

/**
 * Versions of our own row adapters (the mapping from a platform's raw row to NormalizedObservation). Every
 * observation is stamped with the adapter that produced it, so a mapping change can be traced and re-derived.
 */
export const ADAPTER_VERSIONS = { meta: 'meta-insights@2', tiktok: 'tiktok-report@2', tiktokGmvMax: 'tiktok-gmv-max@1', shopify: 'shopify-products@2' } as const;

const isNumeric = (v: unknown) => typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));

/**
 * The fields a raw row must carry for the adapter to read it. A renamed or missing field would otherwise be read
 * as zero and feed the statistics: the page is refused instead (schema_changed → the connection is degraded and
 * nothing from that page is ingested).
 */
export function assertRowContract(provider: 'meta' | 'tiktok' | 'shopify', row: unknown, fields: { ids?: string[]; numbers?: string[] }, where = 'row'): void {
  const r = (row ?? {}) as Record<string, unknown>;
  const bad: string[] = [];
  for (const f of fields.ids ?? []) if (r[f] == null || String(r[f]).trim() === '') bad.push(f);
  for (const f of fields.numbers ?? []) if (!isNumeric(r[f])) bad.push(f);
  if (bad.length) throw new ConnectorError(provider, 'schema_changed', `${where} is missing or has a non-numeric ${bad.join(', ')} — adapter ${ADAPTER_VERSIONS[provider === 'shopify' ? 'shopify' : provider]} needs updating`);
}

/**
 * Error class of an HTTP answer that isn't a platform error payload: a 5xx (or an unreadable body) is a
 * transient outage the sync retries with backoff; 401/403 is revoked access; 429 is a rate limit.
 */
export function httpErrorKind(status: number): ConnectorError['kind'] | null {
  if (status === 401 || status === 403) return 'auth_revoked';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'network';
  if (status >= 400) return 'invalid';
  return null;
}

/** fetch that turns a dropped connection into a retryable 'network' ConnectorError. */
async function platformFetch(provider: 'meta' | 'tiktok' | 'shopify', url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new ConnectorError(provider, 'network', `request failed: ${(e as Error).message}`.slice(0, 300));
  }
}

/** JSON body, or a 'network' error for a gateway page / truncated body (a 5xx answered with HTML). */
async function platformJson<T>(provider: 'meta' | 'tiktok' | 'shopify', r: Response): Promise<T> {
  try {
    return (await r.json()) as T;
  } catch {
    const kind = httpErrorKind(r.status);
    throw new ConnectorError(provider, kind && kind !== 'invalid' ? kind : 'network', `unreadable response (HTTP ${r.status})`, kind === 'rate_limited' ? 60 : undefined);
  }
}

// ───────────── Shopify (§28) ─────────────
export const SHOPIFY_SCOPES = ['read_products'];

/**
 * A demo store for PROVIDERS_MODE=mock (plan 03 P2 "Connect Shopify" in dev, tests and demos): its install
 * completes at once with a signed callback, and it lists a few fixture skincare products. Any other shop is real.
 */
export const SHOPIFY_DEMO_SHOP = 'arkiv-demo.myshopify.com';
export const isShopifyDemo = (shop: string) => env().PROVIDERS_MODE === 'mock' && shop === SHOPIFY_DEMO_SHOP;

const DEMO_PRODUCTS: ShopifyProduct[] = [
  ['1001', 'Dew Drop Hydrating Serum', 'Serum', 'A lightweight serum with hyaluronic acid and panthenol that absorbs quickly and leaves skin feeling soft.', 34, 'dew-drop-serum'],
  ['1002', 'Cloud Cream Moisturiser', 'Moisturizer', 'A whipped moisturiser with ceramides and squalane for a comfortable, non-greasy finish.', 42, 'cloud-cream'],
  ['1003', 'Gentle Milk Cleanser', 'Cleanser', 'A creamy cleanser with glycerin that rinses clean without a tight feeling.', 24, 'milk-cleanser'],
].map(([id, title, productType, description, price, handle]) => ({
  id: `gid://shopify/Product/${id}`,
  title: title as string,
  handle: handle as string,
  productType: productType as string,
  onlineStoreUrl: `https://${SHOPIFY_DEMO_SHOP}/products/${handle}`,
  descriptionText: description as string,
  status: 'ACTIVE',
  vendor: 'Arkiv Demo',
  images: [],
  options: [],
  metafields: [],
  variants: [{ id: `gid://shopify/ProductVariant/${id}1`, title: 'Default Title', price: price as number, compareAtPrice: null, sku: `DEMO-${id}`, barcode: null, options: {}, available: true, imageUrl: null }],
  updatedAt: '2026-09-01T00:00:00Z',
}));

export function shopifyInstallUrl(shop: string, state: string): string {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) throw new ConnectorError('shopify', 'invalid', 'Enter your .myshopify.com domain');
  if (isShopifyDemo(shop)) {
    // The demo store "approves" at once: a callback signed exactly as Shopify signs one.
    const q: Record<string, string> = { code: 'demo', shop, state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&');
    return `${env().APP_URL}/api/integrations/shopify/callback?${new URLSearchParams({ ...q, hmac: hmacHex(env().SHOPIFY_API_SECRET ?? 'dev', msg) })}`;
  }
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

// ───────────── Platform deauthorization callbacks (§38 /webhooks/meta, /webhooks/tiktok; §40 revocation) ─────────────

/**
 * Meta deauthorize / data-deletion callbacks post a `signed_request`: base64url(HMAC-SHA256(payload, app secret))
 * "." base64url(JSON payload). Returns the app-scoped user id, or null when the signature doesn't verify.
 */
export function parseMetaSignedRequest(signed: string | null | undefined): { userId: string; issuedAt: number | null } | null {
  const secret = env().META_APP_SECRET;
  if (!secret || !signed) return null;
  const [sig, body] = signed.split('.');
  if (!sig || !body) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(expected, sig.replace(/=+$/, ''))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { algorithm?: string; user_id?: string | number; issued_at?: number };
    if (String(p.algorithm ?? '').toUpperCase() !== 'HMAC-SHA256' || p.user_id == null) return null;
    return { userId: String(p.user_id), issuedAt: p.issued_at ?? null };
  } catch {
    return null;
  }
}

/** TikTok webhooks: `TikTok-Signature: t=<unix>,s=<hex HMAC-SHA256 of "t.body">` with the app secret, within 5 minutes. */
export function verifyTiktokWebhook(rawBody: string, header: string | null, now = Date.now()): boolean {
  const secret = env().TIKTOK_APP_SECRET;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!parts.s || !Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;
  return safeEqual(hmacHex(secret, `${parts.t}.${rawBody}`), parts.s);
}

export async function shopifyExchangeCode(shop: string, code: string): Promise<{ accessToken: string; scopes: string[] }> {
  if (isShopifyDemo(shop)) return { accessToken: 'demo-shop-token', scopes: SHOPIFY_SCOPES };
  const r = await platformFetch('shopify', `https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env().SHOPIFY_API_KEY, client_secret: env().SHOPIFY_API_SECRET, code }),
  });
  if (!r.ok) throw new ConnectorError('shopify', 'auth_revoked', `token exchange failed (${r.status})`);
  const j = (await r.json()) as { access_token: string; scope: string };
  return { accessToken: j.access_token, scopes: j.scope.split(',') };
}

/**
 * Canonical Shopify ids are Admin GraphQL global ids (`gid://shopify/Product/99`). The storefront's
 * `/products/<handle>.json` and REST webhooks carry the bare number (`99`): both forms name the same product, so
 * every id is stored in the gid form (§42 "Duplicate import: detect source/product match").
 */
export function shopifyGid(kind: 'Product' | 'ProductVariant', id: string | number): string {
  const s = String(id).trim();
  if (/^gid:\/\//.test(s)) return s;
  return /^\d+$/.test(s) ? `gid://shopify/${kind}/${s}` : s;
}

/** The numeric part of a Shopify id in either form (`gid://shopify/Product/99` → `99`). */
export function shopifyNumericId(id: string | number): string {
  const m = /(\d+)$/.exec(String(id).trim());
  return m ? m[1]! : String(id);
}

// ───────────── Shopify webhook registrations (plan 05 §16 "verified nightly") ─────────────
// App-specific topics we register per shop through the Admin API. The mandatory privacy topics
// (customers/data_request, customers/redact, shop/redact) are configured on the app itself, not per shop.
export const SHOPIFY_WEBHOOK_TOPICS = ['app/uninstalled', 'products/create', 'products/update', 'products/delete'] as const;

export interface ShopifyWebhook {
  id: string;
  topic: string;
  address: string;
}

export interface ShopifyWebhookClient {
  list(shop: string, token: string): Promise<ShopifyWebhook[]>;
  create(shop: string, token: string, topic: string, address: string): Promise<ShopifyWebhook>;
}

async function shopifyRest<T>(shop: string, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await platformFetch('shopify', `https://${shop}/admin/api/${API_VERSIONS.shopify}/${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (r.status === 401 || r.status === 403) throw new ConnectorError('shopify', 'auth_revoked', 'access revoked');
  if (r.status === 429) throw new ConnectorError('shopify', 'rate_limited', 'throttled', Number(r.headers.get('retry-after') ?? 2));
  if (!r.ok) throw new ConnectorError('shopify', httpErrorKind(r.status) ?? 'invalid', `webhooks API ${r.status}`);
  return (await r.json()) as T;
}

export const liveShopifyWebhooks: ShopifyWebhookClient = {
  async list(shop, token) {
    const j = await shopifyRest<{ webhooks?: { id: number | string; topic: string; address: string }[] }>(shop, token, 'webhooks.json?limit=250');
    return (j.webhooks ?? []).map((w) => ({ id: String(w.id), topic: w.topic, address: w.address }));
  },
  async create(shop, token, topic, address) {
    const j = await shopifyRest<{ webhook: { id: number | string; topic: string; address: string } }>(shop, token, 'webhooks.json', { method: 'POST', body: { webhook: { topic, address, format: 'json' } } });
    return { id: String(j.webhook.id), topic: j.webhook.topic, address: j.webhook.address };
  },
};

/** In-memory registrations for local/mock mode and tests (per process). */
export function mockShopifyWebhooks(seed: Record<string, ShopifyWebhook[]> = {}): ShopifyWebhookClient & { registrations: Map<string, ShopifyWebhook[]> } {
  const registrations = new Map(Object.entries(seed));
  let n = 0;
  return {
    registrations,
    async list(shop) {
      return [...(registrations.get(shop) ?? [])];
    },
    async create(shop, _token, topic, address) {
      const w = { id: `mock-${++n}`, topic, address };
      registrations.set(shop, [...(registrations.get(shop) ?? []), w]);
      return w;
    },
  };
}

let webhookClient: ShopifyWebhookClient | null = null;
/** The live client, or the in-memory mock in PROVIDERS_MODE=mock (tests can inject their own). */
export function shopifyWebhookClient(): ShopifyWebhookClient {
  if (!webhookClient) webhookClient = env().PROVIDERS_MODE === 'mock' ? mockShopifyWebhooks() : liveShopifyWebhooks;
  return webhookClient;
}
export function setShopifyWebhookClient(c: ShopifyWebhookClient | null) {
  webhookClient = c;
}

/** Required topics not registered to our address. */
export function missingShopifyWebhooks(existing: ShopifyWebhook[], address: string): string[] {
  const ok = new Set(existing.filter((w) => w.address === address).map((w) => w.topic));
  return SHOPIFY_WEBHOOK_TOPICS.filter((t) => !ok.has(t));
}

export interface ShopifyProduct {
  /** Canonical gid (`gid://shopify/Product/N`). */
  id: string;
  title: string;
  handle?: string | null;
  productType?: string | null;
  /** The product's public page, when published to the Online Store. */
  onlineStoreUrl?: string | null;
  descriptionText: string;
  status: string;
  vendor: string | null;
  images: string[];
  /** Option names with their values (Size: 30 ml, 50 ml), without the "Title" placeholder. */
  options?: { name: string; values: string[] }[];
  /** Product metafields as the store defines them. */
  metafields?: { namespace: string; key: string; type: string | null; value: string }[];
  /** The store's own tags. */
  tags?: string[];
  /** A selling plan (subscription) is offered or required for the product; null when the store didn't say. */
  subscriptionAvailable?: boolean | null;
  variants: {
    id: string;
    title: string;
    price: number;
    compareAtPrice: number | null;
    sku: string | null;
    barcode: string | null;
    /** Option name → value (Size, Shade…), without Shopify's "Title: Default Title" placeholder. */
    options: Record<string, string>;
    available: boolean | null;
    imageUrl: string | null;
  }[];
  updatedAt: string;
}

const PRODUCT_FIELDS = `id title handle productType onlineStoreUrl description status vendor updatedAt tags
      requiresSellingPlan sellingPlanGroupsCount { count }
      options { name values }
      metafields(first: 20) { nodes { namespace key type value } }
      media(first: 6) { nodes { ... on MediaImage { image { url } } } }
      variants(first: 20) { nodes { id title price compareAtPrice sku barcode availableForSale selectedOptions { name value } image { url } } }`;

export const SHOPIFY_PRODUCTS_QUERY = `query Products($cursor: String) {
  shop { currencyCode ianaTimezone }
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ${PRODUCT_FIELDS} }
  }
}`;

export const SHOPIFY_PRODUCT_QUERY = `query Product($id: ID!) {
  shop { currencyCode ianaTimezone }
  product(id: $id) { ${PRODUCT_FIELDS} }
}`;

async function shopifyGraphql<T>(shop: string, token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await platformFetch('shopify', `https://${shop}/admin/api/${API_VERSIONS.shopify}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 401 || r.status === 403) throw new ConnectorError('shopify', 'auth_revoked', 'access revoked');
  if (r.status === 429) throw new ConnectorError('shopify', 'rate_limited', 'throttled', Number(r.headers.get('retry-after') ?? 2));
  if (r.status >= 500) throw new ConnectorError('shopify', 'network', `Admin API ${r.status}`);
  const j = await platformJson<{ data?: T; errors?: { message?: string; extensions?: { code?: string } }[] }>('shopify', r);
  if (j.errors?.some((e) => e.extensions?.code === 'THROTTLED')) throw new ConnectorError('shopify', 'rate_limited', 'throttled', 2);
  if (!j.data) throw new ConnectorError('shopify', 'schema_changed', `unexpected response: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return j.data;
}

type ShopInfo = { shop?: { currencyCode?: string; ianaTimezone?: string } };

export async function shopifyFetchProducts(shop: string, token: string, cursor: string | null): Promise<{ products: ShopifyProduct[]; next: string | null; currency: string | null; timezone: string | null }> {
  if (isShopifyDemo(shop)) return { products: DEMO_PRODUCTS, next: null, currency: 'USD', timezone: 'America/New_York' };
  const d = await shopifyGraphql<ShopInfo & { products?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Record<string, unknown>[] } }>(shop, token, SHOPIFY_PRODUCTS_QUERY, { cursor });
  if (!d.products || !Array.isArray(d.products.nodes)) throw new ConnectorError('shopify', 'schema_changed', 'products connection missing from the response');
  return {
    products: d.products.nodes.map(normalizeShopifyProduct),
    next: d.products.pageInfo?.hasNextPage ? d.products.pageInfo.endCursor : null,
    currency: d.shop?.currencyCode ?? null,
    timezone: d.shop?.ianaTimezone ?? null,
  };
}

/** One product by id (either form), for a products/create|update webhook; null when it no longer exists. */
export async function shopifyFetchProduct(shop: string, token: string, id: string): Promise<{ product: ShopifyProduct | null; currency: string | null }> {
  if (isShopifyDemo(shop)) return { product: DEMO_PRODUCTS.find((p) => p.id === shopifyGid('Product', id)) ?? null, currency: 'USD' };
  const d = await shopifyGraphql<ShopInfo & { product?: Record<string, unknown> | null }>(shop, token, SHOPIFY_PRODUCT_QUERY, { id: shopifyGid('Product', id) });
  return { product: d.product ? normalizeShopifyProduct(d.product) : null, currency: d.shop?.currencyCode ?? null };
}

export function normalizeShopifyProduct(n: Record<string, unknown>): ShopifyProduct {
  assertRowContract('shopify', n, { ids: ['id', 'title', 'status'] }, 'product');
  const media = ((n.media as { nodes: { image?: { url: string } }[] })?.nodes ?? []).map((m) => m.image?.url).filter(Boolean) as string[];
  const variants = ((n.variants as { nodes: Record<string, unknown>[] })?.nodes ?? []).map((v) => ({
    id: shopifyGid('ProductVariant', String(v.id)),
    title: String(v.title),
    price: num(v.price),
    compareAtPrice: numOrNull(v.compareAtPrice),
    sku: (v.sku as string) || null,
    barcode: (v.barcode as string) || null,
    options: Object.fromEntries(
      ((v.selectedOptions as { name: string; value: string }[] | undefined) ?? []).filter((o) => !(o.name === 'Title' && o.value === 'Default Title')).map((o) => [o.name, o.value]),
    ),
    available: typeof v.availableForSale === 'boolean' ? v.availableForSale : null,
    imageUrl: ((v.image as { url?: string } | null)?.url as string) ?? null,
  }));
  const options = ((n.options as { name: string; values?: string[] }[] | undefined) ?? [])
    .filter((o) => o.name && !(o.name === 'Title' && (o.values ?? []).every((v) => v === 'Default Title')))
    .map((o) => ({ name: o.name, values: o.values ?? [] }));
  const metafields = ((n.metafields as { nodes?: Record<string, unknown>[] } | undefined)?.nodes ?? [])
    .filter((m) => m && m.key && m.value != null)
    .map((m) => ({ namespace: String(m.namespace ?? ''), key: String(m.key), type: (m.type as string) ?? null, value: String(m.value) }));
  return {
    id: shopifyGid('Product', String(n.id)),
    title: String(n.title),
    handle: (n.handle as string) || null,
    productType: (n.productType as string) || null,
    onlineStoreUrl: (n.onlineStoreUrl as string) || null,
    descriptionText: String(n.description ?? ''),
    status: String(n.status),
    vendor: (n.vendor as string) || null,
    images: media,
    options,
    metafields,
    tags: Array.isArray(n.tags) ? (n.tags as unknown[]).map(String).filter(Boolean).slice(0, 40) : [],
    subscriptionAvailable:
      n.requiresSellingPlan === true || Number((n.sellingPlanGroupsCount as { count?: unknown } | null)?.count ?? 0) > 0
        ? true
        : typeof n.requiresSellingPlan === 'boolean' || n.sellingPlanGroupsCount != null
          ? false
          : null,
    variants,
    updatedAt: String(n.updatedAt ?? ''),
  };
}

/** Readable text of a metafield value (rich text, lists and measurements are JSON). */
function metafieldText(v: string): string {
  try {
    const j = JSON.parse(v) as unknown;
    if (typeof j === 'string' || typeof j === 'number') return String(j);
    if (Array.isArray(j)) return j.map((x) => (x && typeof x === 'object' ? String((x as { value?: unknown }).value ?? '') : String(x))).filter(Boolean).join(', ');
    if (j && typeof j === 'object' && 'value' in j) {
      const unit = String((j as { unit?: unknown }).unit ?? '').toLowerCase();
      const short = ({ milliliters: 'ml', millilitres: 'ml', grams: 'g', fluid_ounces: 'fl oz', ounces: 'oz', liters: 'l', kilograms: 'kg' } as Record<string, string>)[unit] ?? unit;
      return `${String((j as { value: unknown }).value)}${short ? ` ${short}` : ''}`;
    }
    // Rich text: every text node, in order.
    const texts: string[] = [];
    const walk = (x: unknown) => {
      if (!x || typeof x !== 'object') return;
      const o = x as { value?: unknown; children?: unknown[] };
      if (typeof o.value === 'string') texts.push(o.value);
      for (const c of o.children ?? []) walk(c);
    };
    walk(j);
    return texts.join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Metafields that carry product truth (§28 "available relevant metafields"), matched by key whatever the
 * namespace: ingredients (INCI), size/volume and shade. The first match per key wins.
 */
export function shopifyMetafieldFacts(metafields: NonNullable<ShopifyProduct['metafields']>): { key: 'ingredients' | 'size' | 'shade'; value: string; source: string }[] {
  const out: { key: 'ingredients' | 'size' | 'shade'; value: string; source: string }[] = [];
  for (const m of metafields) {
    const k = m.key.toLowerCase();
    const key = /ingredient|inci/.test(k) ? 'ingredients' : /^(size|volume|net_?(content|contents|volume|weight)|weight|capacity)$/.test(k) ? 'size' : /shade|colou?r_?name/.test(k) ? 'shade' : null;
    if (!key || out.some((o) => o.key === key)) continue;
    const value = metafieldText(m.value).slice(0, 2000);
    if (value) out.push({ key, value, source: `${m.namespace}.${m.key}` });
  }
  return out;
}

// ───────────── Meta Marketing API (§29) ─────────────
export const META_SCOPES = ['ads_read'];
export const META_API = `https://graph.facebook.com/${API_VERSIONS.meta}`;

/**
 * Meta login dialog. `scopes` asks for only the named permissions again (a partial-scope connection re-asks for
 * what is missing, never for unrelated permissions, §47); `auth_type=rerequest` re-prompts a declined one.
 */
export function metaAuthUrl(state: string, scopes: readonly string[] = META_SCOPES) {
  const q = new URLSearchParams({ client_id: env().META_APP_ID ?? 'dev', redirect_uri: `${env().APP_URL}/api/integrations/meta/callback`, state, scope: scopes.join(','), response_type: 'code' });
  if (scopes !== META_SCOPES) q.set('auth_type', 'rerequest');
  return `https://www.facebook.com/${API_VERSIONS.meta}/dialog/oauth?${q}`;
}

export const META_INSIGHT_FIELDS = [
  'account_id', 'account_currency', 'campaign_id', 'adset_id', 'ad_id', 'ad_name', 'date_start', 'spend', 'impressions', 'reach',
  'frequency', 'clicks', 'outbound_clicks', 'video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p100_watched_actions', 'video_avg_time_watched_actions', 'actions', 'action_values', 'optimization_goal', 'objective',
];
/** Placement breakdown (§45 "store placement/campaign observations separately"). */
export const META_BREAKDOWNS = ['publisher_platform', 'platform_position'];
/** The attribution windows the insights request asks for; stored as the observation's window (§45). */
export const META_ATTRIBUTION_WINDOWS = ['7d_click', '1d_view'] as const;

/** `publisher_platform:platform_position`, lower-cased; 'all' when the row has no breakdown. */
export function metaPlacement(r: Record<string, unknown>): string {
  const pub = typeof r.publisher_platform === 'string' ? r.publisher_platform.trim().toLowerCase() : '';
  const pos = typeof r.platform_position === 'string' ? r.platform_position.trim().toLowerCase() : '';
  return pub ? (pos ? `${pub}:${pos}` : pub) : 'all';
}

type MetaAction = { action_type: string; value: string };
const actionVal = (arr: unknown, type: string) => num(((arr as MetaAction[]) ?? []).find((a) => a.action_type === type)?.value);

/** Normalize one Meta insights row (ad-level, daily, stated attribution window). We compute CTR/CVR ourselves. */
export function normalizeMetaInsight(r: Record<string, unknown>, attributionWindow = META_ATTRIBUTION_WINDOWS.map((w) => w).join('_')): NormalizedObservation {
  // Required raw fields (§47 "fail safely"): a renamed one must not be read as zero.
  assertRowContract('meta', r, { ids: ['ad_id', 'date_start'], numbers: ['spend', 'impressions'] }, 'insights row');
  if (r.clicks != null && !isNumeric(r.clicks)) assertRowContract('meta', r, { numbers: ['clicks'] }, 'insights row');
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
    placement: metaPlacement(r),
    adapterVersion: ADAPTER_VERSIONS.meta,
  };
}

type MetaError = { code: number; error_subcode?: number; is_transient?: boolean; message: string };

/**
 * Meta Graph error → our class. Codes 1 and 2 (and anything Meta flags is_transient) are temporary service
 * errors that are retried with backoff (§47); 4/17/32/613/80004 are throttles; 190 is an expired or revoked
 * token; 10 and 200–299 are missing permissions. Other request errors are 'invalid'.
 */
export function metaErrorKind(e: MetaError, httpStatus = 400): ConnectorError['kind'] {
  if (e.code === 190 || e.code === 102) return 'auth_revoked';
  if ([4, 17, 32, 613, 80000, 80004].includes(e.code)) return 'rate_limited';
  if (e.code === 10 || (e.code >= 200 && e.code < 300)) return 'partial_scopes';
  if (e.is_transient || e.code === 1 || e.code === 2 || httpStatus >= 500) return 'network';
  return 'invalid';
}

async function metaGet<T>(url: string): Promise<T> {
  const r = await platformFetch('meta', url);
  const j = await platformJson<T & { error?: MetaError }>('meta', r);
  if (j.error) {
    const kind = metaErrorKind(j.error, r.status);
    throw new ConnectorError('meta', kind, j.error.message, kind === 'rate_limited' ? 60 : undefined);
  }
  if (!r.ok) throw new ConnectorError('meta', httpErrorKind(r.status) ?? 'invalid', `Graph API ${r.status}`, r.status === 429 ? 60 : undefined);
  return j;
}

export async function metaFetchInsights(token: string, accountId: string, since: string, until: string, after: string | null) {
  const q = new URLSearchParams({
    access_token: token,
    level: 'ad',
    time_increment: '1',
    fields: META_INSIGHT_FIELDS.join(','),
    time_range: JSON.stringify({ since, until }),
    action_attribution_windows: JSON.stringify(META_ATTRIBUTION_WINDOWS),
    breakdowns: META_BREAKDOWNS.join(','),
    limit: '200',
  });
  if (after) q.set('after', after);
  const j = await metaGet<{ data?: Record<string, unknown>[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${META_API}/act_${accountId.replace(/^act_/, '')}/insights?${q}`);
  if (j.data != null && !Array.isArray(j.data)) throw new ConnectorError('meta', 'schema_changed', 'insights response has no data array');
  return { rows: (j.data ?? []).map((r) => normalizeMetaInsight(r)), next: j.paging?.next ? (j.paging.cursors?.after ?? null) : null };
}

/** Ads Meta reports as gone (§48 "historical creative deleted from ad platform"). */
const META_GONE = new Set(['DELETED', 'ARCHIVED']);

/** An ad's status, and what creative it currently runs (§48: an edit made outside Arkiv changes this). */
export interface AdStatus {
  status: string;
  deleted: boolean;
  /** The platform's creative (and video) the ad now serves; null when the platform didn't say. */
  creativeRef?: string | null;
}

/**
 * Effective status of each ad id (`ACTIVE`, `PAUSED`, `DELETED`, `ARCHIVED`, …) and the creative it serves. An id
 * Meta says does not exist (error 100) is reported as DELETED; an id it didn't answer for is left out (unknown).
 */
export async function metaFetchAdStatuses(token: string, adIds: string[]): Promise<Map<string, AdStatus>> {
  const out = new Map<string, AdStatus>();
  const one = async (ids: string[]) => {
    const q = new URLSearchParams({ ids: ids.join(','), fields: 'id,effective_status,creative{id,video_id}', access_token: token });
    const j = await metaGet<Record<string, { id?: string; effective_status?: string; creative?: { id?: string; video_id?: string } }>>(`${META_API}/?${q}`);
    for (const id of ids) {
      const s = j[id]?.effective_status;
      const c = j[id]?.creative;
      if (s) out.set(id, { status: s, deleted: META_GONE.has(s), creativeRef: c?.id ? `${c.id}${c.video_id ? `:${c.video_id}` : ''}` : null });
    }
  };
  for (let i = 0; i < adIds.length; i += 50) {
    const chunk = adIds.slice(i, i + 50);
    try {
      await one(chunk);
    } catch (e) {
      // One missing id fails the whole batch ("does not exist"): ask for each id on its own.
      if (!(e instanceof ConnectorError) || e.kind !== 'invalid') throw e;
      for (const id of chunk) {
        try {
          await one([id]);
        } catch (e2) {
          if (e2 instanceof ConnectorError && e2.kind === 'invalid' && /does not exist|nonexisting|unsupported get request/i.test(e2.message)) out.set(id, { status: 'DELETED', deleted: true });
          else if (!(e2 instanceof ConnectorError) || e2.kind !== 'invalid') throw e2;
        }
      }
    }
  }
  return out;
}

// ───────────── TikTok API for Business (§30) ─────────────
export const TIKTOK_API = `https://business-api.tiktok.com/open_api/${API_VERSIONS.tiktok}`;

export function tiktokAuthUrl(state: string) {
  const q = new URLSearchParams({ app_id: env().TIKTOK_APP_ID ?? 'dev', state, redirect_uri: `${env().APP_URL}/api/integrations/tiktok/callback` });
  return `https://business-api.tiktok.com/portal/auth?${q}`;
}

/** Campaign types whose results include organic and affiliate traffic (Product/LIVE GMV Max, §30). */
export const isGmvMaxCampaignType = (t: string | null | undefined) => !!t && /GMV_MAX/i.test(t);

/**
 * GMV Max results include organic + affiliate traffic and are NOT comparable with paid-only attribution (§30):
 * they get their own measurement_context.
 */
export function normalizeTikTokRow(r: { dimensions: Record<string, string>; metrics: Record<string, string> }, advertiserId: string, currency: string, campaignType: string | null): NormalizedObservation {
  assertRowContract('tiktok', r.dimensions, { ids: ['ad_id', 'stat_time_day'] }, 'report row dimensions');
  assertRowContract('tiktok', r.metrics, { numbers: ['spend', 'impressions'] }, 'report row metrics');
  const m = r.metrics;
  const gmvMax = isGmvMaxCampaignType(campaignType);
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
    adapterVersion: ADAPTER_VERSIONS.tiktok,
  };
}

type TikTokEnvelope<T> = { code: number; message: string; request_id?: string; data?: T };

/**
 * TikTok answers HTTP 200 with a `code`: 40001/40105/40102 are revoked or expired access, 40100 and 50002 are
 * throttles, 40002/40007 missing permissions, other 5xxxx codes are service errors retried with backoff.
 */
export function tiktokErrorKind(code: number): ConnectorError['kind'] {
  if (code === 40001 || code === 40105 || code === 40102) return 'auth_revoked';
  if (code === 40100 || code === 50002) return 'rate_limited';
  if (code === 40002 || code === 40007) return 'partial_scopes';
  if (code >= 50000) return 'network';
  return 'invalid';
}

async function tiktokGet<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const r = await platformFetch('tiktok', `${TIKTOK_API}/${path}?${new URLSearchParams(params)}`, { headers: { 'Access-Token': token } });
  if (r.status >= 500 || r.status === 429) throw new ConnectorError('tiktok', httpErrorKind(r.status)!, `HTTP ${r.status}`, r.status === 429 ? 60 : undefined);
  const j = await platformJson<TikTokEnvelope<T>>('tiktok', r);
  if (typeof j.code !== 'number') throw new ConnectorError('tiktok', 'schema_changed', 'response has no code');
  if (j.code !== 0) {
    const kind = tiktokErrorKind(j.code);
    throw new ConnectorError('tiktok', kind, `${j.code}: ${j.message}`, kind === 'rate_limited' ? 60 : undefined);
  }
  return (j.data ?? {}) as T;
}

type TikTokReportRow = { dimensions: Record<string, string>; metrics: Record<string, string> };
type TikTokPage = { list?: TikTokReportRow[]; page_info?: { page: number; total_page: number } };

export async function tiktokFetchReport(token: string, advertiserId: string, start: string, end: string, page: number) {
  const d = await tiktokGet<TikTokPage>(token, 'report/integrated/get/', {
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
  if (d.list != null && !Array.isArray(d.list)) throw new ConnectorError('tiktok', 'schema_changed', 'report list is not an array');
  return { list: d.list ?? [], hasMore: (d.page_info?.page ?? 1) < (d.page_info?.total_page ?? 1) };
}

/**
 * Campaign type per campaign id (§30: GMV Max results must be recognised to keep their own context). Regular
 * campaigns come from /campaign/get/ (objective_type, campaign_type); Product and LIVE GMV Max campaigns are listed
 * by /gmv_max/campaign/get/ and win. Read once per sync.
 */
export async function tiktokFetchCampaignTypes(token: string, advertiserId: string, campaignIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(campaignIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const d = await tiktokGet<{ list?: { campaign_id: string | number; objective_type?: string; campaign_type?: string; campaign_product_source?: string }[] }>(token, 'campaign/get/', {
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ campaign_ids: ids.slice(i, i + 100) }),
      fields: JSON.stringify(['campaign_id', 'campaign_name', 'objective_type', 'campaign_type']),
      page_size: '100',
    });
    for (const c of d.list ?? []) {
      const type = [c.campaign_type, c.objective_type].find((t) => isGmvMaxCampaignType(t)) ?? c.objective_type ?? c.campaign_type ?? null;
      out.set(String(c.campaign_id), type);
    }
  }
  for (const [id, type] of await tiktokFetchGmvMaxCampaigns(token, advertiserId).catch((e) => (e instanceof ConnectorError && (e.kind === 'invalid' || e.kind === 'partial_scopes') ? new Map<string, string>() : Promise.reject(e)))) {
    out.set(id, type);
  }
  return out;
}

const TIKTOK_WINDOW_DAYS: Record<string, number> = { ONE_DAY: 1, SEVEN_DAYS: 7, FOURTEEN_DAYS: 14, TWENTY_EIGHT_DAYS: 28 };

/** An ad group's attribution setting as our window key ("7d_click_1d_view"; "7d_click" with view-through off). */
export function tiktokAttributionWindow(click: string | null | undefined, view: string | null | undefined): string | null {
  const c = click ? TIKTOK_WINDOW_DAYS[click] : undefined;
  const v = view ? TIKTOK_WINDOW_DAYS[view] : undefined;
  if (!c && !v) return null;
  return [c ? `${c}d_click` : null, v ? `${v}d_view` : null].filter(Boolean).join('_');
}

/**
 * The attribution window each ad group reports under (§45 "Attribution windows differ: preserve raw window"), so
 * results are never compared across windows. Ad groups without a stated setting are left out (the report's
 * default window applies).
 */
export async function tiktokFetchAdgroupWindows(token: string, advertiserId: string, adgroupIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < adgroupIds.length; i += 100) {
    const d = await tiktokGet<{ list?: { adgroup_id: string | number; click_attribution_window?: string; view_attribution_window?: string }[] }>(token, 'adgroup/get/', {
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ adgroup_ids: adgroupIds.slice(i, i + 100) }),
      fields: JSON.stringify(['adgroup_id', 'click_attribution_window', 'view_attribution_window']),
      page_size: '100',
    });
    for (const g of d.list ?? []) {
      const w = tiktokAttributionWindow(g.click_attribution_window, g.view_attribution_window);
      if (w) out.set(String(g.adgroup_id), w);
    }
  }
  return out;
}

/** GMV Max campaigns of an advertiser (campaign id → PRODUCT_GMV_MAX | LIVE_GMV_MAX). */
export async function tiktokFetchGmvMaxCampaigns(token: string, advertiserId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const d = await tiktokGet<{ list?: { campaign_id: string | number; gmv_max_promotion_type?: string; promotion_type?: string }[]; page_info?: { page: number; total_page: number } }>(token, 'gmv_max/campaign/get/', {
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ gmv_max_promotion_types: ['PRODUCT_GMV_MAX', 'LIVE_GMV_MAX'] }),
      page: String(page),
      page_size: '100',
    });
    for (const c of d.list ?? []) out.set(String(c.campaign_id), c.gmv_max_promotion_type ?? c.promotion_type ?? 'PRODUCT_GMV_MAX');
    if ((d.page_info?.page ?? 1) >= (d.page_info?.total_page ?? 1)) break;
  }
  return out;
}

/** TikTok Shop store ids the advertiser can run GMV Max for (the GMV Max report is per store). */
export async function tiktokFetchGmvMaxStores(token: string, advertiserId: string): Promise<string[]> {
  const d = await tiktokGet<{ store_list?: { store_id: string | number; is_gmv_max_available?: boolean }[]; list?: { store_id: string | number }[] }>(token, 'gmv_max/store/list/', { advertiser_id: advertiserId });
  return [...new Set((d.store_list ?? d.list ?? []).map((s) => String(s.store_id)).filter(Boolean))];
}

/**
 * Daily GMV Max results per campaign and creative (item) for the given stores. Each row keeps the GMV Max total
 * context (organic + affiliate + paid, §30); a campaign-level row without an item is keyed by its campaign.
 */
export async function tiktokFetchGmvMaxReport(token: string, advertiserId: string, storeIds: string[], start: string, end: string, page: number) {
  const d = await tiktokGet<TikTokPage>(token, 'gmv_max/report/get/', {
    advertiser_id: advertiserId,
    store_ids: JSON.stringify(storeIds),
    start_date: start,
    end_date: end,
    dimensions: JSON.stringify(['campaign_id', 'item_id', 'stat_time_day']),
    metrics: JSON.stringify(['cost', 'orders', 'gross_revenue', 'product_impressions', 'product_clicks']),
    page: String(page),
    page_size: '200',
  });
  if (d.list != null && !Array.isArray(d.list)) throw new ConnectorError('tiktok', 'schema_changed', 'GMV Max report list is not an array');
  return { list: d.list ?? [], hasMore: (d.page_info?.page ?? 1) < (d.page_info?.total_page ?? 1) };
}

/** One GMV Max report row as an observation in TIKTOK_GMV_MAX_TOTAL. */
export function normalizeTikTokGmvMaxRow(r: TikTokReportRow, advertiserId: string, currency: string, campaignType = 'PRODUCT_GMV_MAX'): NormalizedObservation {
  assertRowContract('tiktok', r.dimensions, { ids: ['campaign_id', 'stat_time_day'] }, 'GMV Max row dimensions');
  assertRowContract('tiktok', r.metrics, { numbers: ['cost'] }, 'GMV Max row metrics');
  const d = r.dimensions;
  const m = r.metrics;
  const o = normalizeTikTokRow(
    {
      dimensions: { ad_id: d.item_id || `gmvmax:${d.campaign_id}`, stat_time_day: d.stat_time_day! },
      metrics: {
        campaign_id: d.campaign_id!,
        spend: m.cost!,
        impressions: m.product_impressions ?? '0',
        clicks: m.product_clicks ?? '0',
        complete_payment: m.orders ?? '0',
        gross_revenue: m.gross_revenue ?? '0',
      },
    },
    advertiserId,
    currency,
    isGmvMaxCampaignType(campaignType) ? campaignType : 'PRODUCT_GMV_MAX',
  );
  return { ...o, adapterVersion: ADAPTER_VERSIONS.tiktokGmvMax };
}

/** Ad statuses (§48): an ad TikTok reports deleted is marked; one it doesn't return stays unknown. */
export async function tiktokFetchAdStatuses(token: string, advertiserId: string, adIds: string[]): Promise<Map<string, AdStatus>> {
  const out = new Map<string, AdStatus>();
  for (let i = 0; i < adIds.length; i += 100) {
    const d = await tiktokGet<{ list?: { ad_id: string | number; operation_status?: string; secondary_status?: string; video_id?: string | null }[] }>(token, 'ad/get/', {
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ ad_ids: adIds.slice(i, i + 100), primary_status: 'STATUS_ALL' }),
      fields: JSON.stringify(['ad_id', 'operation_status', 'secondary_status', 'video_id']),
      page_size: '100',
    });
    for (const a of d.list ?? []) {
      const status = a.secondary_status ?? a.operation_status ?? 'UNKNOWN';
      out.set(String(a.ad_id), { status, deleted: /DELETE/i.test(status), creativeRef: a.video_id ? String(a.video_id) : null });
    }
  }
  return out;
}

// ───────────── OAuth code exchange (Meta, TikTok) ─────────────

export interface AdAccount {
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
}

export interface ExchangeResult {
  accessToken: string;
  accounts: AdAccount[];
  platformUserId: string | null;
  /** Permissions the login actually granted (§27 "granted scopes"). */
  scopes: string[];
  /** When the token stops working (Meta long-lived user tokens: ~60 days); null when it doesn't expire. */
  expiresAt: Date | null;
}

/** Meta: code → short-lived → long-lived (~60 day) user token, plus the ad accounts it can read. */
export async function metaExchangeCode(code: string, now = Date.now()): Promise<ExchangeResult> {
  const e = env();
  const q = new URLSearchParams({ client_id: e.META_APP_ID ?? '', client_secret: e.META_APP_SECRET ?? '', redirect_uri: `${e.APP_URL}/api/integrations/meta/callback`, code });
  const r1 = await platformFetch('meta', `${META_API}/oauth/access_token?${q}`);
  const j1 = (await platformJson<{ access_token?: string; expires_in?: number; error?: { message: string } }>('meta', r1));
  if (!j1.access_token) throw new ConnectorError('meta', 'auth_revoked', j1.error?.message ?? 'token exchange failed');
  const q2 = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: e.META_APP_ID ?? '', client_secret: e.META_APP_SECRET ?? '', fb_exchange_token: j1.access_token });
  const j2 = (await (await platformFetch('meta', `${META_API}/oauth/access_token?${q2}`)).json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  const token = j2.access_token ?? j1.access_token;
  const expiresIn = j2.access_token ? j2.expires_in : j1.expires_in;
  const acc = (await (await platformFetch('meta', `${META_API}/me/adaccounts?${new URLSearchParams({ fields: 'account_id,name,currency,timezone_name', limit: '50', access_token: token })}`)).json()) as {
    data?: { account_id: string; name: string; currency?: string; timezone_name?: string }[];
  };
  // The app-scoped user id: Meta's deauthorize and data-deletion callbacks name the user, not the ad account.
  const me = (await (await platformFetch('meta', `${META_API}/me?${new URLSearchParams({ fields: 'id', access_token: token })}`)).json().catch(() => ({}))) as { id?: string };
  const scopes = await metaGrantedPermissions(token).catch(() => null);
  return {
    accessToken: token,
    platformUserId: me.id ?? null,
    // Unknown (the permissions call failed) is recorded as what we asked for; a later partial_scopes error corrects it.
    scopes: scopes ?? [...META_SCOPES],
    expiresAt: expiresIn && Number(expiresIn) > 0 ? new Date(now + Number(expiresIn) * 1000) : null,
    accounts: (acc.data ?? []).map((a) => ({ id: `act_${a.account_id}`, name: a.name, currency: a.currency ?? null, timezone: a.timezone_name ?? null })),
  };
}

/** Permissions the user granted this app (declined ones are left out). */
export async function metaGrantedPermissions(token: string): Promise<string[]> {
  const j = await metaGet<{ data?: { permission: string; status: string }[] }>(`${META_API}/me/permissions?${new URLSearchParams({ access_token: token })}`);
  return (j.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission);
}

/** TikTok Business: auth_code → long-lived access token + authorised advertiser ids. */
export async function tiktokExchangeCode(authCode: string): Promise<ExchangeResult> {
  const e = env();
  const r = await platformFetch('tiktok', `${TIKTOK_API}/oauth2/access_token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: e.TIKTOK_APP_ID, secret: e.TIKTOK_APP_SECRET, auth_code: authCode }),
  });
  const j = (await platformJson<{ code: number; message: string; data?: { access_token: string; advertiser_ids: string[]; scope?: (number | string)[] } }>('tiktok', r));
  if (j.code !== 0 || !j.data) throw new ConnectorError('tiktok', 'auth_revoked', j.message);
  const info = await tiktokAdvertiserInfo(j.data.access_token, j.data.advertiser_ids).catch(() => new Map<string, Partial<AdAccount>>());
  return {
    accessToken: j.data.access_token,
    platformUserId: null,
    // TikTok names granted permissions by numeric scope id.
    scopes: (j.data.scope ?? []).map(String),
    // TikTok Business access tokens don't expire; they end when the advertiser revokes them.
    expiresAt: null,
    accounts: j.data.advertiser_ids.map((id) => ({ id, name: info.get(id)?.name ?? `Advertiser ${id}`, currency: info.get(id)?.currency ?? null, timezone: info.get(id)?.timezone ?? null })),
  };
}

/**
 * Advertiser name, currency and reporting timezone (§47 "store native currency", "retain source timezone"). Reports
 * are in the advertiser's currency and timezone, so both are kept with the connection.
 */
export async function tiktokAdvertiserInfo(token: string, advertiserIds: string[]): Promise<Map<string, Partial<AdAccount>>> {
  const out = new Map<string, Partial<AdAccount>>();
  for (let i = 0; i < advertiserIds.length; i += 100) {
    const q = new URLSearchParams({ advertiser_ids: JSON.stringify(advertiserIds.slice(i, i + 100)), fields: JSON.stringify(['advertiser_id', 'name', 'currency', 'timezone', 'display_timezone']) });
    const r = await platformFetch('tiktok', `${TIKTOK_API}/advertiser/info/?${q}`, { headers: { 'Access-Token': token } });
    const j = (await r.json()) as { code: number; data?: { list?: { advertiser_id: string; name?: string; currency?: string; timezone?: string; display_timezone?: string }[] } };
    if (j.code !== 0) continue;
    for (const a of j.data?.list ?? []) {
      out.set(String(a.advertiser_id), { name: a.name || undefined, currency: a.currency || null, timezone: a.display_timezone || a.timezone || null });
    }
  }
  return out;
}

// ───────────── Permissions → features (§47 "Partial scopes") ─────────────

/**
 * What each permission we ask for makes possible. A connection missing one shows exactly these features as
 * unavailable, and re-asks for that permission only.
 */
export const PERMISSION_FEATURES: Record<ConnectorProvider, Record<string, string[]>> = {
  shopify: { read_products: ['Product, price and variant import', 'Stock-out detection', 'Live product updates from your store'] },
  meta: { ads_read: ['Ad results (spend, clicks, purchases) for your tests', 'Video watch metrics', 'Spotting ads deleted in Ads Manager'] },
  tiktok: {},
};

/** Features unavailable on a connection, by the permission each one needs. */
export function unavailableFeatures(provider: ConnectorProvider, granted: readonly string[] | null | undefined): { scope: string; features: string[] }[] {
  return missingScopes(provider, granted).map((scope) => ({ scope, features: PERMISSION_FEATURES[provider][scope] ?? [] }));
}

/** Per-connector policy (the scope lists are defined with each connector above). */
export const CONNECTOR_POLICY: Record<ConnectorProvider, ConnectorPolicy> = {
  shopify: { label: 'Shopify', freshnessHours: 7 * 24, requestedScopes: SHOPIFY_SCOPES },
  meta: { label: 'Meta', freshnessHours: 48, requestedScopes: META_SCOPES },
  // TikTok permissions are granted per app in the TikTok developer portal, not requested per authorization.
  tiktok: { label: 'TikTok', freshnessHours: 48, requestedScopes: [] },
};
