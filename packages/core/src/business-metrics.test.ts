import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { DEFAULT_TASTE_REFUND_RATE, learningVelocity, tasteContribution } from './business-metrics';
import { creativeCoverage } from './genome';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';

/** Standard Appendix C: Taste contribution, learning velocity and creative coverage. */
beforeEach(truncateAll);
afterAll(closeAll);

async function taste(ws: string, micros: number, daysAgo: number, refunded = 0) {
  const projectId = newId();
  const [sku] = await ownerPool()`select id from skus where workspace_id = ${ws} limit 1`;
  await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by) values (${projectId}, ${ws}, ${sku!.id}, 'taste', 'COMPLETE', 'test')`;
  await ownerPool()`insert into purchases (workspace_id, project_id, kind, amount_micros, refunded_micros, status, created_by, paid_at)
                    values (${ws}, ${projectId}, 'taste', ${micros}, ${refunded}, ${refunded ? 'refunded' : 'paid'}, 'test', now() - make_interval(days => ${daysAgo}))`;
  return projectId;
}

describe('Taste contribution (Appendix C)', () => {
  it('is net revenue after refunds, expected refunds, output COGS and payment fees; test workspaces are left out', async () => {
    const t = await makeTenant();
    await makeSku(t.workspaceId);
    const p1 = await taste(t.workspaceId, 29_000_000, 3);
    await taste(t.workspaceId, 29_000_000, 5, 29_000_000); // refunded in full
    await taste(t.workspaceId, 29_000_000, 40); // older than the refund window: no expected refund
    // Production cost after purchase counts; the free preview before it does not.
    await ownerPool()`insert into ledger_entries (workspace_id, project_id, type, unit, amount, actor, idempotency_key, created_at)
                      values (${t.workspaceId}, ${p1}, 'PROVIDER_COST_RECORDED', 'usd_micros', 4000000, 'system:t', 'c1', now() - interval '2 days'),
                             (${t.workspaceId}, ${p1}, 'PROVIDER_COST_RECORDED', 'usd_micros', 150000, 'system:t', 'c0', now() - interval '4 days')`;
    const test = await makeTenant();
    await makeSku(test.workspaceId);
    await ownerPool()`update workspaces set is_test = true where id = ${test.workspaceId}`;
    await taste(test.workspaceId, 29_000_000, 2);

    const r = await withAdmin((tx) => tasteContribution(tx, { days: 60 }));
    expect(r.purchases).toBe(3);
    expect(r.grossMicros).toBe(87_000_000);
    expect(r.refundedMicros).toBe(29_000_000);
    // No settled refunds in the 180-day history: the settled rate is 0 (one settled sale, not refunded).
    expect(r.expectedRefundRate).toBe(0);
    expect(r.cogsMicros).toBe(4_000_000);
    const fee = Math.round((87_000_000 * 290) / 10_000) + 3 * 300_000;
    expect(r.paymentFeeMicros).toBe(fee);
    expect(r.contributionMicros).toBe(87_000_000 - 29_000_000 - 0 - 4_000_000 - fee);
    expect((await withAdmin((tx) => tasteContribution(tx, { days: 60, includeTest: true }))).purchases).toBe(4);
    // One tenant only.
    expect((await withAdmin((tx) => tasteContribution(tx, { days: 60, includeTest: true, workspaceId: test.workspaceId }))).purchases).toBe(1);
  });

  it('applies the settled refund rate to sales still inside the refund window, or a default without history', async () => {
    const t = await makeTenant();
    await makeSku(t.workspaceId);
    await taste(t.workspaceId, 20_000_000, 10);
    const none = await withAdmin((tx) => tasteContribution(tx, { days: 30 }));
    expect(none.expectedRefundRate).toBe(DEFAULT_TASTE_REFUND_RATE);
    expect(none.expectedRefundsMicros).toBe(Math.round(20_000_000 * DEFAULT_TASTE_REFUND_RATE));
    // Settled history: one of four older sales refunded → 25%.
    for (let i = 0; i < 3; i++) await taste(t.workspaceId, 20_000_000, 60 + i);
    await taste(t.workspaceId, 20_000_000, 70, 20_000_000);
    const r = await withAdmin((tx) => tasteContribution(tx, { days: 30 }));
    expect(r.expectedRefundRate).toBe(0.25);
    expect(r.expectedRefundsMicros).toBe(5_000_000);
  });
});

describe('learning velocity (Appendix C)', () => {
  it('counts experiments the first time they reach Directional or Actionable, per active SKU per month', async () => {
    const t = await makeTenant();
    await makeSku(t.workspaceId);
    await makeSku(t.workspaceId, 'Cream');
    await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, current_period_start, current_period_end, consent_record_id)
                      values (${t.workspaceId}, 'sub_v', 'GROWTH', 'active', now(), now() + interval '30 days', gen_random_uuid())`;
    const ev = (subject: string, to: string, daysAgo: number) =>
      ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload, at)
                  values (${t.workspaceId}, 'EXPERIMENT_STATE_CHANGED', 'system:t', 'experiment', ${subject}, ${ownerPool().json({ from: 'GATHERING_SIGNAL', to })}, now() - make_interval(days => ${daysAgo}))`;
    const [a, b, c] = [newId(), newId(), newId()];
    await ev(a, 'DIRECTIONAL', 5);
    await ev(a, 'ACTIONABLE', 2); // same experiment: counted once
    await ev(b, 'ACTIONABLE', 10);
    await ev(c, 'DIRECTIONAL', 50); // first reached before the window
    await ev(c, 'ACTIONABLE', 3);
    await ev(newId(), 'INCONCLUSIVE', 3); // not a learning state
    const v = await withAdmin((tx) => learningVelocity(tx, { days: 30, workspaceId: t.workspaceId }));
    expect(v).toEqual({ experiments: 2, activeSkus: 2, perSkuPerMonth: 1 });
    // A workspace with no subscription and no experiment activity has no active SKUs.
    const idle = await makeTenant();
    await makeSku(idle.workspaceId);
    expect(await withAdmin((tx) => learningVelocity(tx, { days: 30, workspaceId: idle.workspaceId }))).toEqual({ experiments: 0, activeSkus: 0, perSkuPerMonth: null });
  });
});

describe('creative coverage (Appendix C)', () => {
  it('meaningfully tested cells over the cells open to the SKU; a trivial test does not count', async () => {
    const t = await makeTenant();
    const skuId = await makeSku(t.workspaceId);
    const base = await withTenant(t.workspaceId, (tx) => creativeCoverage(tx, skuId));
    expect(base.tested).toBe(0);
    expect(base.ratio).toBe(0);
    const exp = (state: string) =>
      ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, mode, state, created_by, genes)
                  values (${t.workspaceId}, ${skuId}, 'h', 'hook', 'CONTROLLED', ${state}, 'test', ${ownerPool().json({ angle: 'ROUTINE', hookMechanism: 'LIST', treatment: 'HYBRID' })})`;
    await exp('GATHERING_SIGNAL'); // under-delivered: not coverage
    expect((await withTenant(t.workspaceId, (tx) => creativeCoverage(tx, skuId))).tested).toBe(0);
    await exp('DIRECTIONAL');
    const after = await withTenant(t.workspaceId, (tx) => creativeCoverage(tx, skuId));
    expect(after.tested).toBe(1);
    expect(after.ratio).toBeCloseTo(1 / after.eligible, 3);
    // Footage treatments open up once rights-confirmed footage exists; ingredient education needs an ingredient list.
    const ctx = ctxFor(t.workspaceId, t.userId);
    const footage = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'creator_footage', skuId));
    await ownerPool()`update assets set rights_attested_at = now() where id = ${footage.id}`;
    expect((await withTenant(t.workspaceId, (tx) => creativeCoverage(tx, skuId))).eligible).toBeGreaterThan(after.eligible);
  });
});
