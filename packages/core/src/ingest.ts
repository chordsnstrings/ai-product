import { DomainError } from '@arkiv/shared';
import { assertPublicUrl, guardedRequest, type NetGuard } from './net-guard';

export { assertPublicUrl, isPublicAddress, type NetGuard } from './net-guard';

/**
 * Product URL import (standard §8, §28, §42). Structured commerce data (Shopify product JSON, JSON-LD) is
 * preferred over LLM extraction (§16). All fetched text is untrusted data. Every fetch goes through the SSRF
 * guard (net-guard.ts): public addresses only, each redirect hop re-checked, streamed size caps.
 */

const MAX_BYTES = 3 * 1024 * 1024;
/** Product photos downloaded from a page (og:image, JSON-LD, variant images). */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

/** A page or JSON document; a body past the cap is cut off there (enough to read a product page). */
export async function safeFetch(raw: string, accept = 'text/html,application/json', opts: { guard?: NetGuard; maxBytes?: number } = {}): Promise<FetchedPage> {
  const r = await guardedRequest(raw, { accept, maxBytes: opts.maxBytes ?? MAX_BYTES, guard: opts.guard });
  return { finalUrl: r.finalUrl, status: r.status, contentType: r.contentType, body: r.body.toString('utf8') };
}

/** One sellable variant (size, shade…) with its own price, availability and image (§42 "Variants / sizes"). */
export interface ExtractedVariant {
  /** Store's id for the variant (Shopify variant id; JSON-LD sku or url). */
  externalId?: string;
  title: string;
  /** Option name → value, e.g. { Size: '50 ml', Shade: 'Light' }. */
  options?: Record<string, string>;
  priceMicros?: number;
  compareAtMicros?: number;
  sku?: string;
  gtin?: string;
  available?: boolean;
  imageUrl?: string;
}

export interface ExtractedProduct {
  source: 'shopify' | 'json_ld' | 'opengraph' | 'html';
  name?: string;
  description?: string;
  brand?: string;
  priceMicros?: number;
  compareAtMicros?: number;
  currency?: string;
  images: string[];
  sku?: string;
  gtin?: string;
  variants?: ExtractedVariant[];
  /** The variant the pasted link points at (Shopify `?variant=`), if any. */
  selectedVariantId?: string;
  inStock?: boolean;
  ingredients?: string;
  sizeText?: string;
  /** The store's own product type / category (Shopify product_type, JSON-LD category), for scope checks. */
  productType?: string;
  shopifyProductId?: string;
  otherProducts?: { name: string; url: string }[];
  rawText: string;
}

const toMicros = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : undefined;
};

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ');

export const stripHtml = (html: string) =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

function meta(html: string, prop: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = re.exec(html);
  return m ? decode(m[1] ?? m[2] ?? '') : undefined;
}

function findIngredients(text: string): string | undefined {
  const m = /\bingredients?\s*[:\-]\s*([A-Za-z][^.]{20,1200}?)(?:\.\s|$)/i.exec(text);
  return m ? m[1]!.trim() : undefined;
}

export function findSize(text: string): string | undefined {
  const m = /\b(\d+(?:\.\d+)?\s?(?:ml|mL|fl\.?\s?oz|oz|g))\b/.exec(text);
  return m?.[1];
}

/** Parse JSON-LD Product (possibly nested in @graph). */
function jsonLd(html: string): Partial<ExtractedProduct> | null {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(b[1]!.trim());
    } catch {
      continue;
    }
    const nodes: Record<string, unknown>[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        nodes.push(n as Record<string, unknown>);
        if ((n as Record<string, unknown>)['@graph']) walk((n as Record<string, unknown>)['@graph']);
      }
    };
    walk(data);
    const p = nodes.find((n) => [n['@type']].flat().includes('Product'));
    if (!p) continue;
    const offers = [p.offers].flat().filter(Boolean) as Record<string, unknown>[];
    const offer = (offers[0]?.offers ? [offers[0].offers].flat()[0] : offers[0]) as Record<string, unknown> | undefined;
    const images = [p.image].flat().filter(Boolean).map((i) => (typeof i === 'string' ? i : String((i as Record<string, unknown>).url ?? '')));
    // Several offers (or an AggregateOffer's offers) are the product's variants: each keeps its own price.
    const allOffers = offers.flatMap((o) => (o.offers ? ([o.offers].flat() as Record<string, unknown>[]) : [o]));
    const variants: ExtractedVariant[] | undefined =
      allOffers.length > 1
        ? allOffers.map((o) => ({
            externalId: (o.sku as string) ?? (o.url as string) ?? undefined,
            title: decode(String(o.name ?? o.sku ?? '')).trim() || `Option ${allOffers.indexOf(o) + 1}`,
            priceMicros: toMicros(o.price ?? o.lowPrice),
            sku: o.sku as string | undefined,
            gtin: (o.gtin13 ?? o.gtin ?? o.gtin12) as string | undefined,
            available: o.availability ? /InStock/i.test(String(o.availability)) : undefined,
            imageUrl: typeof o.image === 'string' ? o.image : undefined,
          }))
        : undefined;
    const category = [p.category].flat().filter((c) => typeof c === 'string').join(' ');
    return {
      name: p.name ? decode(String(p.name)) : undefined,
      productType: category ? decode(category) : undefined,
      description: p.description ? stripHtml(String(p.description)) : undefined,
      brand: typeof p.brand === 'string' ? p.brand : ((p.brand as Record<string, unknown> | undefined)?.name as string | undefined),
      priceMicros: toMicros(offer?.price ?? offer?.lowPrice),
      currency: offer?.priceCurrency as string | undefined,
      inStock: offer?.availability ? /InStock/i.test(String(offer.availability)) : undefined,
      sku: p.sku as string | undefined,
      gtin: (p.gtin13 ?? p.gtin ?? p.gtin12) as string | undefined,
      images: images.filter(Boolean),
      variants,
    };
  }
  return null;
}

