import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { qaQueueSql } from './admin';
import { analyzeProduct, startPreview } from './analysis';
import { produceFreeRevision, reportNotRight } from './not-right';
import { generateStoryboard } from './storyboard';
import { ctxFor, eventContractProblems, productPhoto } from './testing';
import { ingestBytes } from './uploads';

/** "Not right?" on a delivered ad (plan 03 P10, standard §48). */
beforeEach(truncateAll);
afterAll(closeAll);

async function delivered() {
  const t = await makeTenant({ state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} and idx = 'B'`;
  await ownerPool()`update projects set kind = 'taste', state = 'COMPLETE', selected_concept_id = ${c!.id} where id = ${projectId}`;
  return { t, ctx, skuId, projectId };
}

describe('"Not right?" (plan 03 P10, standard §48)', () => {
  it('product accuracy: re-plans the same idea once, free, and produces it without a checkout', async () => {
    const { t, ctx, skuId, projectId } = await delivered();
    const r = await withTenant(t.workspaceId, (tx) => reportNotRight(tx, ctx, projectId, { reason: 'accuracy', note: 'the cap is the wrong colour' }));
    expect(r).toMatchObject({ free: true, priceMicros: null, replayed: false, next: `/storyboard/${r.projectId}` });
    const [rev] = await ownerPool()`select sku_id, kind, state, revision_of, revision_free, selected_concept_id, storyboard_id from projects where id = ${r.projectId}`;
    expect(rev).toMatchObject({ sku_id: skuId, kind: 'taste', state: 'CONCEPT_SELECTED', revision_of: projectId, revision_free: true });
    // The same idea (B) is re-planned; the delivered ad is untouched.
    const [idea] = await ownerPool()`select idx from concepts where id = ${rev!.selected_concept_id}`;
    expect(idea!.idx).toBe('B');
    expect((await ownerPool()`select state from projects where id = ${projectId}`)[0]!.state).toBe('COMPLETE');
    const [fb] = await ownerPool()`select diagnosis, note, revision_project_id from project_feedback where project_id = ${projectId}`;
    expect(fb).toMatchObject({ diagnosis: 'fidelity', note: 'the cap is the wrong colour', revision_project_id: r.projectId });
    const [credit] = await ownerPool()`select unit, amount, project_id from ledger_entries where idempotency_key = ${`replan:${projectId}`}`;
    expect(credit).toMatchObject({ unit: 'taste', amount: 1, project_id: r.projectId });
    expect((await ownerPool()`select payload from events where type = 'OUTPUT_REJECTED'`)[0]!.payload).toMatchObject({ reason: 'accuracy', diagnosis: 'fidelity', free: true });
    // Staff see it in the QA queue.
    const [queued] = await withAdmin((tx) => tx`select why from (${qaQueueSql(tx, { includeTest: true })}) q where q.id = ${projectId}`);
    expect(queued!.why).toBe('customer: not right (fidelity)');

    // Asking again returns the same open re-plan.
    expect(await withTenant(t.workspaceId, (tx) => reportNotRight(tx, ctx, projectId, { reason: 'accuracy' }))).toMatchObject({ projectId: r.projectId, free: true, replayed: true });

    // Produced free once the storyboard is ready (no checkout).
    await generateStoryboard(ctx, r.projectId, rev!.storyboard_id as string, rev!.selected_concept_id as string);
    await withTenant(t.workspaceId, (tx) => produceFreeRevision(tx, ctx, r.projectId));
    expect((await ownerPool()`select state, entitlement_unit from projects where id = ${r.projectId}`)[0]).toMatchObject({ state: 'STORYBOARD_APPROVED', entitlement_unit: 'taste' });

    // Once used, product accuracy is no longer free for this ad: the next re-plan is at the one-off price.
    await ownerPool()`update projects set state = 'COMPLETE' where id = ${r.projectId}`;
    const again = await withTenant(t.workspaceId, (tx) => reportNotRight(tx, ctx, projectId, { reason: 'accuracy' }));
    expect(again).toMatchObject({ free: false, replayed: false });
    expect(again.priceMicros).toBeGreaterThan(0);
    expect((await ownerPool()`select kind, revision_free from projects where id = ${again.projectId}`)[0]).toMatchObject({ kind: 'standalone', revision_free: false });
    await expect(withTenant(t.workspaceId, (tx) => produceFreeRevision(tx, ctx, again.projectId))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await eventContractProblems(t.workspaceId)).toEqual([]);
  }, 120_000);

  it('strategy: the three directions come back to pick another, at the one-off price', async () => {
    const { t, ctx, projectId } = await delivered();
    const r = await withTenant(t.workspaceId, (tx) => reportNotRight(tx, ctx, projectId, { reason: 'strategy' }));
    expect(r).toMatchObject({ free: false, next: `/concepts/${r.projectId}` });
    const ideas = await ownerPool()`select idx from concepts where project_id = ${r.projectId} order by idx`;
    expect(ideas.map((c) => c.idx)).toEqual(['A', 'B', 'C']);
    expect((await ownerPool()`select state, kind from projects where id = ${r.projectId}`)[0]).toMatchObject({ state: 'CONCEPTS_READY', kind: 'standalone' });
    expect(await ownerPool()`select 1 from ledger_entries where idempotency_key like 'replan:%'`).toHaveLength(0);
  }, 120_000);

  it('only for a delivered one-off ad in this workspace', async () => {
    const { t, ctx, projectId } = await delivered();
    const other = await makeTenant({ state: 'ACTIVE_PAID' });
    await expect(withTenant(other.workspaceId, (tx) => reportNotRight(tx, ctxFor(other.workspaceId, other.userId), projectId, { reason: 'accuracy' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await ownerPool()`update projects set state = 'RENDERING' where id = ${projectId}`;
    await expect(withTenant(t.workspaceId, (tx) => reportNotRight(tx, ctx, projectId, { reason: 'accuracy' }))).rejects.toMatchObject({ code: 'CONFLICT' });
    await ownerPool()`update projects set state = 'COMPLETE', kind = 'creative_test' where id = ${projectId}`;
    await expect(withTenant(t.workspaceId, (tx) => reportNotRight(tx, ctx, projectId, { reason: 'accuracy' }))).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 120_000);
});
