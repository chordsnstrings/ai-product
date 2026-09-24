import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, ingestBytes, Queues, startPreview, weekOf } from '@arkiv/core';
import { ctxFor, productPhoto } from '@arkiv/core/testing';
import { runJob } from './handlers';

/** Standard §9 "Day 1-2: receive three recommended experiments" — not on the next Monday (biz-25). */
beforeEach(truncateAll);
afterAll(closeAll);

async function analysedSku(state: 'ACTIVE_PAID' | 'ACTIVE_FREE', plan: string | undefined) {
  const t = await makeTenant({ state, plan });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', state);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  return { t, skuId };
}

describe('first recommendations', () => {
  it('a subscriber’s newly analysed SKU gets its recommendations queued at once, for that SKU', async () => {
    const { t, skuId } = await analysedSku('ACTIVE_PAID', 'GROWTH');
    const jobs = await ownerPool()`select id, payload from outbox where workspace_id = ${t.workspaceId} and queue = ${Queues.weeklyRecommendations}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ skuId, week: weekOf() });
    const n = await runJob(Queues.weeklyRecommendations, jobs[0]!.payload as Record<string, unknown>, jobs[0]!.id as string);
    expect(n).toBeGreaterThan(0);
    const [r] = await ownerPool()`select count(distinct sku_id)::int as skus, count(*)::int as n from recommendations where workspace_id = ${t.workspaceId}`;
    expect(r).toMatchObject({ skus: 1 });
  }, 60_000);

  it('a free workspace’s SKU queues nothing (recommendations are a plan feature)', async () => {
    const { t } = await analysedSku('ACTIVE_FREE', undefined);
    expect(await ownerPool()`select 1 from outbox where workspace_id = ${t.workspaceId} and queue = ${Queues.weeklyRecommendations}`).toHaveLength(0);
  }, 60_000);
});
