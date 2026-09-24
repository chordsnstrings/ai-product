import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, startPreview } from './analysis';
import { produceWithCreativeTest } from './experiments';
import { append } from './ledger';
import { generateStoryboard, retryStoryboard, selectConcept, STORYBOARD_FAILED_COPY, STORYBOARD_RETRY_LIMIT } from './storyboard';
import { ingestBytes } from './uploads';
import { ctxFor, productPhoto } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

/** A product added through the funnel (/start → ideas → storyboard) by a workspace on a plan. */
async function funnelStoryboard(opts: { tests: number; draw?: boolean }) {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  if (opts.tests) await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: opts.tests, periodKey: '2026-09-01', idempotencyKey: 'grant:funnel' }));
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
  if (opts.draw !== false) await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
  return { t, ctx, skuId, projectId, storyboardId, conceptId: c!.id as string };
}
const reservations = (ws: string) => ownerPool()`select count(*)::int as n from ledger_entries where workspace_id = ${ws} and type = 'CREDIT_RESERVED' and unit = 'creative_test'`.then((r) => r[0]!.n as number);

describe('a subscriber’s funnel storyboard is made with a Creative Test (standard §5)', () => {
  it('turns the project into a test’s master and approves it against one Creative Test — once', async () => {
    const x = await funnelStoryboard({ tests: 3 });
    const r = await withTenant(x.t.workspaceId, (tx) => produceWithCreativeTest(tx, x.ctx, x.projectId));
    expect(r.replayed).toBe(false);
    const [p] = await ownerPool()`select state, kind, entitlement_unit, experiment_id, variant_id, authorization_id from projects where id = ${x.projectId}`;
    expect(p).toMatchObject({ state: 'STORYBOARD_APPROVED', kind: 'creative_test', entitlement_unit: 'creative_test', experiment_id: r.experimentId });
    expect(p!.authorization_id).toBeTruthy(); // the Cost Governor authorization was made at approval
    const [e] = await ownerPool()`select state, approved_at, sku_id from experiments where id = ${r.experimentId}`;
    expect(e!.approved_at).not.toBeNull();
    expect(e!.state).toBe('PRODUCING');
    expect(e!.sku_id).toBe(x.skuId);
    const [master] = await ownerPool()`select id, project_id from variants where experiment_id = ${r.experimentId} and project_id is not null`;
    expect(master).toMatchObject({ id: p!.variant_id, project_id: x.projectId });
    expect(await reservations(x.t.workspaceId)).toBe(1);
    expect((await ownerPool()`select count(*)::int as n from purchases where project_id = ${x.projectId}`)[0]!.n).toBe(0); // no checkout

    // A double click / retried request: the same experiment, no second reservation.
    const again = await withTenant(x.t.workspaceId, (tx) => produceWithCreativeTest(tx, x.ctx, x.projectId));
    expect(again).toMatchObject({ experimentId: r.experimentId, replayed: true });
    expect(await reservations(x.t.workspaceId)).toBe(1);
    expect((await ownerPool()`select count(*)::int as n from experiments where workspace_id = ${x.t.workspaceId}`)[0]!.n).toBe(1);
  }, 120_000);

  it('with no Creative Tests left nothing changes; the one-off price is the way forward', async () => {
    const x = await funnelStoryboard({ tests: 0 });
    await expect(withTenant(x.t.workspaceId, (tx) => produceWithCreativeTest(tx, x.ctx, x.projectId))).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    const [p] = await ownerPool()`select state, kind, experiment_id from projects where id = ${x.projectId}`;
    expect(p!.state).toBe('STORYBOARD_READY');
    expect(p!.experiment_id).toBeNull();
    expect(p!.kind).not.toBe('creative_test');
    expect((await ownerPool()`select count(*)::int as n from experiments where workspace_id = ${x.t.workspaceId}`)[0]!.n).toBe(0);
  }, 120_000);

  it('a viewer can’t spend a test, and a storyboard still being drawn can’t be produced', async () => {
    const x = await funnelStoryboard({ tests: 2, draw: false });
    await expect(withTenant(x.t.workspaceId, (tx) => produceWithCreativeTest(tx, x.ctx, x.projectId))).rejects.toMatchObject({ code: 'CONFLICT' });
    const viewer = ctxFor(x.t.workspaceId, x.t.userId, 'VIEWER', 'ACTIVE_PAID');
    await expect(withTenant(x.t.workspaceId, (tx) => produceWithCreativeTest(tx, viewer, x.projectId))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await reservations(x.t.workspaceId)).toBe(0);
  }, 120_000);
});

