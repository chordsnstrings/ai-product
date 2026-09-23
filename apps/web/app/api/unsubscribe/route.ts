import { unsubscribe, verifyUnsub } from '@arkiv/email';

/** One-click unsubscribe (RFC 8058 POST) and link fallback. */
export async function POST(req: Request) {
  const t = new URL(req.url).searchParams.get('t') ?? '';
  const email = verifyUnsub(t);
  if (!email) return new Response('Invalid link', { status: 400 });
  await unsubscribe(email);
  return new Response(null, { status: 204 });
}
