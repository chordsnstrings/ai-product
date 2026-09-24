import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import type { WorkspaceState } from '@arkiv/shared';
import { analyzeProduct, generateConceptBatch, requestConcepts, startPreview } from './analysis';
import { append } from './ledger';
import { approveForProduction } from './production';
import { generateStoryboard, regenerateFrame, requestFrameRegeneration, selectConcept } from './storyboard';
import { ingestBytes } from './uploads';
import { ctxFor, productPhoto } from './testing';

/**
 * §34: AI work runs in jobs enqueued in the same transaction as the state change; requests never call a model
 * inside the HTTP request. Plan 02 §3 layer 5: free-tier work runs on its own pool, paid work first.
 */
beforeEach(truncateAll);
afterAll(closeAll);

const jobs = (queue: string) => ownerPool()`select payload, priority, singleton_key from outbox where queue = ${queue} order by created_at`;

async function preview(state: WorkspaceState = 'ACTIVE_FREE') {
  const t = await makeTenant({ state, plan: state === 'ACTIVE_PAID' ? 'GROWTH' : undefined });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', state);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  return { t, ctx, skuId, projectId };
}

describe('queue routing (plan 02 §3 layer 5)', () => {
  it('sends free-tier previews to the free pool at low priority and paying tenants to the main pool', async () => {
    await preview('ACTIVE_FREE');
    const free = await jobs('analyze-product-free');
    expect(free).toHaveLength(1);
    expect(Number(free[0]!.priority)).toBe(0);
    expect(await jobs('analyze-product')).toHaveLength(0);
    await preview('ACTIVE_PAID');
    const paid = await jobs('analyze-product');
    expect(paid).toHaveLength(1);
    expect(Number(paid[0]!.priority)).toBe(10);
  });

  it('routes storyboards by tier and gives production the top priority', async () => {
    const { t, ctx, skuId, projectId } = await preview('ACTIVE_FREE');
    await analyzeProduct(ctx, skuId, projectId);
    const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
    const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
    expect(await jobs('generate-storyboard-free')).toHaveLength(1);
    await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: 'pay:routing' });
      await approveForProduction(tx, ctx, projectId, 'taste');
    });
    const produce = await jobs('produce-project');
    expect(Number(produce[0]!.priority)).toBe(20);
  }, 60_000);
});

