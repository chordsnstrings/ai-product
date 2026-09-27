import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@arkiv/shared';
import { FIRST_VIEW_COOKIE, routeLanding } from './lib/landing-routing';
import { landingTable } from './lib/landing-table';

/** Kept in step with lib/session.ts (the proxy can't import next/headers helpers). */
const VISITOR_COOKIE = 'arkiv_v';

/** Kept in step with @arkiv/auth (sessions.ts); the proxy stays free of database code. */
const SESSION_COOKIE = 'arkiv_session';
const SESSION_DAYS = 30;
/** Set alongside a refreshed session cookie; while present, the cookie is not re-issued (at most once a day). */
const REFRESH_MARKER = 'arkiv_sr';

/** `/` and `/for/<slug>`: the campaign landing paths. */
function isLandingPath(pathname: string): boolean {
  return pathname === '/' || /^\/for\/[^/]+\/?$/.test(pathname);
}

/**
 * 1. Rolling sessions (plan 03 Part C "Sessions: 30-day rolling"): the database extends a session on use, and the
 *    cookie follows — re-issued with a fresh 30-day lifetime at most once a day, so an active user is never logged
 *    out by the browser 30 days after signing in. The database stays authoritative (a revoked or expired session
 *    is refused whatever the cookie says).
 * 2. Campaign landing pages (plan 04 L6): `/` and `/for/<slug>` are served from a prerendered, cached page per
 *    (page, copy variant) — rewritten to /lp/<slug>/<variant> — so the hero needs no database round-trip or client
 *    JS. The visitor cookie is set here, before the page, so the sticky variant assignment and the funnel's visitor
 *    id are stable from the very first view (a server component render can't set cookies). Deployed, the proxy runs
 *    in front of the CDN cache (Next's CDN guidance): the cache key is the rewritten /lp path, never `/` itself.
 * 3. Draft previews (plan 05 §5) stay dynamic: the staff console frames `/for/<slug>?preview=<token>`, only the
 *    console's own origin may frame it (CSP frame-ancestors), and the page verifies the signed token. Every other
 *    response keeps X-Frame-Options.
 */
export async function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const res = await route(request);
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  // Page loads only: API routes may set or clear the session cookie themselves (sign-in, rotation, sign-out).
  if (session && request.method === 'GET' && !request.cookies.has(REFRESH_MARKER) && !url.pathname.startsWith('/api/')) {
    const secure = env().NODE_ENV === 'production';
    res.cookies.set(SESSION_COOKIE, session, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86400 });
    res.cookies.set(REFRESH_MARKER, '1', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 86400 });
  }
  return res;
}

async function route(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl;
  if (!isLandingPath(url.pathname)) return NextResponse.next();
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

// Pages and API routes; not static assets.
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js|woff2?)$).*)'] };
