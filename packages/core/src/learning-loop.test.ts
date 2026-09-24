import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import type { NormalizedObservation } from '@arkiv/integrations';
import { analyzeProduct, startPreview } from './analysis';
import { clusterThemes, importSignals, parseReviewPaste } from './customer-language';
import { computeResults, createExperiment } from './experiments';
import { append, available } from './ledger';
import { purgeWorkspace, scheduleDeletion } from './lifecycle';
import { mockConcepts } from './mock-intel';
import { ingestObservations, parsePerformanceCsv } from './performance';
import { approveForProduction, produceProject } from './production';
import { generateRecommendations, refreshMaturity } from './recommendations';
import { generateStoryboard } from './storyboard';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';
import { produceHookVariants } from './variants';
import { diffCompositions, type CompositionManifest } from './composition';

beforeEach(truncateAll);
afterAll(closeAll);

function obs(adId: string, adName: string, date: string, impressions: number, clicks: number): NormalizedObservation {
  return {
    platform: 'meta', accountId: 'act_1', campaignId: 'c1', adgroupId: 'as1', adId, adName, date, currency: 'USD',
    spendMicros: impressions * 12_000, impressions, reach: null, frequency: null, clicks, outboundClicks: null,
    videoStarts: Math.round(impressions * 0.6), video25: null, video50: null, video75: Math.round(impressions * 0.1), video100: null, avgWatchMs: null,
    addToCart: null, checkout: null, purchases: Math.round(clicks * 0.03), purchaseValueMicros: Math.round(clicks * 0.03) * 38_000_000,
    attributionModel: 'meta_default', attributionWindow: '7d_click_1d_view', optimizationEvent: 'OFFSITE_CONVERSIONS', campaignType: 'OUTCOME_SALES',
    measurementContext: 'META_PAID_ATTRIBUTED',
  };
}

