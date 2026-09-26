import { z } from 'zod';
import { pickShopifyProduct } from '@arkiv/core';
import { body, clientFingerprint, json, route } from '@/lib/http';
import { previewContext } from '@/lib/preview-context';
import { visitorId } from '@/lib/session';

/** The visitor picked a product from their connected store (plan 03 P2): it is previewed like a link import. */
export const POST = route(async (req) => {
  const { productId } = await body(req, z.object({ productId: z.string().min(1).max(80) }));
  const client = clientFingerprint(req);
  const ctx = await previewContext(client, { create: false });
  const r = await pickShopifyProduct(ctx, productId, { ip: client.ip, visitorId: await visitorId() });
  return json({ projectId: r.projectId, skuId: r.skuId });
});
