import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { DomainError } from '@arkiv/shared';

/**
 * Product URL import (standard §8, §28, §42). Structured commerce data (Shopify product JSON, JSON-LD) is
 * preferred over LLM extraction (§16). All fetched text is untrusted data.
 */

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
    v.startsWith('::ffff:') && isPrivateIp(v.replace('::ffff:', ''));
}

/** SSRF guard: only http(s) to public addresses, re-checked on every redirect hop. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DomainError('INVALID', 'That doesn’t look like a web address.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new DomainError('INVALID', 'Only http(s) links are supported.');
  if (url.username || url.password) throw new DomainError('INVALID', 'Links with credentials are not supported.');
  if (url.port && !['80', '443', ''].includes(url.port)) throw new DomainError('INVALID', 'Unsupported port.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new DomainError('INVALID', 'That address is not reachable.');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new DomainError('INVALID', 'We couldn’t reach that site.');
  if (addrs.some((a) => isPrivateIp(a.address))) throw new DomainError('INVALID', 'That address is not reachable.');
  return url;
}

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

export async function safeFetch(raw: string, accept = 'text/html,application/json'): Promise<FetchedPage> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { Accept: accept, 'User-Agent': 'ArkivBot/1.0 (+product import; merchant-initiated)' },
      });
    } catch (e) {
      clearTimeout(t);
      throw new DomainError('UNAVAILABLE', (e as Error).name === 'AbortError' ? 'The page took too long to respond.' : 'We couldn’t reach that page.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(t);
      url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          ctrl.abort();
          break;
        }
        chunks.push(value);
      }
    }
    clearTimeout(t);
    return {
      finalUrl: url.toString(),
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
    };
  }
  throw new DomainError('UNAVAILABLE', 'Too many redirects.');
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
  variants?: { title: string; priceMicros?: number; sku?: string }[];
  inStock?: boolean;
  ingredients?: string;
  sizeText?: string;
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

function findSize(text: string): string | undefined {
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
    return {
      name: p.name ? decode(String(p.name)) : undefined,
      description: p.description ? stripHtml(String(p.description)) : undefined,
      brand: typeof p.brand === 'string' ? p.brand : ((p.brand as Record<string, unknown> | undefined)?.name as string | undefined),
      priceMicros: toMicros(offer?.price ?? offer?.lowPrice),
      currency: offer?.priceCurrency as string | undefined,
      inStock: offer?.availability ? /InStock/i.test(String(offer.availability)) : undefined,
      sku: p.sku as string | undefined,
      gtin: (p.gtin13 ?? p.gtin ?? p.gtin12) as string | undefined,
      images: images.filter(Boolean),
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
        images: { src: string }[];
        variants: { title: string; price: string; compare_at_price: string | null; sku: string; barcode?: string; available?: boolean }[];
      };
    };
    if (!product?.title) return null;
    const v0 = product.variants?.[0];
    return {
      source: 'shopify',
      shopifyProductId: String(product.id),
      name: product.title,
      description: stripHtml(product.body_html ?? ''),
      brand: product.vendor,
      priceMicros: toMicros(v0?.price),
      compareAtMicros: toMicros(v0?.compare_at_price),
      currency: 'USD',
      images: (product.images ?? []).map((i) => i.src),
      sku: v0?.sku || undefined,
      gtin: v0?.barcode || undefined,
      variants: (product.variants ?? []).map((v) => ({ title: v.title, priceMicros: toMicros(v.price), sku: v.sku || undefined })),
    };
  } catch {
    return null;
  }
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
    priceMicros: ld?.priceMicros ?? toMicros(og.price),
    currency: ld?.currency ?? og.currency,
    images: [...(ld?.images ?? []), ...(og.image ? [og.image] : [])].map((i) => new URL(i, pageUrl).toString()).filter((v, i, a) => a.indexOf(v) === i),
    sku: ld?.sku,
    gtin: ld?.gtin,
    inStock: ld?.inStock,
    ingredients: findIngredients(text),
    sizeText: findSize(`${ld?.name ?? ''} ${ld?.description ?? og.description ?? ''} ${text}`),
    otherProducts: links,
    rawText: text,
  };
  return base;
}

/** Full import: try Shopify JSON first (canonical commerce data), then the page. */
export async function importProductUrl(raw: string): Promise<ExtractedProduct> {
  const url = await assertPublicUrl(raw);
  if (/amazon\.|walmart\.|ebay\./i.test(url.hostname)) {
    throw new DomainError('INVALID', 'Marketplace listings aren’t supported yet. Paste your own store’s product page, or upload photos.');
  }
  const sj = shopifyJsonUrl(url);
  let shopify: Partial<ExtractedProduct> | null = null;
  if (sj) {
    const r = await safeFetch(sj, 'application/json').catch(() => null);
    if (r && r.status === 200 && r.contentType.includes('json')) shopify = parseShopifyProduct(r.body);
  }
  const page = await safeFetch(url.toString()).catch((e) => {
    if (shopify) return null;
    throw e;
  });
  if (page && page.status >= 400 && !shopify) {
    throw new DomainError('UNAVAILABLE', page.status === 403 || page.status === 429 ? 'That store blocked our reader.' : 'We couldn’t open that page.', { status: page.status });
  }
  const parsed = page ? parseProductHtml(page.body, page.finalUrl) : { source: 'html' as const, images: [], rawText: '' };
  if (shopify) {
    return {
      ...parsed,
      ...Object.fromEntries(Object.entries(shopify).filter(([, v]) => v !== undefined && v !== '')),
      source: 'shopify',
      images: [...(shopify.images ?? []), ...parsed.images].filter((v, i, a) => a.indexOf(v) === i),
      ingredients: parsed.ingredients ?? findIngredients(shopify.description ?? ''),
      sizeText: parsed.sizeText ?? findSize(`${shopify.name} ${shopify.description ?? ''}`),
      rawText: parsed.rawText || shopify.description || '',
    } as ExtractedProduct;
  }
  return parsed;
}

export async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    await assertPublicUrl(url);
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 15 * 1024 * 1024 ? null : buf;
  } catch {
    return null;
  }
}
