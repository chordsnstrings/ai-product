import { withTenant } from '@arkiv/db';
import { workspaceForShop } from '@arkiv/core';
import { verifyShopifyWebhook } from '@arkiv/integrations';

/**
 * Shopify webhooks: app/uninstalled and the mandatory GDPR topics. Tokens are revoked on uninstall; customer
 * data requests are acknowledged (we store no Shopify customer PII — read_products scope only).
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyShopifyWebhook(raw, req.headers.get('x-shopify-hmac-sha256'))) return new Response('Unauthorized', { status: 401 });
  const topic = req.headers.get('x-shopify-topic') ?? '';
  const shop = req.headers.get('x-shopify-shop-domain') ?? '';
  const ws = shop ? await workspaceForShop(shop) : null;
  if (ws && (topic === 'app/uninstalled' || topic === 'shop/redact')) {
    await withTenant(ws, (tx) => tx`update integrations set status = 'disconnected', token_enc = null, refresh_token_enc = null, updated_at = now()
                                where workspace_id = ${ws} and provider = 'shopify'`);
  }
  return Response.json({ ok: true });
}
