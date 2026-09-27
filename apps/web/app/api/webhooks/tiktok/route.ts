import { createHash } from 'node:crypto';
import { receiveWebhook } from '@arkiv/core';
import { verifyTiktokWebhook } from '@arkiv/integrations';

/**
 * TikTok for Business webhooks (§38, §40 "revocation detected"): verified with the app secret, stored once, and an
 * authorization-removed event revokes the matching ad-account integrations in the worker.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyTiktokWebhook(raw, req.headers.get('tiktok-signature'))) return new Response('Invalid signature', { status: 401 });
  let topic: string;
  try {
    const b = JSON.parse(raw) as { event?: string; type?: string };
    topic = String(b.event ?? b.type ?? 'unknown');
  } catch {
    return new Response('Invalid body', { status: 400 });
  }
  const duplicate = !(await receiveWebhook('tiktok', createHash('sha256').update(raw).digest('hex'), topic, raw));
  return Response.json({ ok: true, duplicate });
}