describe('"try 3 more" runs as a job (§34)', () => {
  it('enqueues in the request, drafts in the worker, and is idempotent per batch', async () => {
    const { t, ctx, skuId, projectId } = await preview();
    await analyzeProduct(ctx, skuId, projectId);
    const r = await withTenant(t.workspaceId, (tx) => requestConcepts(tx, ctx, projectId));
    expect(r).toMatchObject({ batch: 2, replayed: false });
    // Nothing was drafted inside the request.
    expect((await ownerPool()`select count(*)::int as n from concepts where project_id = ${projectId} and batch = 2`)[0]!.n).toBe(0);
    const [job] = await jobs('generate-concepts-free');
    expect(job!.payload).toMatchObject({ projectId, batch: 2, workspaceId: t.workspaceId });
    // A double-click returns the request in flight instead of queuing another.
    expect(await withTenant(t.workspaceId, (tx) => requestConcepts(tx, ctx, projectId))).toMatchObject({ batch: 2, replayed: true });
    expect(await jobs('generate-concepts-free')).toHaveLength(1);

    expect(await generateConceptBatch(ctx, projectId, 2)).toBe('done');
    await withTenant(t.workspaceId, async (tx) => {
      const b2 = await tx`select idx from concepts where project_id = ${projectId} and batch = 2 order by idx`;
      expect(b2.map((x) => x.idx)).toEqual(['A', 'B', 'C']);
      const [a] = await tx`select status from cost_authorizations where idempotency_key = ${`concepts:${projectId}:2`}`;
      expect(a!.status).toBe('settled');
      const [s] = await tx`select status from progress_steps where subject_id = ${projectId} and step_key = 'concepts.batch.2'`;
      expect(s!.status).toBe('done');
    });
    // Redelivery of the same job never redrafts or re-reserves.
    expect(await generateConceptBatch(ctx, projectId, 2)).toBe('done');
    expect((await ownerPool()`select count(*)::int as n from cost_authorizations where idempotency_key like ${`concepts:${projectId}:%`}`)[0]!.n).toBe(1);
    // The next request is batch 3.
    expect(await withTenant(t.workspaceId, (tx) => requestConcepts(tx, ctx, projectId))).toMatchObject({ batch: 3, replayed: false });
  }, 60_000);

  it('takes over a reservation stranded by a crashed attempt instead of skipping forever', async () => {
    const { t, ctx, skuId, projectId } = await preview();
    await analyzeProduct(ctx, skuId, projectId);
    await withTenant(t.workspaceId, (tx) => requestConcepts(tx, ctx, projectId));
    // Simulate a worker that reserved and died 20 minutes ago.
    await ownerPool()`insert into cost_authorizations (workspace_id, project_id, purpose, token_hash, idempotency_key, rate_table_versions, estimate, max_cost_micros, expires_at, created_at)
                      values (${t.workspaceId}, ${projectId}, 'storyboard', 'dead-token', ${`concepts:${projectId}:2`}, '{}', '{}', 1000, now() + interval '1 hour', now() - interval '20 minutes')`;
    expect(await generateConceptBatch(ctx, projectId, 2)).toBe('done');
    const rows = await ownerPool()`select status, idempotency_key from cost_authorizations where idempotency_key like ${`concepts:${projectId}:2%`} order by created_at`;
    expect(rows.map((r) => r.status)).toEqual(['released', 'settled']);
  }, 60_000);

  it('a live duplicate delivery is skipped (no double spend)', async () => {
    const { t, ctx, skuId, projectId } = await preview();
    await analyzeProduct(ctx, skuId, projectId);
    await withTenant(t.workspaceId, (tx) => requestConcepts(tx, ctx, projectId));
    await ownerPool()`insert into cost_authorizations (workspace_id, project_id, purpose, token_hash, idempotency_key, rate_table_versions, estimate, max_cost_micros, expires_at)
                      values (${t.workspaceId}, ${projectId}, 'storyboard', 'live-token', ${`concepts:${projectId}:2`}, '{}', '{}', 1000, now() + interval '1 hour')`;
    expect(await generateConceptBatch(ctx, projectId, 2)).toBe('skipped');
    expect((await ownerPool()`select count(*)::int as n from concepts where project_id = ${projectId} and batch = 2`)[0]!.n).toBe(0);
  }, 60_000);
});

describe('"change picture" runs as a job (§34)', () => {
  it('validates and enqueues in the request; the worker draws, counts the free change and is idempotent', async () => {
    const { t, ctx, skuId, projectId } = await preview();
    await analyzeProduct(ctx, skuId, projectId);
    const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
    const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
    await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
    const [scene] = await ownerPool()`select id from scenes where storyboard_id = ${storyboardId} order by position limit 1`;
    const sceneId = scene!.id as string;

    await expect(withTenant(t.workspaceId, (tx) => requestFrameRegeneration(tx, ctx, sceneId, 'cure acne overnight'))).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    const r = await withTenant(t.workspaceId, (tx) => requestFrameRegeneration(tx, ctx, sceneId, 'warmer morning light'));
    expect(r).toMatchObject({ version: 2, replayed: false });
    const [job] = await jobs('regenerate-frame-free');
    expect(job!.payload).toMatchObject({ sceneId, version: 2, instruction: 'warmer morning light' });
    expect((await ownerPool()`select count(*)::int as n from scene_versions where scene_id = ${sceneId} and version = 2`)[0]!.n).toBe(0);

    expect(await regenerateFrame(ctx, sceneId, 'warmer morning light', 2)).toBe('done');
    expect(await regenerateFrame(ctx, sceneId, 'warmer morning light', 2)).toBe('done'); // redelivery
    await withTenant(t.workspaceId, async (tx) => {
      const [s] = await tx`select free_regenerations_used, current_version_id from scenes where id = ${sceneId}`;
      expect(s!.free_regenerations_used).toBe(1);
      const [v] = await tx`select version from scene_versions where id = ${s!.current_version_id}`;
      expect(v!.version).toBe(2);
      const [a] = await tx`select count(*)::int as n from cost_authorizations where idempotency_key = ${`frame:${sceneId}:2`}`;
      expect(a!.n).toBe(1);
    });
  }, 60_000);

  it('counts in-flight requests against the free allowance', async () => {
    const { t, ctx, skuId, projectId } = await preview();
    await analyzeProduct(ctx, skuId, projectId);
    const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
    const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
    await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
    const scenes = await ownerPool()`select id from scenes where storyboard_id = ${storyboardId} and not locked order by position limit 4`;
    for (const s of scenes.slice(0, 3)) await withTenant(t.workspaceId, (tx) => requestFrameRegeneration(tx, ctx, s.id as string, 'softer shadows'));
    await expect(withTenant(t.workspaceId, (tx) => requestFrameRegeneration(tx, ctx, scenes[3]!.id as string, 'softer shadows'))).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
  }, 60_000);
});

