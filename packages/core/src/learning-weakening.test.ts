import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { blockClaim, proposeClaim } from './claims';
import { decideConfounder, markConfounder, sweepStaleLearnings } from './experiments';
import { mockConcepts } from './mock-intel';
import { revalidates, scoreProposal, scoringContext } from './recommendations';
import { ctxFor } from './testing';

/**
 * Standard §21: WEAKENING "reduce weight and schedule validation"; "learnings must be able to weaken or invalidate
 * when context, offer or market changes".
 */
beforeEach(truncateAll);
afterAll(closeAll);

async function setup() {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const skuId = await makeSku(t.workspaceId);
  return { t, ctx, skuId };
}

async function learning(ws: string, sku: string, state: string, revalidatedDaysAgo = 1, genes: Record<string, unknown> = { angle: 'TEXTURE_SENSORY' }) {
  const [l] = await ownerPool()`insert into learnings (workspace_id, sku_id, statement, scope_platform, measurement_context, confidence, state, relevant_genes, last_revalidated_at)
                                values (${ws}, ${sku}, 'Texture openings hold attention', 'meta', 'META_PAID_ATTRIBUTED', 0.8, ${state}, ${ownerPool().json(genes as never)},
                                        now() - make_interval(days => ${revalidatedDaysAgo})) returning id`;
  return l!.id as string;
}
const stateOf = async (id: string) => (await ownerPool()`select state, history from learnings where id = ${id}`)[0]!;
const weakened = async (ws: string) => (await ownerPool()`select subject_id from events where workspace_id = ${ws} and type = 'LEARNING_WEAKENED'`).map((e) => e.subject_id as string);

describe('scheduled revalidation', () => {
  it('weakens actionable learnings past 60 days without revalidation, in every workspace, once', async () => {
    const a = await setup();
    const b = await setup();
    const stale = await learning(a.t.workspaceId, a.skuId, 'ACTIONABLE', 61);
    const fresh = await learning(a.t.workspaceId, a.skuId, 'ACTIONABLE', 10);
    const directional = await learning(a.t.workspaceId, a.skuId, 'DIRECTIONAL', 90);
    const otherStale = await learning(b.t.workspaceId, b.skuId, 'ACTIONABLE', 70);
    expect(await withSystem((tx) => sweepStaleLearnings(tx))).toBe(2);
    expect(await withSystem((tx) => sweepStaleLearnings(tx))).toBe(0);
    expect((await stateOf(stale)).state).toBe('WEAKENING');
    expect((await stateOf(stale)).history).toEqual([expect.objectContaining({ from: 'ACTIONABLE', to: 'WEAKENING', reason: 'not revalidated in 60 days' })]);
    expect((await stateOf(fresh)).state).toBe('ACTIONABLE');
    expect((await stateOf(directional)).state).toBe('DIRECTIONAL');
    expect((await stateOf(otherStale)).state).toBe('WEAKENING');
    expect(await weakened(a.t.workspaceId)).toEqual([stale]);
    expect(await weakened(b.t.workspaceId)).toEqual([otherStale]);
  });

  it('a proposal that re-tests a weakening learning scores as a revalidation', async () => {
    const { t, skuId } = await setup();
    await learning(t.workspaceId, skuId, 'WEAKENING', 70, { angle: 'TEXTURE_SENSORY' });
    const s = await withTenant(t.workspaceId, (tx) => scoringContext(tx, skuId));
    const concepts = mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts;
    const same = { ...concepts[0]!, angle: 'TEXTURE_SENSORY' as const, primaryVariable: 'angle' as const, riskProfile: 'adjacent' as const };
    const other = { ...same, angle: 'ROUTINE' as const };
    expect(revalidates(same, s)).toBe(true);
    expect(revalidates(other, s)).toBe(false);
    expect(scoreProposal(same, s).breakdown.learnability).toBe(1);
    expect(scoreProposal(other, s).breakdown.learnability).toBe(0.75);
  });
});

describe('context changes weaken learnings', () => {
  it('a merchant-marked offer or price change weakens that SKU’s learnings (only)', async () => {
    const { t, ctx, skuId } = await setup();
    const other = await makeSku(t.workspaceId, 'Night Cream');
    const l1 = await learning(t.workspaceId, skuId, 'ACTIONABLE');
    const l2 = await learning(t.workspaceId, other, 'ACTIONABLE');
    await withTenant(t.workspaceId, (tx) => markConfounder(tx, ctx, { skuId, kind: 'stockout', startsAt: '2026-09-01' }));
    expect((await stateOf(l1)).state).toBe('ACTIONABLE');
    await withTenant(t.workspaceId, (tx) => markConfounder(tx, ctx, { skuId, kind: 'offer_change', startsAt: '2026-09-01' }));
    expect((await stateOf(l1)).state).toBe('WEAKENING');
    expect((await stateOf(l2)).state).toBe('ACTIONABLE');
    // A workspace-wide price change reaches every SKU.
    await withTenant(t.workspaceId, (tx) => markConfounder(tx, ctx, { kind: 'price_change', startsAt: '2026-09-02' }));
    expect((await stateOf(l2)).state).toBe('WEAKENING');
  });

  it('confirming an automatic offer-change candidate weakens; dismissing does not', async () => {
    const { t, ctx, skuId } = await setup();
    const l = await learning(t.workspaceId, skuId, 'DIRECTIONAL');
    const [c] = await ownerPool()`insert into confounders (workspace_id, sku_id, kind, starts_at, source, created_by, status) values (${t.workspaceId}, ${skuId}, 'offer_change', now(), 'automatic', 'system', 'pending_confirmation') returning id`;
    await withTenant(t.workspaceId, (tx) => decideConfounder(tx, ctx, c!.id as string, 'confirm'));
    expect((await stateOf(l)).state).toBe('WEAKENING');
  });

  it('blocking an approved claim weakens the SKU’s learnings', async () => {
    const { t, ctx, skuId } = await setup();
    const l = await learning(t.workspaceId, skuId, 'ACTIONABLE');
    const claim = await withTenant(t.workspaceId, (tx) => proposeClaim(tx, ctx, skuId, { wording: 'Lightweight texture', origin: 'merchant' }));
    await ownerPool()`update claims set status = 'VERIFIED' where id = ${claim.id}`;
    await withTenant(t.workspaceId, (tx) => blockClaim(tx, ctx, claim.id, 'evidence withdrawn'));
    expect((await stateOf(l)).state).toBe('WEAKENING');
    expect((await stateOf(l)).history).toEqual([expect.objectContaining({ reason: 'an approved claim was blocked' })]);
  });
});
