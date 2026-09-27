import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import type { NormalizedObservation } from '@arkiv/integrations';
import { approveExperiment, computeResults, createExperiment, experimentMetrics, metricsFor, modeFor, validateExperimentDesign } from './experiments';
import { mockConcepts } from './mock-intel';
import { ingestObservations } from './performance';
import { editScene, EXPLORATORY_WARNING, generateStoryboard } from './storyboard';
import { ctxFor } from './testing';

/**
 * Experiment design and evidence (standard §20, §21, §38; plan 03 A3): the metrics a test is judged on, the
 * controlled-variable schema, an edit that makes a controlled test exploratory, stored explanations and CPA/ROAS.
 */
beforeEach(truncateAll);
afterAll(closeAll);

const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const proposal = () => mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;

async function tenant() {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const skuId = await makeSku(t.workspaceId);
  return { t, ctx, skuId };
}

/** The merchant's current ad, as a control. */
async function currentAd(workspaceId: string, skuId: string) {
  const [c] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin) values (${workspaceId}, ${skuId}, 'imported') returning id`;
  return c!.id as string;
}

function obs(adId: string, adName: string, date: string, o: { impressions: number; clicks: number; purchases: number; valueMicros: number; spendMicros: number }): NormalizedObservation {
  return {
    platform: 'meta', accountId: 'act_1', campaignId: 'c1', adgroupId: 'as1', adId, adName, date, currency: 'USD',
    spendMicros: o.spendMicros, impressions: o.impressions, reach: null, frequency: null, clicks: o.clicks, outboundClicks: null,
    videoStarts: Math.round(o.impressions * 0.6), video25: null, video50: null, video75: Math.round(o.impressions * 0.1), video100: null, avgWatchMs: null,
    addToCart: null, checkout: null, purchases: o.purchases, purchaseValueMicros: o.valueMicros,
    attributionModel: 'meta_default', attributionWindow: '7d_click_1d_view', optimizationEvent: 'OFFSITE_CONVERSIONS', campaignType: 'OUTCOME_SALES',
    measurementContext: 'META_PAID_ATTRIBUTED',
  };
}

describe('what an experiment is judged on (§20 primary_metric, leading_metrics[])', () => {
  it('follows the variable it compares, and computeResults reads exactly those metrics', () => {
    expect(metricsFor('hook')).toEqual({ primary: 'hold_rate', leading: ['ctr', 'cvr'] });
    expect(metricsFor('offer')).toEqual({ primary: 'cvr', leading: ['ctr', 'hold_rate'] });
    expect(metricsFor('proof').primary).toBe('cvr');
    expect(metricsFor('angle')).toEqual({ primary: 'ctr', leading: ['hold_rate', 'cvr'] });
    expect(experimentMetrics({ primary_metric: 'cvr', leading_metrics: ['ctr', 'cvr', 'nonsense'] })).toEqual(['cvr', 'ctr']);
    expect(experimentMetrics({ primary_metric: null, leading_metrics: null })).toEqual(['ctr']);
  });

  it('an offer test against the current ad is judged on conversion and never holds the offer constant', async () => {
    const { t, ctx, skuId } = await tenant();
    const controlCreativeId = await currentAd(t.workspaceId, skuId);
    const p = { ...proposal(), primaryVariable: 'offer' as const, riskProfile: 'lower_risk' as const };
    const { experimentId } = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: p, controlCreativeId }));
    const [e] = await ownerPool()`select primary_variable, primary_metric, leading_metrics, controlled_variables, mode from experiments where id = ${experimentId}`;
    expect(e).toMatchObject({ primary_variable: 'offer', primary_metric: 'cvr', leading_metrics: ['ctr', 'hold_rate'], mode: 'CONTROLLED' });
    expect(e!.controlled_variables).not.toContain('offer');
    const vs = await ownerPool()`select role, held_constant from variants where experiment_id = ${experimentId} and role = 'control'`;
    expect(vs[0]!.held_constant).not.toContain('offer');
    // A hook test without a control: hold rate first.
    const hook = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: { ...proposal(), angle: 'ROUTINE', primaryVariable: 'hook' } }));
    expect((await ownerPool()`select primary_metric, leading_metrics from experiments where id = ${hook.experimentId}`)[0]).toMatchObject({ primary_metric: 'hold_rate', leading_metrics: ['ctr', 'cvr'] });
  });
});

describe('controlled-variable schema (§38 "server validates controlled-variable schema")', () => {
  const variants = [
    { id: 'c', role: 'control', changed_variables: [] },
    { id: 'm', role: 'variant', changed_variables: ['angle'] },
    { id: 'h', role: 'variant', changed_variables: ['hook'] },
  ];
  it('accepts a sound design and names each problem of a broken one', () => {
    expect(validateExperimentDesign({ mode: 'CONTROLLED', primary_variable: 'angle', controlled_variables: ['body', 'cta'], control_variant_id: 'c' }, variants)).toEqual([]);
    const bad = validateExperimentDesign({ mode: 'CONTROLLED', primary_variable: 'angle', controlled_variables: ['angle', 'body'], control_variant_id: 'x' }, [
      ...variants,
      { id: 'o', role: 'variant', changed_variables: ['offer', 'hook'] },
    ]);
    expect(bad.join(' | ')).toMatch(/control variant is not one of this test’s controls/);
    expect(bad.join(' | ')).toMatch(/tested variable \(angle\) can’t also be held constant/);
    expect(bad.join(' | ')).toMatch(/changes offer/);
    // Exploratory tests may change many things; only the control's consistency is checked.
    expect(validateExperimentDesign({ mode: 'EXPLORATORY', primary_variable: 'angle', controlled_variables: [], control_variant_id: null }, [{ id: 'o', role: 'variant', changed_variables: ['offer', 'angle', 'talent'] }])).toEqual([]);
  });

  it('modeFor: a hook test or a test against the current ad is controlled unless the idea itself is exploratory', () => {
    expect(modeFor({ primaryVariable: 'hook', riskProfile: 'adjacent' })).toBe('CONTROLLED');
    expect(modeFor({ primaryVariable: 'angle', riskProfile: 'adjacent' })).toBe('EXPLORATORY');
    expect(modeFor({ primaryVariable: 'angle', riskProfile: 'adjacent' }, 'creative-1')).toBe('CONTROLLED');
    expect(modeFor({ primaryVariable: 'hook', riskProfile: 'exploratory' })).toBe('EXPLORATORY');
  });

  it('approval re-checks the design before any spend', async () => {
    const { t, ctx, skuId } = await tenant();
    const r = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: { ...proposal(), primaryVariable: 'hook', riskProfile: 'lower_risk' } }));
    await ownerPool()`update experiments set controlled_variables = array_append(controlled_variables, 'hook') where id = ${r.experimentId}`;
    await expect(withTenant(t.workspaceId, (tx) => approveExperiment(tx, ctx, r.experimentId))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await ownerPool()`select approved_at from experiments where id = ${r.experimentId}`)[0]!.approved_at).toBeNull();
  });
});

describe('an edit that changes what a controlled test holds (plan 03 A3)', () => {
  it('warns “This makes it exploratory”, applies nothing until confirmed, then records the new mode', async () => {
    const { t, ctx, skuId } = await tenant();
    const controlCreativeId = await currentAd(t.workspaceId, skuId);
    const r = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: { ...proposal(), primaryVariable: 'angle', riskProfile: 'lower_risk' }, controlCreativeId }));
    const [c] = await ownerPool()`select selected_concept_id from projects where id = ${r.projectId}`;
    await generateStoryboard(ctx, r.projectId, r.storyboardId, c!.selected_concept_id as string);
    const scenes = await ownerPool()`select id, position, purpose, overlay_text from scenes where storyboard_id = ${r.storyboardId} order by position`;
    const body = scenes.find((s) => Number(s.position) > 0 && s.purpose !== 'cta')!;
    const edit = (accept?: boolean) => withTenant(t.workspaceId, (tx) => editScene(tx, ctx, body.id as string, { overlayText: 'Light, fast, no residue', acceptExploratory: accept }));
    expect(await edit()).toMatchObject({ applied: false, warning: EXPLORATORY_WARNING, changes: ['body'] });
    expect((await ownerPool()`select overlay_text from scenes where id = ${body.id}`)[0]!.overlay_text).toBe(body.overlay_text);
    expect((await ownerPool()`select mode from experiments where id = ${r.experimentId}`)[0]!.mode).toBe('CONTROLLED');

    expect(await edit(true)).toMatchObject({ applied: true });
    expect((await ownerPool()`select overlay_text from scenes where id = ${body.id}`)[0]!.overlay_text).toBe('Light, fast, no residue');
    const [e] = await ownerPool()`select mode, controlled_variables from experiments where id = ${r.experimentId}`;
    expect(e).toMatchObject({ mode: 'EXPLORATORY', controlled_variables: [] });
    const ev = await ownerPool()`select payload, refs from events where type = 'EXPERIMENT_MODE_CHANGED' and subject_id = ${r.experimentId}`;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ from: 'CONTROLLED', to: 'EXPLORATORY', changed: ['body'] });
    expect(ev[0]!.refs).toMatchObject({ skuId, experimentId: r.experimentId });
    // Now exploratory: further edits go straight through.
    expect(await withTenant(t.workspaceId, (tx) => editScene(tx, ctx, body.id as string, { overlayText: 'Light and fast' }))).toMatchObject({ applied: true });
  }, 60_000);

  it('a hook test’s shared scenes change every variant alike: no warning', async () => {
    const { t, ctx, skuId } = await tenant();
    const r = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: { ...proposal(), primaryVariable: 'hook', riskProfile: 'lower_risk' } }));
    const [c] = await ownerPool()`select selected_concept_id from projects where id = ${r.projectId}`;
    await generateStoryboard(ctx, r.projectId, r.storyboardId, c!.selected_concept_id as string);
    const [s] = await ownerPool()`select id from scenes where storyboard_id = ${r.storyboardId} and position = 1`;
    expect(await withTenant(t.workspaceId, (tx) => editScene(tx, ctx, s!.id as string, { overlayText: 'Light, fast, no residue' }))).toMatchObject({ applied: true });
    expect((await ownerPool()`select mode from experiments where id = ${r.experimentId}`)[0]!.mode).toBe('CONTROLLED');
  }, 60_000);
});

describe('stored explanations and CPA / ROAS (§21)', () => {
  it('keeps each comparison’s explanation, writes CPA and ROAS rows, and drops a comparison whose data is gone', async () => {
    const { t, ctx, skuId } = await tenant();
    const { experimentId } = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: proposal(), slot: 'EXPAND' }));
    await ownerPool()`update experiments set state = 'READY_TO_RUN' where id = ${experimentId}`;
    const variants = await ownerPool()`select id, code from variants where experiment_id = ${experimentId} order by code`;
    const rows: NormalizedObservation[] = [];
    for (let d = 1; d <= 9; d++) {
      variants.forEach((v, i) =>
        rows.push(obs(`${experimentId}-${i}`, `Serum ${v.code}`, day(d + 1), { impressions: 3000, clicks: 60, purchases: i === 0 ? 5 : 2, valueMicros: (i === 0 ? 5 : 2) * 40_000_000, spendMicros: 30_000_000 })),
      );
    }
    await withTenant(t.workspaceId, (tx) => ingestObservations(tx, ctx, null, rows));
    const out = await withTenant(t.workspaceId, (tx) => computeResults(tx, ctx, experimentId));
    expect(out.commercial.map((c) => c.metric).sort()).toEqual(['cpa', 'roas']);

    const cmp = await ownerPool()`select metric, state, explanation, leader_variant_id from experiment_comparisons where experiment_id = ${experimentId} order by metric`;
    expect(cmp.map((c) => c.metric)).toEqual(['cpa', 'ctr', 'cvr', 'hold_rate', 'roas']);
    for (const c of cmp) expect(String(c.explanation).length).toBeGreaterThan(10);
    const cpa = cmp.find((c) => c.metric === 'cpa')!;
    expect(cpa.leader_variant_id).toBe(variants[0]!.id);
    // 45 purchases on $270: CPA $6, stored as purchases over spend.
    const [row] = await ownerPool()`select successes::float8 as s, trials::float8 as t, raw_rate::float8 as raw, ci_low::float8 as lo, ci_high::float8 as hi
                                    from experiment_results where experiment_id = ${experimentId} and variant_id = ${variants[0]!.id} and metric = 'cpa'`;
    expect(row).toMatchObject({ s: 45, t: 270 });
    expect(row!.raw).toBeCloseTo(6);
    expect(row!.lo).toBeLessThan(row!.hi);

    // The data is corrected away: the comparisons go with it.
    await ownerPool()`update performance_observations set superseded_at = now() where variant_id = any(${variants.map((v) => v.id as string)}::uuid[])`;
    await withTenant(t.workspaceId, (tx) => computeResults(tx, ctx, experimentId));
    expect(await ownerPool()`select 1 from experiment_comparisons where experiment_id = ${experimentId}`).toHaveLength(0);
  }, 60_000);
});