describe('learning loop (Phases 4–5)', () => {
  it('experiment → production → hook variants → performance → results → learning → recommendations', async () => {
    const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, current_period_start, current_period_end, consent_record_id)
                      values (${t.workspaceId}, 'sub_1', 'GROWTH', 'active', '2026-09-01', '2026-10-01', gen_random_uuid())`;
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId: previewProject } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    await analyzeProduct(ctx, skuId, previewProject);

    // Customer language → themes (never evidence).
    const signals = parseReviewPaste('review,rating\n"Love it but a bit sticky at first",4\n"Pills under my foundation",2\n"Absorbs fast, skin feels soft",5\n"So sticky in humid weather",3\nContact me at jo@example.com,5');
    expect(await withTenant(t.workspaceId, (tx) => importSignals(tx, ctx, skuId, signals))).toBe(5);
    const stored = await withTenant(t.workspaceId, (tx) => tx`select text from customer_signals where text like '%[email]%'`);
    expect(stored).toHaveLength(1); // PII redacted
    expect(await clusterThemes(ctx, skuId)).toBeGreaterThan(0);

    // Grant this period's Creative Tests and run one.
    await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 7, periodKey: '2026-09-01', idempotencyKey: 'grant:sub_1:2026-09-01' }));
    const proposal = mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;
    const { experimentId, projectId, storyboardId } = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal, slot: 'EXPAND' }));
    const [concept] = await ownerPool()`select selected_concept_id from projects where id = ${projectId}`;
    await generateStoryboard(ctx, projectId, storyboardId, concept!.selected_concept_id as string);
    await withTenant(t.workspaceId, (tx) => approveForProduction(tx, ctx, projectId, 'creative_test'));
    expect(await produceProject(ctx, projectId)).toBe('complete');
    expect(await produceHookVariants(ctx, projectId)).toBe(2);
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(6); // hook variants cost no extra test

    const variants = await withTenant(t.workspaceId, (tx) => tx`select id, code, label, creative_id from variants where experiment_id = ${experimentId} order by code`);
    expect(variants).toHaveLength(3);
    expect(variants.every((v) => v.creative_id)).toBe(true);

    // Hook variants hold everything but the hook constant (§20 CONTROLLED; exp-01, prod-24, prod-25): the master's
    // footage, its voice-over for every later scene, its end card and every export — only the opening changes.
    const comps = await ownerPool()`select v.code, v.label, c.composition, c.final_asset_ids from variants v join creatives c on c.id = v.creative_id
                                    where v.experiment_id = ${experimentId} order by v.code`;
    const master = comps[0]!.composition as CompositionManifest;
    expect(master.voiceover?.segments.length).toBeGreaterThan(1);
    for (const v of comps.slice(1)) {
      const m = v.composition as CompositionManifest;
      expect((v.final_asset_ids as string[]).length).toBe(3); // 9:16, 4:5 and 1:1
      expect(m.aspects).toEqual(['9x16', '4x5', '1x1']);
      expect(m.endCard).toEqual(master.endCard); // same end card (index included)
      expect(m.scenes.slice(1)).toEqual(master.scenes.slice(1));
      expect(m.scenes[0]!.assetId).toBe(master.scenes[0]!.assetId);
      expect(m.scenes[0]!.overlayText).toBe((v.label as string).slice(0, 60));
      const [hook, ...rest] = m.voiceover!.segments;
      const [masterHook, ...masterRest] = master.voiceover!.segments;
      expect(rest).toEqual(masterRest); // the body voice-over is the master's, clip for clip
      expect(hook!.text).toBe(v.label); // the spoken hook is re-voiced with the variant's hook
      expect(hook!.clipAssetId).not.toBe(masterHook!.clipAssetId);
      expect(hook!.startMs).toBe(masterHook!.startMs);
      expect(diffCompositions(master, m)).toEqual(['hook']);
    }
    const generated = await ownerPool()`select payload from events where workspace_id = ${t.workspaceId} and type = 'VARIANT_GENERATED' and subject_type = 'variant'`;
    expect(generated.map((e) => (e.payload as { changed: string[] }).changed)).toEqual([['hook'], ['hook']]);
    const [exp0] = await ownerPool()`select state, mode from experiments where id = ${experimentId}`;
    expect(exp0!.state).toBe('READY_TO_RUN');
    expect(exp0!.mode).toBe('CONTROLLED');

    // Meta data arrives; ad names carry the variant codes so ads auto-link. Variant B clearly wins on hold rate.
    const rows: NormalizedObservation[] = [];
    for (let d = 1; d <= 6; d++) {
      const date = `2026-09-${String(10 + d).padStart(2, '0')}`;
      rows.push(obs('ad-a', `Serum ${variants[0]!.code}`, date, 4000, 48));
      const b = obs('ad-b', `Serum ${variants[1]!.code} texture`, date, 4000, 60);
      b.video75 = Math.round(b.videoStarts! * 0.32);
      rows.push(b);
      rows.push(obs('ad-c', `Serum ${variants[2]!.code}`, date, 4000, 47));
    }
    await withTenant(t.workspaceId, (tx) => ingestObservations(tx, ctx, null, rows));
    const linked = await ownerPool()`select count(*)::int as n from performance_observations where variant_id is not null`;
    expect(linked[0]!.n).toBe(18);

    // A late conversion revision supersedes rather than overwrites (§45).
    const late = { ...rows[0]!, purchases: rows[0]!.purchases + 2 };
    const rev = await withTenant(t.workspaceId, (tx) => ingestObservations(tx, ctx, null, [late]));
    expect(rev.revised).toBe(1);

    const res = await withTenant(t.workspaceId, (tx) => computeResults(tx, ctx, experimentId));
    expect(res.state).toBe('ACTIONABLE');
    const learnings = await ownerPool()`select statement, state, scope_platform, do_not_generalize_to from learnings`;
    expect(learnings).toHaveLength(1);
    expect(learnings[0]!.scope_platform).toBe('meta');
    expect(learnings[0]!.do_not_generalize_to).toContain('tiktok');

    // Next week's recommendations use the new maturity and learning.
    expect(await withTenant(t.workspaceId, (tx) => refreshMaturity(tx, skuId))).toBe('DEVELOPING');
    expect(await generateRecommendations(ctx, skuId, '2026-09-21')).toBeGreaterThan(0);
    const recs = await ownerPool()`select slot, basis, score from recommendations where week_of = '2026-09-21'`;
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => Number(r.score) > 0)).toBe(true);
    expect(await generateRecommendations(ctx, skuId, '2026-09-21')).toBe(0); // idempotent per week
  }, 240_000);

  it('parses a manual performance CSV into its own measurement context', () => {
    const rows = parsePerformanceCsv('Date,Ad name,Ad ID,Impressions,Clicks,Spend,Purchases\n2026-09-20,AK-001-A,123,1000,20,$15.00,1');
    expect(rows[0]!.measurementContext).toBe('MERCHANT_IMPORTED');
    expect(rows[0]!.spendMicros).toBe(15_000_000);
  });

  it('purges a workspace after its grace period and keeps a certificate', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    await withTenant(t.workspaceId, (tx) => scheduleDeletion(tx, ctx));
    await expect(purgeWorkspace(t.workspaceId)).rejects.toMatchObject({ code: 'CONFLICT' }); // grace period
    await ownerPool()`update workspaces set purge_at = now() - interval '1 minute' where id = ${t.workspaceId}`;
    const counts = await purgeWorkspace(t.workspaceId);
    expect(counts.memberships).toBe(1);
    const cert = await withSystem((tx) => tx`select * from purge_certificates where workspace_id = ${t.workspaceId}`);
    expect(cert).toHaveLength(1);
    const [w] = await ownerPool()`select state from workspaces where id = ${t.workspaceId}`;
    expect(w!.state).toBe('PURGED');
  });
});
