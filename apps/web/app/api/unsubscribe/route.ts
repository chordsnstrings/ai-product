import { unsubscribe, verifyUnsub } from '@arkiv/email';
import { env } from '@arkiv/shared';

/**
 * Marketing-stream unsubscribe (plan 04 L20 "One-click unsubscribe", plan 05 §18). The List-Unsubscribe header
 * and the visible footer link both point here (packages/email unsubscribeLink):
 * - POST from a mail client (RFC 8058 body `List-Unsubscribe=One-Click`) unsubscribes and answers 204;
 * - POST from the confirmation page's form (`confirm=1`) unsubscribes and returns to the page;
 * - GET (a click in the email, or a link scanner prefetching it) never unsubscribes: it opens the confirmation page.
 */
export async function POST(req: Request) {
  const t = new URL(req.url).searchParams.get('t') ?? '';
  const email = verifyUnsub(t);
  const form = await req.formData().catch(() => null);
  const fromPage = form?.get('confirm') === '1';
  if (!email) return fromPage ? page(t, 'invalid') : new Response('Invalid link', { status: 400 });
  await unsubscribe(email);
  return fromPage ? page(t, 'done') : new Response(null, { status: 204 });
}

export async function GET(req: Request) {
  return page(new URL(req.url).searchParams.get('t') ?? '');
}

function page(t: string, state?: 'done' | 'invalid'): Response {
  const u = new URL('/unsubscribe', env().APP_URL);
  if (t) u.searchParams.set('t', t);
  if (state) u.searchParams.set('state', state);
  return Response.redirect(u.toString(), 303);
}
