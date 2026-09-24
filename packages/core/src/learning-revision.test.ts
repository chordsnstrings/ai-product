import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import type { NormalizedObservation } from '@arkiv/integrations';
import { computeResults, createExperiment, markConfounder } from './experiments';
import { mockConcepts } from './mock-intel';
import { ingestObservations, parsePerformanceCsv } from './performance';
import { ctxFor } from './testing';

/**
 * §45 "Platform reports late conversions: confidence and learning may revise retrospectively with audit trail";
 * §48 "Source data is backfilled or corrected: allow Learnings to weaken or invalidate without rewriting history";
 * §45 "Offer changed mid-test: learning may become OPERATIONALLY_CONFOUNDED".
 */
beforeEach(truncateAll);
afterAll(closeAll);

const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

function obs(adId: string, adName: string, date: string, holdShare: number): NormalizedObservation {
  const impressions = 4000;
  const videoStarts = Math.round(impressions * 0.6);
  return {
    platform: 'meta', accountId: 'act_1', campaignId: 'c1', adgroupId: 'as1', adId, adName, date, currency: 'USD',
    spendMicros: impressions * 12_000, impressions, reach: null, frequency: null, clicks: 48, outboundClicks: null,
    videoStarts, video25: null, video50: null, video75: Math.round(videoStarts * holdShare), video100: null, avgWatchMs: null,
    addToCart: null, checkout: null, purchases: 1, purchaseValueMicros: 38_000_000,
    attributionModel: 'meta_default', attributionWindow: '7d_click_1d_view', optimizationEvent: 'OFFSITE_CONVERSIONS', campaignType: 'OUTCOME_SALES',
    measurementContext: 'META_PAID_ATTRIBUTED',
  };
}

async function runningExperiment() {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const skuId = await makeSku(t.workspaceId);
  const proposal = mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;
  const { experimentId } = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal, slot: 'EXPAND' }));
  // Produced and ready (production itself is covered by the learning-loop test): only a live test receives results.
  await ownerPool()`update experiments set state = 'READY_TO_RUN' where id = ${experimentId}`;
  const variants = await ownerPool()`select id, code from variants where experiment_id = ${experimentId} order by code`;
  /** Six days of data; `hold` gives each variant's hold rate (share of starts reaching 75%). */
  const ingest = (hold: [number, number, number]) => {
    const rows: NormalizedObservation[] = [];
    for (let d = 1; d <= 6; d++) variants.forEach((v, i) => rows.push(obs(`ad-${i}`, `Serum ${v.code}`, day(d + 1), hold[i]!)));
    return withTenant(t.workspaceId, (tx) => ingestObservations(tx, ctx, null, rows));
  };
  const compute = () => withTenant(t.workspaceId, (tx) => computeResults(tx, ctx, experimentId));
  const learnings = () => ownerPool()`select id, state, leader_variant_id, confounded, history from learnings where sku_id = ${skuId} order by created_at`;
  return { t, ctx, skuId, experimentId, variants, ingest, compute, learnings };
}

describe('learnings revise with corrected data', () => {
  it('a backfill that flips the winner invalidates the old learning and records the new one', async () => {
    const x = await runningExperiment();
    await x.ingest([0.1, 0.32, 0.1]);
    expect((await x.compute()).state).toBe('ACTIONABLE');
    const [first] = await x.learnings();
    expect(first).toMatchObject({ state: 'ACTIONABLE', leader_variant_id: x.variants[1]!.id });

    // Corrected numbers arrive: the lead was C's all along.
    const r = await x.ingest([0.1, 0.1, 0.32]);
    expect(r.revised).toBeGreaterThan(0);
    await x.compute();
    const after = await x.learnings();
    const old = after.find((l) => l.id === first!.id)!;
    expect(old.state).toBe('INVALIDATED');
    // History is appended, never rewritten.
    expect((old.history as { to: string }[]).map((h) => h.to)).toEqual(['ACTIONABLE', 'INVALIDATED']);
    const replacement = after.find((l) => l.leader_variant_id === x.variants[2]!.id)!;
    expect(replacement.state).toBe('ACTIONABLE');
    expect(await ownerPool()`select 1 from events where type = 'LEARNING_INVALIDATED' and subject_id = ${first!.id}`).toHaveLength(1);
  });

  it('a correction that erases the lead weakens the learning', async () => {
    const x = await runningExperiment();
    await x.ingest([0.1, 0.32, 0.1]);
    await x.compute();
    const [first] = await x.learnings();
    await x.ingest([0.16, 0.1, 0.16]); // B no longer leads; nothing clearly does
    await x.compute();
    const revised = (await x.learnings()).find((l) => l.id === first!.id)!;
    expect(['WEAKENING', 'INVALIDATED']).toContain(revised.state);
    expect(await ownerPool()`select 1 from events where type in ('LEARNING_WEAKENED','LEARNING_INVALIDATED') and subject_id = ${first!.id}`).not.toHaveLength(0);
  });

  it('an operationally confounded period neither creates nor strengthens learnings, and marks the existing one', async () => {
    const x = await runningExperiment();
    await x.ingest([0.1, 0.32, 0.1]);
    await withTenant(x.t.workspaceId, (tx) => markConfounder(tx, x.ctx, { skuId: x.skuId, kind: 'offer_change', startsAt: day(0) }));
    expect((await x.compute()).state).toBe('OPERATIONALLY_CONFOUNDED');
    expect(await x.learnings()).toHaveLength(0); // never created from a confounded result

    // A learning from before the offer change is flagged, not strengthened.
    await ownerPool()`delete from confounders`;
    await x.compute();
    const [l] = await x.learnings();
    expect(l).toMatchObject({ state: 'ACTIONABLE', confounded: false });
    await withTenant(x.t.workspaceId, (tx) => markConfounder(tx, x.ctx, { skuId: x.skuId, kind: 'offer_change', startsAt: day(0) }));
    await x.compute();
    const [after] = await x.learnings();
    // The offer change is also a change of context (§21): the learning weakens and is scheduled for revalidation.
    expect(after).toMatchObject({ id: l!.id, state: 'WEAKENING', confounded: true });
    expect(await x.learnings()).toHaveLength(1);
  });
});