describe('a storyboard we fail to draw (plan 03 P7 edge, standard §14)', () => {
  it('says so honestly, and "Try again" draws a fresh one for the same idea; retries are bounded', async () => {
    const x = await funnelStoryboard({ tests: 0, draw: false });
    // A real failure inside the worker: the idea it is asked to draw doesn't exist.
    await expect(generateStoryboard(x.ctx, x.projectId, x.storyboardId, '00000000-0000-4000-8000-000000000000')).rejects.toBeTruthy();
    const [sb] = await ownerPool()`select status from storyboards where id = ${x.storyboardId}`;
    expect(sb!.status).toBe('failed');
    const steps = await ownerPool()`select detail from progress_steps where subject_id = ${x.storyboardId} and status = 'failed'`;
    expect(steps.map((s) => s.detail).join(' ')).not.toMatch(/retrying/i);
    expect(steps.map((s) => s.detail)).toContain(STORYBOARD_FAILED_COPY);
    // No offer was issued for a storyboard that never became ready (§5).
    expect((await ownerPool()`select count(*)::int as n from offers where workspace_id = ${x.t.workspaceId}`)[0]!.n).toBe(0);

    const r = await withTenant(x.t.workspaceId, (tx) => retryStoryboard(tx, x.ctx, x.projectId));
    expect(r.replayed).toBe(false);
    expect(r.storyboardId).not.toBe(x.storyboardId);
    const [p] = await ownerPool()`select storyboard_id, state from projects where id = ${x.projectId}`;
    expect(p).toMatchObject({ storyboard_id: r.storyboardId, state: 'CONCEPT_SELECTED' });
    const jobs = await ownerPool()`select payload from outbox where queue like 'generate-storyboard%' and payload->>'storyboardId' = ${r.storyboardId}`;
    expect(jobs).toHaveLength(1);
    // A second click while it is drawn returns the same storyboard.
    expect(await withTenant(x.t.workspaceId, (tx) => retryStoryboard(tx, x.ctx, x.projectId))).toMatchObject({ storyboardId: r.storyboardId, replayed: true });
    await generateStoryboard(x.ctx, x.projectId, r.storyboardId, x.conceptId);
    expect((await ownerPool()`select state from projects where id = ${x.projectId}`)[0]!.state).toBe('STORYBOARD_READY');
    // Nothing to retry once it is ready.
    await expect(withTenant(x.t.workspaceId, (tx) => retryStoryboard(tx, x.ctx, x.projectId))).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 120_000);

  it('stops offering "Try again" after repeated failures of the same idea', async () => {
    const x = await funnelStoryboard({ tests: 0, draw: false });
    let sb = x.storyboardId;
    for (let i = 0; i < STORYBOARD_RETRY_LIMIT; i++) {
      await ownerPool()`update storyboards set status = 'failed' where id = ${sb}`;
      if (i === STORYBOARD_RETRY_LIMIT - 1) break;
      sb = (await withTenant(x.t.workspaceId, (tx) => retryStoryboard(tx, x.ctx, x.projectId))).storyboardId;
    }
    await expect(withTenant(x.t.workspaceId, (tx) => retryStoryboard(tx, x.ctx, x.projectId))).rejects.toMatchObject({ code: 'CONFLICT', details: { pickAnother: true } });
  }, 120_000);
});
