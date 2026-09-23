import { handleResendEvent, verifyResendWebhook } from '@arkiv/email';

export async function POST(req: Request) {
  const raw = await req.text();
  const ok = verifyResendWebhook(raw, { id: req.headers.get('svix-id'), timestamp: req.headers.get('svix-timestamp'), signature: req.headers.get('svix-signature') });
  if (!ok) return new Response('Invalid signature', { status: 400 });
  await handleResendEvent(JSON.parse(raw));
  return Response.json({ ok: true });
}
