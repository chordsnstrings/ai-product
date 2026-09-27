import { setDigestPreference, verifyDigestOptOut } from '@arkiv/email';
import { env } from '@arkiv/shared';

/**
 * Weekly digest opt-out (plan 03 A10 "Weekly"): the List-Unsubscribe header and the footer link of a digest point
 * here, signed for one member, one workspace and one digest. Same rules as the marketing unsubscribe:
 * - POST from a mail client (RFC 8058 one-click) turns the digest off and answers 204;
 * - POST from the confirmation page (`confirm=1`) turns it off and returns to the page;
 * - GET never changes anything (link scanners prefetch): it opens the confirmation page.
 * Receipts, billing and security email are not affected; the member can turn it back on in Profile settings.
 */
export async function POST(req: Request) {
  const t = new URL(req.url).searchParams.get('t') ?? '';
  const o = verifyDigestOptOut(t);
  const form = await req.formData().catch(() => null);
  const fromPage = form?.get('confirm') === '1';
  if (!o) return fromPage ? page(t, 'invalid') : new Response('Invalid link', { status: 400 });
  await setDigestPreference(o, false);
  return fromPage ? page(t, 'done') : new Response(null, { status: 204 });
}

export async function GET(req: Request) {
  return page(new URL(req.url).searchParams.get('t') ?? '');
}

function page(t: string, state?: 'done' | 'invalid'): Response {
  const u = new URL('/email-preferences', env().APP_URL);
  if (t) u.searchParams.set('t', t);
  if (state) u.searchParams.set('state', state);
  return Response.redirect(u.toString(), 303);
}
