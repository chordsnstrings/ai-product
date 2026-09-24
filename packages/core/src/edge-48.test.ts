import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { assertAssetUsable, replaceAsset, sweepExpiredRights, unusableAssets } from './asset-rights';
import { authorize } from './cost-governor';
import { createExperiment } from './experiments';
import { mockConcepts } from './mock-intel';
import { sweepDelayedProductions } from './production-delays';
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

describe('creator usage rights expire (§48)', () => {
  async function expiredFootage() {
    const r = await tenant();
    const footage = await withTenant(r.t.workspaceId, async (tx) => ingestBytes(tx, r.ctx, await productPhoto(), 'creator_footage', r.skuId));
    await ownerPool()`update assets set rights_expires_at = now() - interval '1 hour' where id = ${footage.id}`;
    return { ...r, footageId: footage.id };
  }

  it('the file is unusable for new work, and reuse is refused with a reason and a replacement offer', async () => {
    const { t, footageId } = await expiredFootage();
    expect(await withTenant(t.workspaceId, (tx) => unusableAssets(tx, [footageId]))).toEqual([{ assetId: footageId, reason: 'rights_expired' }]);
    expect(await withTenant(t.workspaceId, (tx) => usableAssetIds(tx, [footageId]))).toEqual([]);
    await expect(withTenant(t.workspaceId, (tx) => assertAssetUsable(tx, [footageId]))).rejects.toMatchObject({ code: 'CONFLICT', details: { replaceable: true } });
  });

  it('an ad made from it can’t be re-run as a control; its history stays', async () => {
    const { t, ctx, skuId, footageId } = await expiredFootage();
    const creativeId = await withTenant(t.workspaceId, (tx) => importHistoricalCreative(tx, ctx, { skuId, copy: 'Creator routine ad', assetId: footageId }));
    const proposal = mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;
    await expect(withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal, controlCreativeId: creativeId }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/rights have expired/) });
    expect(await ownerPool()`select 1 from experiments where workspace_id = ${t.workspaceId}`).toHaveLength(0);
    expect(await ownerPool()`select 1 from creatives where id = ${creativeId}`).toHaveLength(1);
    // Without the expired control, the same test can be created.
    await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal }));
  });

  it('the daily sweep reports each expiry once (event + one email per product), across workspaces', async () => {
    const a = await expiredFootage();
    const b = await expiredFootage();
    expect(await withSystem((tx) => sweepExpiredRights(tx))).toBe(2);
    expect(await withSystem((tx) => sweepExpiredRights(tx))).toBe(0);
    for (const r of [a, b]) {
      expect(await ownerPool()`select 1 from events where workspace_id = ${r.t.workspaceId} and type = 'ASSET_RIGHTS_EXPIRED' and subject_id = ${r.footageId}`).toHaveLength(1);
      const mail = await ownerPool()`select payload from outbox where workspace_id = ${r.t.workspaceId} and queue = 'send-email'`;
      expect(mail.map((m) => m.payload)).toEqual([expect.objectContaining({ template: 'rights_expired', skuId: r.skuId, assetIds: [r.footageId], workspaceId: r.t.workspaceId })]);
    }
  });

  it('replacement footage is a new file linked to the one it replaces; the old one is kept', async () => {
    const { t, ctx, footageId } = await expiredFootage();
    const r = await withTenant(t.workspaceId, async (tx) => replaceAsset(tx, ctx, footageId, await productPhoto('GLOW SERUM', '#B0907A'), 'new.jpg'));
    const [n] = await ownerPool()`select kind, lineage, rights_expires_at from assets where id = ${r.assetId}`;
    expect(n).toMatchObject({ kind: 'creator_footage', lineage: { replaces: footageId }, rights_expires_at: null });
    expect(await ownerPool()`select 1 from assets where id = ${footageId} and deleted_at is null`).toHaveLength(1);
    expect(await withTenant(t.workspaceId, (tx) => usableAssetIds(tx, [r.assetId]))).toEqual([r.assetId]);
  });
});

describe('production running past 20 minutes (plan 03 P9 edge)', () => {
  async function producing(minutesAgo: number, state = 'RENDERING', wsState = 'ACTIVE_PAID') {
    const r = await tenant();
    const id = newId();
    // A reserved render started `minutesAgo` (updated_at is maintained by a trigger, so the reservation dates it).
    const [a] = await ownerPool()`insert into cost_authorizations (workspace_id, purpose, token_hash, idempotency_key, rate_table_versions, estimate, max_cost_micros, expires_at, created_at)
                                  values (${r.t.workspaceId}, 'creative_test', ${`h:${id}`}, ${`t:${id}`}, '{}', '{}', 1, now() + interval '3 hours', now() - make_interval(mins => ${minutesAgo})) returning id`;
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit, authorization_id)
                      values (${id}, ${r.t.workspaceId}, ${r.skuId}, 'taste', ${state}, 'test', 'taste', ${a!.id})`;
    if (wsState !== 'ACTIVE_PAID') await ownerPool()`update workspaces set state = ${wsState} where id = ${r.t.workspaceId}`;
    return { ...r, projectId: id };
  }

  it('emails the owners once and raises one staff alert; on-time, finished and held productions are left alone', async () => {
    const late = await producing(25);
    const onTime = await producing(5);
    const done = await producing(60, 'COMPLETE');
    const held = await producing(60, 'RENDERING', 'SUSPENDED');
    const first = await withSystem((tx) => sweepDelayedProductions(tx));
    expect(first).toEqual([{ projectId: late.projectId, workspaceId: late.t.workspaceId, minutes: 25 }]);
    expect(await withSystem((tx) => sweepDelayedProductions(tx))).toEqual([]);
    // Even after the email job was dispatched, a later sweep does not send it again.
    await ownerPool()`update outbox set dispatched_at = now() where workspace_id = ${late.t.workspaceId}`;
    expect(await withSystem((tx) => sweepDelayedProductions(tx))).toEqual([]);
    const mail = await ownerPool()`select payload from outbox where queue = 'send-email' and payload->>'template' = 'production_delayed'`;
    expect(mail.map((m) => m.payload)).toEqual([expect.objectContaining({ projectId: late.projectId, workspaceId: late.t.workspaceId })]);
    const alerts = await ownerPool()`select subject_id, severity from platform_alerts where kind = 'production_delayed' and resolved_at is null`;
    expect(alerts).toEqual([{ subject_id: late.projectId, severity: 'risk' }]);
    for (const other of [onTime, done, held]) expect(await ownerPool()`select 1 from outbox where workspace_id = ${other.t.workspaceId} and queue = 'send-email'`).toHaveLength(0);
  });
});
