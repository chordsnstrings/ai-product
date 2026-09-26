import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { resultEffects, resultRevisions, variantChanges } from './result-story';

/** Standard §13 Results and plan 03 A6: what changed, what the result does, and revision history. */
beforeEach(truncateAll);
afterAll(closeAll);

async function experiment() {
  const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
  const skuId = await makeSku(t.workspaceId);
  const [e] = await ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, mode, state, created_by)
                                values (${t.workspaceId}, ${skuId}, 'Texture hook beats problem hook', 'hook', 'CONTROLLED', 'DIRECTIONAL', 'test') returning id`;
  const vs = await ownerPool()`insert into variants (workspace_id, experiment_id, label, code, role, changed_variables, held_constant)
                               values (${t.workspaceId}, ${e!.id}, 'Problem hook', 'AK-001-A', 'control', '{}', '{angle,treatment}'),
                                      (${t.workspaceId}, ${e!.id}, 'Texture hook', 'AK-001-B', 'variant', '{hook}', '{angle,treatment}')
                               returning id, code, label, role, changed_variables, held_constant`;
  return { t, skuId, experimentId: e!.id as string, variants: vs };
}

const obs = (ws: string, variantId: string, date: string, rev: number, v: { i: number; c: number; p: number }, superseded: string | null) => ownerPool()`
  insert into performance_observations (workspace_id, platform, account_id, ad_id, variant_id, date, currency, impressions, clicks, purchases, measurement_context, revision, superseded_at)
  values (${ws}, 'meta', 'act_1', ${`ad-${variantId.slice(0, 6)}`}, ${variantId}, ${date}, 'USD', ${v.i}, ${v.c}, ${v.p}, 'META_PAID_ATTRIBUTED', ${rev}, ${superseded})`;

describe('what a result means', () => {
  it('says what each variant changes and keeps the same', async () => {
    const { variants } = await experiment();
    expect(variantChanges(variants).map((v) => [v.code, v.changed, v.heldConstant])).toEqual([
      ['AK-001-A', [], ['angle', 'treatment']],
      ['AK-001-B', ['hook'], ['angle', 'treatment']],
    ]);
  });

  it('lists the learnings the test supports or contradicts and the recommendations they shape, only in this workspace', async () => {
    const { t, skuId, experimentId } = await experiment();
    const [l1] = await ownerPool()`insert into learnings (workspace_id, sku_id, statement, scope_platform, measurement_context, confidence, state, supporting_experiments)
                                   values (${t.workspaceId}, ${skuId}, 'Texture hooks hold attention', 'meta', 'META_PAID_ATTRIBUTED', 0.6, 'DIRECTIONAL', ${[experimentId]}) returning id`;
    await ownerPool()`insert into learnings (workspace_id, sku_id, statement, scope_platform, measurement_context, confidence, state, contradicting_experiments)
                      values (${t.workspaceId}, ${skuId}, 'Problem hooks win', 'meta', 'META_PAID_ATTRIBUTED', 0.3, 'WEAKENING', ${[experimentId]})`;
    await ownerPool()`insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, basis, rationale_ids)
                      values (${t.workspaceId}, ${skuId}, '2026-09-21', 'EXPLOIT', ${ownerPool().json({ hypothesis: 'Texture hook on Reels' })}, 0.8, '{}', 'performance', ${[l1!.id]}),
                             (${t.workspaceId}, ${skuId}, '2026-09-21', 'EXPLORE', ${ownerPool().json({ hypothesis: 'Unrelated' })}, 0.5, '{}', 'performance', '{}')`;
    const other = await experiment();
    const r = await withTenant(t.workspaceId, (tx) => resultEffects(tx, experimentId));
    expect(r.learnings.map((l) => [l.statement, l.supports, l.state]).sort()).toEqual([
      ['Problem hooks win', false, 'WEAKENING'],
      ['Texture hooks hold attention', true, 'DIRECTIONAL'],
    ]);
    expect(r.recommendations.map((x) => x.hypothesis)).toEqual(['Texture hook on Reels']);
    expect(await withTenant(other.t.workspaceId, (tx) => resultEffects(tx, experimentId))).toEqual({ learnings: [], recommendations: [] });
  });

  it('shows each late-conversion revision with the replaced and current numbers for the same ad-days', async () => {
    const { t, variants } = await experiment();
    const b = variants.find((v) => v.code === 'AK-001-B')!.id as string;
    await obs(t.workspaceId, b, '2026-09-10', 1, { i: 1000, c: 20, p: 1 }, '2026-09-24T09:00:00Z');
    await obs(t.workspaceId, b, '2026-09-10', 2, { i: 1000, c: 20, p: 3 }, null);
    await obs(t.workspaceId, b, '2026-09-11', 1, { i: 800, c: 10, p: 0 }, null);
    const revs = await withTenant(t.workspaceId, (tx) => resultRevisions(tx, variants.map((v) => v.id as string)));
    expect(revs).toEqual([{ variantId: b, revisedOn: '2026-09-24', days: 1, before: { impressions: 1000, clicks: 20, purchases: 1 }, after: { impressions: 1000, clicks: 20, purchases: 3 } }]);
    expect(await withTenant(t.workspaceId, (tx) => resultRevisions(tx, []))).toEqual([]);
  });
});
