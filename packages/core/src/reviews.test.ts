import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { systemContext } from './context';
import { buildSkuReview, createSkuReview, dueSkuReviews } from './reviews';

beforeEach(truncateAll);
afterAll(closeAll);

async function experiment(ws: string, sku: string, state: string, angle: string, daysAgo: number) {
  const id = newId();
  await ownerPool()`insert into experiments (id, workspace_id, sku_id, hypothesis, primary_variable, mode, state, genes, created_by, created_at)
                    values (${id}, ${ws}, ${sku}, ${`Testing ${angle}`}, 'angle', 'CONTROLLED', ${state}, ${ownerPool().json({ angle, treatment: 'RAW_UGC' })}, 'user:x',
                            now() - make_interval(days => ${daysAgo}))`;
  return id;
}

async function learning(ws: string, sku: string, state: string, statement: string, contradicting: string[] = []) {
  await ownerPool()`insert into learnings (workspace_id, sku_id, statement, scope_platform, measurement_context, confidence, state, contradicting_experiments, valid_from)
                    values (${ws}, ${sku}, ${statement}, 'META', 'meta:ads', 0.8, ${state}, ${contradicting}, now() - interval '20 days')`;
}

describe('SKU Creative Review (standard §9 Day 30)', () => {
  it('summarises tested hypotheses, evidence, contradictions, untested space and the next portfolio', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const a = await experiment(t.workspaceId, sku, 'ACTIONABLE', 'TEXTURE_SENSORY', 25);
    await experiment(t.workspaceId, sku, 'INCONCLUSIVE', 'PROBLEM_SOLUTION', 20);
    await experiment(t.workspaceId, sku, 'DRAFT', 'INGREDIENT_EDUCATION', 5); // not tested
    await ownerPool()`insert into experiment_results (workspace_id, experiment_id, variant_id, measurement_context, metric, successes, trials, posterior_mean, ci_low, ci_high, prob_best, state)
                      values (${t.workspaceId}, ${a}, ${newId()}, 'meta:ads', 'ctr', 30, 1000, 0.031, 0.022, 0.041, 0.91, 'ACTIONABLE')`;
    await learning(t.workspaceId, sku, 'ACTIONABLE', 'Texture macro hooks beat talking heads on Meta');
    await learning(t.workspaceId, sku, 'WEAKENING', 'Price-first hooks lift CTR', [a]);
    await ownerPool()`insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, basis)
                      values (${t.workspaceId}, ${sku}, current_date, 'EXPAND', ${ownerPool().json({ hypothesis: 'Routine-fit demo for night use' })}, 0.7, '{}', 'performance')`;

    const b = await withTenant(t.workspaceId, (tx) => buildSkuReview(tx, sku, { start: new Date(Date.now() - 30 * 86_400_000), end: new Date() }));
    expect(b.summary).toEqual({ tested: 2, actionable: 1, directional: 0, inconclusive: 1, contradictions: 1 });
    expect(b.tested.find((x) => x.experimentId === a)!.best).toMatchObject({ rate: 0.031, probBest: 0.91 });
    expect(b.evidence.map((e) => e.statement)).toEqual(['Texture macro hooks beat talking heads on Meta']);
    expect(b.contradictions[0]).toMatchObject({ state: 'WEAKENING', contradictedBy: 1 });
    expect(b.untested.map((u) => u.angle)).not.toContain('TEXTURE_SENSORY');
    expect(b.untested.length).toBeGreaterThan(0);
    expect(b.portfolio).toEqual([expect.objectContaining({ slot: 'EXPAND', hypothesis: 'Routine-fit demo for night use' })]);
  });

  it('is due 30 days after the first test, written once, and emits an event', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const other = await makeSku(t.workspaceId, 'Too new');
    await experiment(t.workspaceId, sku, 'DIRECTIONAL', 'TEXTURE_SENSORY', 31);
    await experiment(t.workspaceId, other, 'DIRECTIONAL', 'TEXTURE_SENSORY', 10);
    const due = await withSystem((tx) => dueSkuReviews(tx));
    expect(due.map((d) => [d.skuId, d.kind])).toEqual([[sku, 'day30']]);
    const ctx = systemContext(t.workspaceId, 'test');
    const period = { start: due[0]!.start, end: due[0]!.end };
    const id = await withTenant(t.workspaceId, (tx) => createSkuReview(tx, ctx, sku, 'day30', period));
    expect(id).toBeTruthy();
    expect(await withTenant(t.workspaceId, (tx) => createSkuReview(tx, ctx, sku, 'day30', period))).toBeNull();
    expect(await withSystem((tx) => dueSkuReviews(tx))).toEqual([]);
    const [ev] = await ownerPool()`select payload from events where subject_id = ${sku} and type = 'SKU_REVIEW_CREATED'`;
    expect(ev!.payload).toMatchObject({ reviewId: id, kind: 'day30', tested: 1 });
    // Another workspace never sees it.
    const b = await makeTenant();
    expect(await withTenant(b.workspaceId, (tx) => tx`select 1 from sku_reviews`)).toHaveLength(0);
  });
});
