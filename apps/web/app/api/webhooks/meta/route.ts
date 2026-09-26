import { createHash } from 'node:crypto';
import { receiveWebhook } from '@arkiv/core';
import { parseMetaSignedRequest } from '@arkiv/integrations';
import { env } from '@arkiv/shared';

/**
 * Meta app callbacks (§38, §40): the Deauthorize callback (?type=deauthorize) and the Data Deletion Request callback
 * (?type=data_deletion) post a `signed_request`. It is verified with the app secret, stored once, and the worker
 * revokes every integration that user authorised. A deletion request answers with Meta's required
 * { url, confirmation_code } (we keep no Meta user data beyond the connection, which is removed).
 */
export async function POST(req: Request) {
  const type = new URL(req.url).searchParams.get('type') === 'data_deletion' ? 'data_deletion' : 'deauthorize';
  const form = await req.formData().catch(() => null);
  const signed = (form?.get('signed_request') as string | null) ?? null;
  const p = parseMetaSignedRequest(signed);
  if (!p || !signed) return new Response('Invalid signature', { status: 400 });
  const code = createHash('sha256').update(signed).digest('hex').slice(0, 20);
  await receiveWebhook('meta', `${type}:${code}`, type, JSON.stringify({ userId: p.userId, issuedAt: p.issuedAt }));
  if (type === 'deauthorize') return Response.json({ ok: true });
  return Response.json({ url: `${env().APP_URL}/legal/privacy?deletion=${code}`, confirmation_code: code });
}
