import { assignVariantOrNull } from '@arkiv/shared/variants';

/**
 * Landing routing for static campaign pages (plan 04 L6: "static-rendered landing pages on the CDN; no client JS
 * needed for the hero"). The proxy decides, per request and without rendering, which prerendered page a visitor
 * gets — the campaign page (utm_content routing on the default page), and the visitor's sticky copy variant — and
 * rewrites to /lp/<slug>/<variant>, which is rendered once and served from cache. Pure, so it is unit-tested.
 */

export interface LandingRoute {
  slug: string;
  utmMatch: string[];
  variants: { key: string; weight: number }[];
}

/** Set by the proxy with a new visitor cookie: the view it accompanies is the visitor's first ("new", not returning). */
export const FIRST_VIEW_COOKIE = 'arkiv_lp_new';

/** Path segment for "no variant" (the page's own copy). Variant keys never start with a dash. */
export const BASE_VARIANT = '-';

export type LandingDecision = { kind: 'rewrite'; slug: string; variant: string | null; path: string } | { kind: 'pass' };

/**
 * `/` → the default page, or the live page whose utm_match prefixes the visit's utm_content; `/for/<slug>` → that
 * page when live. Anything else — a draft preview, a page that isn't live (its dynamic route redirects with the
 * query intact), an unknown table — passes through to the dynamic routes.
 */
export function routeLanding(pathname: string, search: URLSearchParams, table: readonly LandingRoute[] | null, visitorId: string): LandingDecision {
  if (!table || search.has('preview')) return { kind: 'pass' };
  let page: LandingRoute | undefined;
  if (pathname === '/') {
    const content = search.get('utm_content')?.toLowerCase();
    page = (content ? table.find((p) => p.utmMatch.some((u) => u && content.startsWith(u.toLowerCase()))) : undefined) ?? table.find((p) => p.slug === 'default');
  } else {
    const m = /^\/for\/([^/]+)\/?$/.exec(pathname);
    if (!m) return { kind: 'pass' };
    page = table.find((p) => p.slug === decodeURIComponent(m[1]!));
  }
  if (!page) return { kind: 'pass' };
  const variant = assignVariantOrNull(`lp:${page.slug}`, visitorId, page.variants);
  return { kind: 'rewrite', slug: page.slug, variant, path: `/lp/${encodeURIComponent(page.slug)}/${variant ? encodeURIComponent(variant) : BASE_VARIANT}` };
}
