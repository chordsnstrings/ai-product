import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@arkiv/shared';

/**
 * Landing page draft previews (plan 05 §5 "Live preview on phone and desktop frames"): the staff console frames
 * `/for/<slug>?preview=<token>`. Only the console's own origin may frame it (CSP frame-ancestors); the page itself
 * verifies the signed token and otherwise shows the public page. Every other response keeps X-Frame-Options.
 */
export function proxy(request: NextRequest) {
  const res = NextResponse.next();
  if (!request.nextUrl.searchParams.has('preview')) return res;
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

export const config = { matcher: ['/for/:slug'] };
