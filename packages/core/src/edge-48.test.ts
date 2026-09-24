import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { authorize } from './cost-governor';
import { importHistoricalCreative } from './genome';
import { routedLines } from './model-gateway';
import { qaScene } from './qa';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';
import { usableAssetIds } from './vision';

/** Standard §48 skincare and data-contamination edge cases (wp23). */
beforeEach(truncateAll);
afterAll(closeAll);

async function tenant() {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const skuId = await makeSku(t.workspaceId);
  return { t, ctx, skuId };
}

describe('scene QA: shade and apparent minors (§48 skincare rows)', () => {
  async function inspect(planText: string) {
    const { t, ctx } = await tenant();
    const lines = await withTenant(t.workspaceId, (tx) => routedLines(tx, t.workspaceId, [{ task: 'qa.fidelity', kind: 'llm', inputTokens: 40_000, outputTokens: 8_000 }]));
    const a = await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'creative_test', lines, idempotencyKey: `qa:${newId()}` }));
    const photo = await productPhoto();
    return qaScene({ ctx, token: a.token, sceneId: newId(), sceneText: 'Hands apply the serum', frameBytes: photo, referenceBytes: [photo], fingerprint: { labelText: 'GLOW SERUM', closure: 'dropper', liquidColor: 'amber' }, planText, attempt: 1 });
  }

  it('a materially different product colour is a hard product-fidelity failure', async () => {
    const [fid] = await inspect('Hands apply the serum [[qa:color]]');
    expect(fid).toMatchObject({ check: 'product_fidelity', pass: false, hard: true });
    expect(fid!.detail).toMatch(/wrong shade/);
  });

  it('a person who may appear under 18 fails the scene hard', async () => {
    const res = await inspect('A person applies the serum [[qa:minor]]');
    expect(res.find((c) => c.check === 'visual')).toMatchObject({ pass: false, hard: true, detail: expect.stringMatching(/under 18/) });
    expect(res.find((c) => c.check === 'product_fidelity')).toMatchObject({ pass: true });
  });

  it('a clean frame passes both', async () => {
    expect((await inspect('Hands apply the serum')).every((c) => c.pass)).toBe(true);
  });
});

describe('importing a past ad (§48 multiple SKUs; merchant footage with minors)', () => {
  it('records the other products shown, but only this workspace’s, and keeps results on the primary', async () => {
    const { t, ctx, skuId } = await tenant();
    const other = await makeSku(t.workspaceId, 'Night Cream');
    const stranger = await tenant();
    const id = await withTenant(t.workspaceId, (tx) => importHistoricalCreative(tx, ctx, { skuId, copy: 'Serum and cream routine', secondarySkuIds: [other, skuId, other] }));
    const [c] = await ownerPool()`select sku_id, secondary_sku_ids from creatives where id = ${id}`;
    expect(c).toMatchObject({ sku_id: skuId, secondary_sku_ids: [other] });
    await expect(withTenant(t.workspaceId, (tx) => importHistoricalCreative(tx, ctx, { skuId, copy: 'Serum routine', secondarySkuIds: [stranger.skuId] }))).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('declared minors hold the footage for compliance review; it is not a production input until cleared', async () => {
    const { t, ctx, skuId } = await tenant();
    const footage = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'historical_creative', skuId));
    const id = await withTenant(t.workspaceId, (tx) => importHistoricalCreative(tx, ctx, { skuId, copy: 'Family routine ad', assetId: footage.id, minorsPresent: true }));
    const [a] = await ownerPool()`select review_status, review_flags from assets where id = ${footage.id}`;
    expect(a).toMatchObject({ review_status: 'pending', review_flags: { possibleMinor: true, sources: ['declared'] } });
    expect(await withTenant(t.workspaceId, (tx) => usableAssetIds(tx, [footage.id]))).toEqual([]);
    const [c] = await ownerPool()`select platform_refs from creatives where id = ${id}`;
    expect(c!.platform_refs).toMatchObject({ minorsDeclared: true });
  });
});
