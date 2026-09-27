import { createHash } from 'node:crypto';
import { receiveWebhook } from '@arkiv/core';
import { verifyShopifyWebhook } from '@arkiv/integrations';

/**
 * Shopify webhooks (§38): verify the HMAC, store the raw delivery once per X-Shopify-Webhook-Id, ack fast. The
 * worker processes it: app/uninstalled and shop/redact revoke the integration (INTEGRATION_DISCONNECTED), the
 * mandatory customers/* GDPR topics are recorded as data requests (we hold no Shopify customer data), and
 * products/update queues a product sync.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyShopifyWebhook(raw, req.headers.get('x-shopify-hmac-sha256'))) return new Response('Unauthorized', { status: 401 });
  const topic = req.headers.get('x-shopify-topic') ?? 'unknown';
  const delivery = req.headers.get('x-shopify-webhook-id') ?? `sha256:${createHash('sha256').update(`${topic}\n${raw}`).digest('hex')}`;
  const duplicate = !(await receiveWebhook('shopify', delivery, topic, raw, { 'x-shopify-shop-domain': req.headers.get('x-shopify-shop-domain') }));
  return Response.json({ ok: true, duplicate });
}
