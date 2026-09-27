import { receiveWebhook } from '@arkiv/core';
import { verifyResendWebhook } from '@arkiv/email';

/** Resend (Svix-signed) delivery events (§38): verified, stored once per svix-id, processed by the worker. */
export async function POST(req: Request) {
  const raw = await req.text();
  const id = req.headers.get('svix-id');
  const ok = verifyResendWebhook(raw, { id, timestamp: req.headers.get('svix-timestamp'), signature: req.headers.get('svix-signature') });
  if (!ok || !id) return new Response('Invalid signature', { status: 400 });
  let type: string;
  try {
    type = String((JSON.parse(raw) as { type?: string }).type ?? 'unknown');
  } catch {
    return new Response('Invalid body', { status: 400 });
  }
  const duplicate = !(await receiveWebhook('resend', id, type, raw));
  return Response.json({ ok: true, duplicate });
}
