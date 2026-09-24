import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@arkiv/shared';

/** Kept in step with @arkiv/auth (sessions.ts); the proxy stays free of database code. */
const SESSION_COOKIE = 'arkiv_session';
const SESSION_DAYS = 30;
/** Set alongside a refreshed session cookie; while present, the cookie is not re-issued (at most once a day). */
const REFRESH_MARKER = 'arkiv_sr';

/**
 * 1. Rolling sessions (plan 03 Part C "Sessions: 30-day rolling"): the database extends a session on use, and the
 *    cookie follows — re-issued with a fresh 30-day lifetime at most once a day, so an active user is never logged
 *    out by the browser 30 days after signing in. The database stays authoritative (a revoked or expired session
 *    is refused whatever the cookie says).
 * 2. Landing page draft previews (plan 05 §5 "Live preview on phone and desktop frames"): the staff console frames
 *    `/for/<slug>?preview=<token>`. Only the console's own origin may frame it (CSP frame-ancestors); the page
 *    itself verifies the signed token and otherwise shows the public page. Every other response keeps
 *    X-Frame-Options.
 */
export function proxy(request: NextRequest) {
  const res = NextResponse.next();
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  // Page loads only: API routes may set or clear the session cookie themselves (sign-in, rotation, sign-out).
  if (session && request.method === 'GET' && !request.cookies.has(REFRESH_MARKER) && !request.nextUrl.pathname.startsWith('/api/')) {
    const secure = env().NODE_ENV === 'production';
    res.cookies.set(SESSION_COOKIE, session, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86400 });
    res.cookies.set(REFRESH_MARKER, '1', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 86400 });
  }
  if (!request.nextUrl.pathname.startsWith('/for/') || !request.nextUrl.searchParams.has('preview')) return res;
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

// Pages and API routes; not static assets.
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js|woff2?)$).*)'] };