describe('free frame changes under concurrency (x-races-12)', () => {
  async function storyboard() {
    const { t, ctx, skuId, projectId } = await preview();
    await analyzeProduct(ctx, skuId, projectId);
    const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
    const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
    await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
    const scenes = await ownerPool()`select id from scenes where storyboard_id = ${storyboardId} order by position`;
    return { t, ctx, storyboardId, sceneIds: scenes.map((s) => s.id as string) };
  }
  const used = async (storyboardId: string) => Number((await ownerPool()`select sum(free_regenerations_used)::int as n from scenes where storyboard_id = ${storyboardId}`)[0]!.n);

  it('parallel requests on different scenes never exceed the three free changes', async () => {
    const { t, ctx, sceneIds } = await storyboard();
    expect(sceneIds.length).toBeGreaterThanOrEqual(5);
    const results = await Promise.allSettled(sceneIds.slice(0, 5).map((id) => withTenant(t.workspaceId, (tx) => requestFrameRegeneration(tx, ctx, id, 'softer shadows'))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.reason).toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(await jobs('regenerate-frame-free')).toHaveLength(3);
  }, 60_000);

  it('a request whose job ran late cannot push the storyboard past its allowance', async () => {
    const { t, ctx, storyboardId, sceneIds } = await storyboard();
    await ownerPool()`update scenes set free_regenerations_used = 1 where id = any(${sceneIds.slice(2, 4)}::uuid[])`;
    // Change A is queued, then sits in a backed-up queue long enough to go stale at request time…
    await withTenant(t.workspaceId, (tx) => requestFrameRegeneration(tx, ctx, sceneIds[0]!, 'warmer light'));
    await ownerPool()`update progress_steps set started_at = now() - interval '11 minutes' where subject_id = ${sceneIds[0]!}`;
    // …so change B is accepted (2 used + nothing live in flight).
    await withTenant(t.workspaceId, (tx) => requestFrameRegeneration(tx, ctx, sceneIds[1]!, 'marble counter'));
    // Both jobs now run at once: only one of them may draw.
    const outcomes = await Promise.all([regenerateFrame(ctx, sceneIds[0]!, 'warmer light', 2), regenerateFrame(ctx, sceneIds[1]!, 'marble counter', 2)]);
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(1);
    expect(await used(storyboardId)).toBe(3);
    const refused = await ownerPool()`select status, detail from progress_steps where subject_id = any(${sceneIds.slice(0, 2)}::uuid[]) and step_key = 'frame.v2' and status = 'failed'`;
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toMatch(/free frame changes/);
    // The refused change spent nothing.
    const auths = await ownerPool()`select count(*)::int as n from cost_authorizations where idempotency_key like 'frame:%' and workspace_id = ${t.workspaceId}`;
    expect(auths[0]!.n).toBe(1);
  }, 60_000);
});