/** Shopify exposes `/products/<handle>.json` publicly on most stores. */
export function shopifyJsonUrl(u: URL): string | null {
  const m = /\/products\/([^/?#]+)/.exec(u.pathname);
  return m ? `${u.origin}/products/${m[1]}.json` : null;
}

export function parseShopifyProduct(json: string): Partial<ExtractedProduct> | null {
  try {
    const { product } = JSON.parse(json) as {
      product: {
        id: number;
        title: string;
        body_html: string;
        vendor: string;
        product_type?: string;
        images: { id?: number; src: string }[];
        options?: { name: string; position?: number }[];
        variants: {
          id?: number;
          title: string;
          price: string;
          compare_at_price: string | null;
          sku: string;
          barcode?: string;
          available?: boolean;
          option1?: string | null;
          option2?: string | null;
          option3?: string | null;
          image_id?: number | null;
          featured_image?: { src: string } | null;
        }[];
      };
    };
    if (!product?.title) return null;
    const v0 = product.variants?.[0];
    const optionNames = (product.options ?? []).map((o) => o.name);
    const imageById = new Map((product.images ?? []).filter((i) => i.id != null).map((i) => [i.id!, i.src]));
    return {
      source: 'shopify',
      shopifyProductId: String(product.id),
      name: product.title,
      description: stripHtml(product.body_html ?? ''),
      brand: product.vendor,
      productType: product.product_type || undefined,
      priceMicros: toMicros(v0?.price),
      compareAtMicros: toMicros(v0?.compare_at_price),
      // The product JSON carries no currency: it comes from the storefront page (og / JSON-LD / Shopify.currency) or
      // the shop's meta.json — never assumed (§47 "never sum raw values across currencies").
      currency: undefined,
      images: (product.images ?? []).map((i) => i.src),
      sku: v0?.sku || undefined,
      gtin: v0?.barcode || undefined,
      variants: (product.variants ?? []).map((v) => {
        const values = [v.option1, v.option2, v.option3];
        const options = Object.fromEntries(optionNames.map((n, i) => [n, values[i]]).filter(([n, val]) => n && val && !(n === 'Title' && val === 'Default Title'))) as Record<string, string>;
        return {
          externalId: v.id != null ? String(v.id) : undefined,
          title: v.title,
          options,
          priceMicros: toMicros(v.price),
          compareAtMicros: toMicros(v.compare_at_price),
          sku: v.sku || undefined,
          gtin: v.barcode || undefined,
          available: v.available,
          imageUrl: v.featured_image?.src ?? (v.image_id != null ? imageById.get(v.image_id) : undefined),
        };
      }),
    };
  } catch {
    return null;
  }
}

/** The storefront's active currency from Shopify's inline `Shopify.currency = {"active":"EUR",…}`. */
export function shopifyActiveCurrency(html: string): string | undefined {
  const m = /Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Z]{3})"/.exec(html);
  return m?.[1];
}