describe('CSV imports stay per platform (§48 "never average into one universal result")', () => {
  it('keeps a variant’s Meta and TikTok CSV rows in separate results and scopes each learning to its platform', async () => {
    const x = await runningExperiment();
    const csv = (platform: 'meta' | 'tiktok', hold: [number, number, number]) => {
      const head = platform === 'meta' ? 'Day,Ad name,Ad ID,Impressions,Link clicks,Amount spent (USD),Purchases,3-second video plays,Video plays at 75%' : 'By Day,Ad name,Ad ID,Impressions,Clicks (destination),Cost,Complete payment,Video views,Video views at 75%';
      const lines = [head];
      for (let d = 1; d <= 6; d++) x.variants.forEach((v, i) => lines.push(`${day(d + 1)},Serum ${v.code},${platform}-${i},4000,48,48.00,1,2400,${Math.round(2400 * hold[i]!)}`));
      return parsePerformanceCsv(lines.join('\n'), platform);
    };
    // B wins on Meta, C wins on TikTok: pooling them would hide both.
    await withTenant(x.t.workspaceId, (tx) => ingestObservations(tx, x.ctx, null, [...csv('meta', [0.1, 0.32, 0.1]), ...csv('tiktok', [0.1, 0.1, 0.32])]));
    await x.compute();
    const results = await ownerPool()`select distinct measurement_context from experiment_results where experiment_id = ${x.experimentId} order by 1`;
    expect(results.map((r) => r.measurement_context)).toEqual(['MERCHANT_IMPORTED_META', 'MERCHANT_IMPORTED_TIKTOK']);
    const obsPlatforms = await ownerPool()`select distinct platform, measurement_context from performance_observations order by 1`;
    expect(obsPlatforms).toEqual([{ platform: 'meta', measurement_context: 'MERCHANT_IMPORTED_META' }, { platform: 'tiktok', measurement_context: 'MERCHANT_IMPORTED_TIKTOK' }]);

    const ls = await ownerPool()`select scope_platform, measurement_context, do_not_generalize_to, leader_variant_id from learnings where sku_id = ${x.skuId} order by scope_platform`;
    expect(ls).toEqual([
      { scope_platform: 'meta', measurement_context: 'MERCHANT_IMPORTED_META', do_not_generalize_to: ['tiktok', 'other_skus'], leader_variant_id: x.variants[1]!.id },
      { scope_platform: 'tiktok', measurement_context: 'MERCHANT_IMPORTED_TIKTOK', do_not_generalize_to: ['meta', 'other_skus'], leader_variant_id: x.variants[2]!.id },
    ]);
  });
});

describe('organic and affiliate delivery (§48 no paid-spend context)', () => {
  it('a CSV of organic posts gets its own context and never picks a paid winner or creates a learning', async () => {
    const x = await runningExperiment();
    const head = 'Day,Ad name,Ad ID,Impressions,Link clicks,Amount spent (USD),Purchases,3-second video plays,Video plays at 75%';
    const lines = [head];
    for (let d = 1; d <= 6; d++) x.variants.forEach((v, i) => lines.push(`${day(d + 1)},Serum ${v.code},post-${i},4000,48,0,1,2400,${Math.round(2400 * [0.1, 0.32, 0.1][i]!)}`));
    const rows = parsePerformanceCsv(lines.join('\n'), 'meta', { source: 'organic' });
    expect(new Set(rows.map((r) => r.measurementContext))).toEqual(new Set(['META_ORGANIC']));
    expect(parsePerformanceCsv(lines.join('\n'), 'meta', { source: 'affiliate' })[0]!.measurementContext).toBe('META_AFFILIATE');
    await withTenant(x.t.workspaceId, (tx) => ingestObservations(tx, x.ctx, null, rows));
    const r = await x.compute();
    // Stored and shown as its own panel …
    const ctxs = await ownerPool()`select distinct measurement_context from experiment_results where experiment_id = ${x.experimentId}`;
    expect(ctxs.map((c) => c.measurement_context)).toEqual(['META_ORGANIC']);
    // … but it does not move the paid test or teach a paid learning.
    expect(r.state).toBe('GATHERING_SIGNAL');
    expect(await x.learnings()).toHaveLength(0);
  });
});
