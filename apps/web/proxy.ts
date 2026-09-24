import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@arkiv/shared';
import { FIRST_VIEW_COOKIE, routeLanding } from './lib/landing-routing';
import { landingTable } from './lib/landing-table';

/** Kept in step with lib/session.ts (the proxy can't import next/headers helpers). */
const VISITOR_COOKIE = 'arkiv_v';

/**
 * Campaign landing pages (plan 04 L6): `/` and `/for/<slug>` are served from a prerendered, cached page per
 * (page, copy variant) — rewritten to /lp/<slug>/<variant> — so the hero needs no database round-trip or client JS.
 * The visitor cookie is set here, before the page, so the sticky variant assignment and the funnel's visitor id
 * are stable from the very first view (a server component render can't set cookies). Deployed, the proxy runs in
 * front of the CDN cache (Next's CDN guidance): the cache key is the rewritten /lp path, never `/` itself.
 *
 * Draft previews (plan 05 §5) stay dynamic: the staff console frames `/for/<slug>?preview=<token>`, only the
 * console's own origin may frame it (CSP frame-ancestors), and the page verifies the signed token.
 */
export async function proxy(request: NextRequest) {
  const url = request.nextUrl;
  if (url.searchParams.has('preview')) {
    const res = NextResponse.next();
    let admin = '';
    try {
      admin = new URL(env().ADMIN_URL).origin;
    } catch {
      /* malformed ADMIN_URL: framing stays limited to this origin */
    }
    res.headers.set('Content-Security-Policy', `frame-ancestors 'self' ${admin}`.trim());
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
  const existing = request.cookies.get(VISITOR_COOKIE)?.value;
  const vid = existing ?? randomBytes(12).toString('base64url');
  const decision = routeLanding(url.pathname, url.searchParams, await landingTable(), vid);
  // A new visitor's id (and that this is their first view) also goes to the page rendering this request, so a
  // dynamic fallback records the same visitor the browser keeps.
  const headers = new Headers(request.headers);
  if (!existing) headers.set('cookie', [request.headers.get('cookie'), `${VISITOR_COOKIE}=${vid}`, `${FIRST_VIEW_COOKIE}=1`].filter(Boolean).join('; '));
  let res: NextResponse;
  if (decision.kind === 'rewrite') {
    const to = url.clone();
    to.pathname = decision.path;
    res = NextResponse.rewrite(to, { request: { headers } });
  } else {
    res = NextResponse.next({ request: { headers } });
  }
  if (!existing) {
    const secure = env().NODE_ENV === 'production';
    res.cookies.set(VISITOR_COOKIE, vid, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 365 * 86400 });
    // Read (and cleared) by the view beacon of the static page: this view is the visitor's first.
    if (decision.kind === 'rewrite') res.cookies.set(FIRST_VIEW_COOKIE, '1', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 600 });
  }
  return res;
}

export const config = { matcher: ['/', '/for/:slug'] };
