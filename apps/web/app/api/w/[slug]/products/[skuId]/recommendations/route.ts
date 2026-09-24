import { withTenant } from '@arkiv/db';
import { recommendationsForSku } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { json, route } from '@/lib/http';
import { workspaceBySlug } from '@/lib/tenant';

/**
 * GET /products/:id/recommendations (standard §38): open recommendations with rationale ids — resolved to the
 * customer themes, learnings, approved claims and facts they rest on — and confidence. Never chain-of-thought.
 */
export const GET = route(async (_req, { params }: { params: Promise<{ slug: string; skuId: string }> }) => {
  const { slug, skuId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(skuId)) throw new DomainError('NOT_FOUND', 'Not found');
  const w = await workspaceBySlug(slug);
  const recommendations = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [sku] = await tx`select id from skus where id = ${skuId}`;
    if (!sku) throw new DomainError('NOT_FOUND', 'Not found');
    return recommendationsForSku(tx, skuId);
  });
  return json({ skuId, recommendations });
});