/** Parse any product page HTML into structured fields (JSON-LD → OpenGraph → text heuristics). */
export function parseProductHtml(html: string, pageUrl: string): ExtractedProduct {
  const text = stripHtml(html).slice(0, 20_000);
  const ld = jsonLd(html);
  const og = {
    name: meta(html, 'og:title'),
    description: meta(html, 'og:description') ?? meta(html, 'description'),
    image: meta(html, 'og:image'),
    price: meta(html, 'product:price:amount') ?? meta(html, 'og:price:amount'),
    currency: meta(html, 'product:price:currency'),
  };
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']*\/products\/[^"'?#]+)["'][^>]*>([^<]{2,80})</gi)]
    .map((m) => ({ url: new URL(m[1]!, pageUrl).toString(), name: decode(m[2]!.trim()) }))
    .filter((v, i, a) => a.findIndex((x) => x.url === v.url) === i)
    .slice(0, 12);
  const base: ExtractedProduct = {
    source: ld ? 'json_ld' : og.name ? 'opengraph' : 'html',
    name: ld?.name ?? og.name ?? (title ? decode(title).split('|')[0]!.trim() : undefined),
    description: ld?.description ?? og.description,
    brand: ld?.brand,
    productType: ld?.productType,
    priceMicros: ld?.priceMicros ?? toMicros(og.price),
    currency: ld?.currency ?? og.currency ?? shopifyActiveCurrency(html),
    images: [...(ld?.images ?? []), ...(og.image ? [og.image] : [])].map((i) => new URL(i, pageUrl).toString()).filter((v, i, a) => a.indexOf(v) === i),
    sku: ld?.sku,
    gtin: ld?.gtin,
    variants: ld?.variants,
    inStock: ld?.inStock,
    ingredients: findIngredients(text),
    sizeText: findSize(`${ld?.name ?? ''} ${ld?.description ?? og.description ?? ''} ${text}`),
    otherProducts: links,
    rawText: text,
  };
  return base;
}

/** Marketplace listings (not the brand's own store) we don't read; refused at submit time and on import. */
export const MARKETPLACE_MESSAGE = 'Marketplace listings aren’t supported yet. Paste your own store’s product page, or upload photos.';
export function isMarketplaceUrl(raw: string): boolean {
  try {
    return /(^|\.)(amazon|walmart|ebay)\.[a-z.]+$/i.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/** Full import: try Shopify JSON first (canonical commerce data), then the page. */
export async function importProductUrl(raw: string, opts: { guard?: NetGuard } = {}): Promise<ExtractedProduct> {
  const url = await assertPublicUrl(raw, opts.guard);
  if (isMarketplaceUrl(url.toString())) throw new DomainError('INVALID', MARKETPLACE_MESSAGE);
  const sj = shopifyJsonUrl(url);
  const selectedVariantId = url.searchParams.get('variant') ?? undefined;
  let shopify: Partial<ExtractedProduct> | null = null;
  if (sj) {
    const r = await safeFetch(sj, 'application/json', opts).catch(() => null);
    if (r && r.status === 200 && r.contentType.includes('json')) shopify = parseShopifyProduct(r.body);
  }
  const page = await safeFetch(url.toString(), undefined, opts).catch((e) => {
    if (shopify) return null;
    throw e;
  });
  if (page && page.status >= 400 && !shopify) {
    throw new DomainError('UNAVAILABLE', page.status === 403 || page.status === 429 ? 'That store blocked our reader.' : 'We couldn’t open that page.', { status: page.status });
  }
  const parsed: ExtractedProduct = page ? parseProductHtml(page.body, page.finalUrl) : { source: 'html' as const, images: [], rawText: '' };
  if (shopify && !parsed.currency) {
    // The shop's own currency (storefront /meta.json), when the page didn't state one.
    const m = await safeFetch(`${url.origin}/meta.json`, 'application/json', opts).catch(() => null);
    if (m && m.status === 200) {
      try {
        const c = (JSON.parse(m.body) as { currency?: string }).currency;
        if (c && /^[A-Z]{3}$/.test(c)) parsed.currency = c;
      } catch {
        /* no currency: left unknown */
      }
    }
  }
  if (shopify) {
    return {
      ...parsed,
      ...Object.fromEntries(Object.entries(shopify).filter(([, v]) => v !== undefined && v !== '')),
      source: 'shopify',
      images: [...(shopify.images ?? []), ...parsed.images].filter((v, i, a) => a.indexOf(v) === i),
      ingredients: parsed.ingredients ?? findIngredients(shopify.description ?? ''),
      sizeText: parsed.sizeText ?? findSize(`${shopify.name} ${shopify.description ?? ''}`),
      rawText: parsed.rawText || shopify.description || '',
      selectedVariantId,
    } as ExtractedProduct;
  }
  return parsed;
}

/**
 * Download a product image from an untrusted page. Null when it is unreachable, blocked by the SSRF guard, not an
 * image, or larger than the cap (the download stops at the cap instead of buffering the whole body).
 */
export async function fetchImage(url: string, opts: { guard?: NetGuard; maxBytes?: number } = {}): Promise<Buffer | null> {
  try {
    const r = await guardedRequest(url, { accept: 'image/*', maxBytes: opts.maxBytes ?? MAX_IMAGE_BYTES, guard: opts.guard });
    if (r.status < 200 || r.status >= 300 || r.truncated || !r.contentType.toLowerCase().startsWith('image/')) return null;
    return r.body;
  } catch {
    return null;
  }
}
