import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import type { NormalizedObservation } from '@arkiv/integrations';
import { analyzeProduct, startPreview } from './analysis';
import { clusterThemes, importSignals, parseReviewPaste } from './customer-language';
import { updateBrandBrain } from './brand';
import { approveExperiment, computeResults, createExperiment } from './experiments';
import { append, available } from './ledger';
import { purgeWorkspace, scheduleDeletion } from './lifecycle';
import { mockConcepts } from './mock-intel';
import { ingestObservations, parsePerformanceCsv } from './performance';
import { produceProject } from './production';
import { generateRecommendations, recommendationsForSku, refreshMaturity } from './recommendations';
import { generateStoryboard } from './storyboard';
import { ctxFor, eventContractProblems, productPhoto } from './testing';
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
    // The Brand Brain's colour and mandatory disclosure go on every export's end card (§16).
    await withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { name: 'Test Brand', colors: ['#AA3355', 'not-a-colour'], disclosures: 'Results vary. Patch test first.', cta: 'Get yours' }));
    expect((await ownerPool()`select state from experiments where id = ${experimentId}`)[0]!.state).toBe('DRAFT');
    await withTenant(t.workspaceId, (tx) => approveExperiment(tx, ctx, experimentId));
    expect((await ownerPool()`select state from experiments where id = ${experimentId}`)[0]!.state).toBe('PRODUCING');
    expect(await produceProject(ctx, projectId)).toBe('complete');
    const [masterComp] = await ownerPool()`select c.composition from projects p join creatives c on c.id = p.final_creative_id where p.id = ${projectId}`;
    expect((masterComp!.composition as CompositionManifest).endCard).toMatchObject({ accent: '#AA3355', note: 'Results vary. Patch test first.' });
    // Two deliveries of the job at once (a pg-boss retry after expiry while the first run is still going, or a
    // staff retry): the variants are made once; a later redelivery makes nothing (x-races-23).
    const runs = await Promise.all([produceHookVariants(ctx, projectId), produceHookVariants(ctx, projectId)]);
    expect(runs.sort()).toEqual([0, 2]);
    expect(await produceHookVariants(ctx, projectId)).toBe(0);
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(6); // hook variants cost no extra test
    const [proj] = await ownerPool()`select final_creative_id from projects where id = ${projectId}`;
    expect((await ownerPool()`select count(*)::int as n from creatives where parent_creative_id = ${proj!.final_creative_id}`)[0]!.n).toBe(2);
    expect((await ownerPool()`select count(*)::int as n from events where workspace_id = ${t.workspaceId} and type = 'VARIANT_GENERATED'`)[0]!.n).toBe(3);
    // Each hook variant is a new version of the master (Appendix B: CREATIVE_VERSIONED), with what changed.
    const versioned = await ownerPool()`select e.subject_id, e.payload, e.refs, c.parent_creative_id from events e join creatives c on c.id = e.subject_id
                                        where e.workspace_id = ${t.workspaceId} and e.type = 'CREATIVE_VERSIONED' order by e.seq`;
    expect(versioned).toHaveLength(2);
    for (const e of versioned) {
      expect(e.parent_creative_id).toBe(proj!.final_creative_id);
      expect(e.payload).toMatchObject({ parentCreativeId: proj!.final_creative_id, changedVariables: ['hook'], projectId });
      expect(e.refs).toMatchObject({ creativeId: e.subject_id, skuId, experimentId, projectId });
    }
    // Variants reuse the master's media, so they carry its AI-content disclosure (standard §40).
    const flags = await ownerPool()`select ai_generated, synthetic_people from creatives where parent_creative_id = ${proj!.final_creative_id}`;
    expect(flags.every((f) => f.ai_generated === true && f.synthetic_people === true)).toBe(true);
    // …and the master's provenance (§25.7), with their own voice clips and composer.
    const pv = await ownerPool()`select a.lineage->'provenance' as pv, a.lineage->>'variantId' as variant from creatives c join assets a on a.id = any(c.final_asset_ids)
                                 where c.parent_creative_id = ${proj!.final_creative_id}`;
    const [masterPv] = await ownerPool()`select a.lineage->'provenance' as pv from creatives c join assets a on a.id = c.final_asset_ids[1] where c.id = ${proj!.final_creative_id}`;
    expect(pv.length).toBeGreaterThan(0);
    for (const r of pv) {
      expect(r.pv).toMatchObject({ authorizationId: (masterPv!.pv as { authorizationId: string }).authorizationId, sceneVersionIds: (masterPv!.pv as { sceneVersionIds: string[] }).sceneVersionIds, composer: expect.stringMatching(/^composer@/) });
    }

    const variants = await withTenant(t.workspaceId, (tx) => tx`select v.id, v.code, v.label, v.creative_id, v.platform_assets, c.final_asset_ids from variants v join creatives c on c.id = v.creative_id where v.experiment_id = ${experimentId} order by v.code`);
    expect(variants).toHaveLength(3);
    expect(variants.every((v) => v.creative_id)).toBe(true);
    // Variant.platform_assets[] (§20): master and hook variants list their exports per placement — 9:16 for TikTok
    // and Reels, 4:5 and 1:1 for the feed — each one of the variant's own exports.
    for (const v of variants) {
      const pa = v.platform_assets as { platform: string; aspect: string; assetId: string }[];
      expect(pa.map((x) => `${x.platform}:${x.aspect}`)).toEqual(['TIKTOK:9x16', 'INSTAGRAM_REELS:9x16', 'FACEBOOK_FEED:4x5', 'FACEBOOK_FEED:1x1']);
      expect(pa.every((x) => (v.final_asset_ids as string[]).includes(x.assetId))).toBe(true);
    }

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
    const generated = await ownerPool()`select payload from events where workspace_id = ${t.workspaceId} and type = 'VARIANT_GENERATED' and subject_type = 'variant' and payload->>'master' is null`;
    expect(generated.map((e) => (e.payload as { changed: string[] }).changed)).toEqual([['hook'], ['hook']]);
    // The master is the experiment's first variant; every variant event carries its experiment, SKU and creative.
    const lineage = await ownerPool()`select subject_id, refs from events where workspace_id = ${t.workspaceId} and type = 'VARIANT_GENERATED' order by seq`;
    expect(lineage).toHaveLength(3);
    expect(lineage.every((e) => (e.refs as Record<string, string>).experimentId === experimentId && (e.refs as Record<string, string>).skuId === skuId && !!(e.refs as Record<string, string>).creativeId)).toBe(true);
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
    const recs = await ownerPool()`select slot, basis, score from recommendations where week_of = '2026-09-21' and status = 'open'`;
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => Number(r.score) > 0)).toBe(true);
    // Candidates a hard gate refused are kept for staff with their reasons, scored 0 and never shown (§20).
    const gated = await ownerPool()`select score, gates from recommendations where week_of = '2026-09-21' and status = 'gated'`;
    expect(gated.every((g) => Number(g.score) === 0 && (g.gates as { passed: boolean; reasons: string[] }).reasons.length > 0)).toBe(true);
    // §38: every recommendation carries rationale ids (resolvable to packet items) and a confidence.
    const listed = await withTenant(t.workspaceId, (tx) => recommendationsForSku(tx, skuId, { sinceWeek: '2026-09-21' }));
    expect(listed.length).toBe(recs.length);
    for (const r of listed) {
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.rationaleIds.length).toBeGreaterThan(0);
      expect(r.rationale.length).toBe(r.rationaleIds.length);
    }
    expect(listed.flatMap((r) => r.rationale.map((i) => i.kind))).toContain('fact');
    expect(await generateRecommendations(ctx, skuId, '2026-09-21')).toBe(0); // idempotent per week
    // Every event of the whole loop carries its subject type and required object refs (§36).
    expect(await eventContractProblems(t.workspaceId)).toEqual([]);
  }, 240_000);

  it('parses a manual performance CSV into its own per-platform measurement context', () => {
    const rows = parsePerformanceCsv('Date,Ad name,Ad ID,Impressions,Clicks,Spend,Purchases\n2026-09-20,AK-001-A,123,1000,20,$15.00,1', 'meta');
    expect(rows[0]).toMatchObject({ platform: 'meta', measurementContext: 'MERCHANT_IMPORTED_META', spendMicros: 15_000_000 });
    const tt = parsePerformanceCsv('By Day,Ad name,Ad ID,Ad group name,Impressions,Clicks (destination),Cost,Complete payment\n2026-09-20,AK-001-B,777,Group 1,900,12,9.50,2', 'tiktok');
    expect(tt[0]).toMatchObject({ platform: 'tiktok', measurementContext: 'MERCHANT_IMPORTED_TIKTOK', spendMicros: 9_500_000, clicks: 12, purchases: 2, date: '2026-09-20' });
    // A TikTok export uploaded as Meta (or the reverse) is refused, as is a row naming the other platform.
    expect(() => parsePerformanceCsv('By Day,Ad name,Ad group name,Cost\n2026-09-20,x,g,1', 'meta')).toThrow(/TikTok Ads Manager export/);
    expect(() => parsePerformanceCsv('Reporting starts,Ad name,Amount spent (USD)\n2026-09-20,x,1', 'tiktok')).toThrow(/Meta Ads Manager export/);
    expect(() => parsePerformanceCsv('Date,Platform,Ad name,Spend\n2026-09-20,TikTok,x,1', 'meta')).toThrow(/Upload each platform/);
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
