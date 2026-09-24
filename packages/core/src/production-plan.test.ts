import { afterAll, describe, expect, it } from 'vitest';
import { closeAll, globalTx } from '@arkiv/db';
import { COST_LIMITS } from '@arkiv/shared';
import { diffCompositions, type CompositionManifest } from './composition';
import { MAX_GENERATIVE_SCENES, normalizePlan } from './creative-director';
import type { StoryboardPlan } from './intel-schemas';
import { planProduction, productionRoutes, voiceLine } from './production';
import { qaExperimentIntegrity } from './qa';
import { customerQaSummary } from './qa-metrics';
import { estimate, loadRates, priceLine, type CostLine } from './rates';

afterAll(closeAll);

const scene = (id: string, mode: string, durationMs = 3000, extra: Record<string, unknown> = {}) => ({ id, production_mode: mode, duration_ms: durationMs, purpose: 'demonstration', ...extra });
const videoLines = (lines: CostLine[]) => lines.filter((l): l is Extract<CostLine, { kind: 'video' }> => l.kind === 'video');

async function pricing() {
  return globalTx(async (tx) => ({ routes: await productionRoutes(tx, null), rates: await loadRates(tx) }));
}

describe('Production Planner pricing (§5, §6, §37: arch-22)', () => {
  it('prices one render per generative scene with the 25% QA reserve — a 4-scene test stays under the ceiling', async () => {
    const { routes, rates } = await pricing();
    const scenes = ['a', 'b', 'c', 'd'].map((id) => scene(id, 'GENERATIVE_INTERACTION'));
    const plan = planProduction(scenes, 300, routes, rates, { ceilingMicros: COST_LIMITS.CREATIVE_TEST_CEILING });
    const videos = videoLines(plan.lines);
    expect(videos).toHaveLength(4); // never a second full render per scene
    expect(videos.every((v) => v.retryReserve !== false && v.seconds === 5)).toBe(true);
    expect(plan.reserveSeconds).toBe(5); // 25% of 20 generated seconds = one 5s repair
    const est = estimate(rates, plan.lines);
    expect(est.totalMicros).toBeLessThanOrEqual(COST_LIMITS.CREATIVE_TEST_CEILING);
    // The reserve inside the estimate is the Cost Governor's 25% of raw video cost.
    const raw = videos.reduce((t, v) => t + priceLine(rates, { ...v, retryReserve: false }).micros, 0);
    const withReserve = videos.reduce((t, v) => t + priceLine(rates, v).micros, 0);
    expect(withReserve - raw).toBeGreaterThanOrEqual(Math.floor(raw * COST_LIMITS.RETRY_RESERVE_FRACTION));
    expect(withReserve - raw).toBeLessThanOrEqual(Math.ceil(raw * COST_LIMITS.RETRY_RESERVE_FRACTION) + videos.length);
  });

  it('tops a small plan up to one funded repair, but never past the class ceiling', async () => {
    const { routes, rates } = await pricing();
    const one = planProduction([scene('a', 'GENERATIVE_INTERACTION')], 100, routes, rates, { ceilingMicros: COST_LIMITS.CREATIVE_TEST_CEILING });
    const [render, topUp] = videoLines(one.lines);
    expect(render!.seconds).toBe(5);
    expect(topUp).toMatchObject({ seconds: 3.75, retryReserve: false }); // 25% (1.25s) + 3.75s = one 5s repair
    expect(one.reserveSeconds).toBe(5);
    const tight = planProduction([scene('a', 'GENERATIVE_INTERACTION')], 100, routes, rates, { ceilingMicros: estimate(rates, [render!]).totalMicros + 1 });
    expect(videoLines(tight.lines)).toHaveLength(1);
    expect(tight.reserveSeconds).toBe(1.25);
  });

  it('does not price scenes whose accepted render is reused (§35)', async () => {
    const { routes, rates } = await pricing();
    const plan = planProduction([scene('a', 'GENERATIVE_INTERACTION'), scene('b', 'GENERATIVE_INTERACTION')], 0, routes, rates, { reuse: new Set(['a']) });
    expect(plan.generative).toEqual(['b']);
    expect(videoLines(plan.lines).filter((v) => v.retryReserve !== false)).toHaveLength(1);
  });

  it('prices voice at the dearer of the voice route and its approved fallback', async () => {
    const { routes, rates } = await pricing();
    expect(routes.tts).toHaveLength(2);
    const line = voiceLine(routes, rates, 1000);
    const prices = routes.tts.map((r) => priceLine(rates, { kind: 'tts', provider: r.provider, model: r.model, chars: 1000 }).micros);
    expect(priceLine(rates, line).micros).toBe(Math.max(...prices));
  });

  it('prices renders at the dearer of the video route and its approved fallback (§44: either may serve)', async () => {
    const { routes, rates } = await pricing();
    expect(routes.video).toHaveLength(1); // no fallback approved by default
    const primary = routes.video[0]!;
    const base = rates.get(`${primary.provider}/${primary.model}`)!;
    const dear = new Map(rates);
    dear.set(`${primary.provider}/pricier-video`, { ...base, model: 'pricier-video', rates: Object.fromEntries(Object.entries(base.rates).map(([k, v]) => [k, v * 2])) });
    const scenes = [scene('a', 'GENERATIVE_INTERACTION')];
    const alone = planProduction(scenes, 0, routes, dear);
    const withFallback = planProduction(scenes, 0, { ...routes, video: [primary, { provider: primary.provider, model: 'pricier-video' }] }, dear);
    expect(videoLines(alone.lines).every((v) => v.model === primary.model)).toBe(true);
    expect(videoLines(withFallback.lines).every((v) => v.model === 'pricier-video')).toBe(true);
    expect(estimate(dear, withFallback.lines).totalMicros).toBeGreaterThan(estimate(dear, alone.lines).totalMicros);
    // A fallback with no published rate can't serve a call, so it doesn't shape the price.
    const unpriced = planProduction(scenes, 0, { ...routes, video: [primary, { provider: primary.provider, model: 'unpriced-video' }] }, dear);
    expect(videoLines(unpriced.lines).every((v) => v.model === primary.model)).toBe(true);
  });

  it('caps generated-interaction scenes per 15s output and refuses a voice-over that cannot fit', () => {
    const s = (purpose: StoryboardPlan['scenes'][number]['purpose'], spokenLine: string | null = null): StoryboardPlan['scenes'][number] => ({ purpose, durationMs: 2500, visualPlan: 'x', productBehavior: null, spokenLine, overlayText: null, productionMode: 'GENERATIVE_INTERACTION', showsHumanSkin: false });
    const plan: StoryboardPlan = { hook: 'Hello', cta: 'Shop now', voiceover: '', scenes: [s('hook'), s('demonstration'), s('proof'), s('benefit'), s('routine'), s('problem')] };
    const n = normalizePlan(plan, []);
    expect(n.scenes.filter((x) => x.productionMode === 'GENERATIVE_INTERACTION')).toHaveLength(MAX_GENERATIVE_SCENES);
    expect(n.scenes.filter((x) => x.productionMode === 'HYBRID')).toHaveLength(6 - MAX_GENERATIVE_SCENES);
    const long = { ...plan, scenes: plan.scenes.map((x) => ({ ...x, spokenLine: 'one two three four five six seven eight nine ten' })) };
    expect(() => normalizePlan(long, [])).toThrow(/timing check/);
  });

  it('refuses a first-person customer line on a scene with an AI-generated person (standard §40)', () => {
    const s = (purpose: StoryboardPlan['scenes'][number]['purpose'], mode: StoryboardPlan['scenes'][number]['productionMode'], showsHumanSkin: boolean, spokenLine: string | null = null): StoryboardPlan['scenes'][number] => ({ purpose, durationMs: 3000, visualPlan: 'x', productBehavior: null, spokenLine, overlayText: null, productionMode: mode, showsHumanSkin });
    const plan = (demoLine: string, skin: boolean): StoryboardPlan => ({ hook: 'Hello', cta: 'Shop now', voiceover: '', scenes: [s('hook', 'STRICT_COMPOSITE', false), s('demonstration', 'GENERATIVE_INTERACTION', skin, demoLine), s('cta', 'STRICT_COMPOSITE', false)] });
    expect(() => normalizePlan(plan('I’ve used it for two weeks.', true), [])).toThrow(/testimonial check/);
    expect(normalizePlan(plan('Two drops, morning and night.', true), []).scenes).toHaveLength(3);
    expect(normalizePlan(plan('I’ve used it for two weeks.', false), []).scenes).toHaveLength(3); // no person shown
  });
});

const manifest = (): CompositionManifest => ({
  version: 1,
  skuId: 'sku',
  cutoutAssetId: 'cut',
  scenes: [
    { sceneId: 's1', position: 0, purpose: 'hook', kind: 'still', assetId: 'a1', versionId: 'v1', technique: 'exact_product_composite', overlayText: 'Hook A', spokenText: 'Hook A', durationMs: 3000, claimIds: [] },
    { sceneId: 's2', position: 1, purpose: 'demonstration', kind: 'video', assetId: 'a2', versionId: 'v2', technique: 'generative', overlayText: 'Absorbs', spokenText: 'Two drops.', durationMs: 4000, claimIds: [] },
  ],
  voiceover: {
    voice: 'warm_female',
    segments: [
      { sceneId: 's1', text: 'Hook A', clipAssetId: 'c1', startMs: 0, endMs: 1500, tempo: 1 },
      { sceneId: 's2', text: 'Two drops.', clipAssetId: 'c2', startMs: 3000, endMs: 4200, tempo: 1 },
    ],
  },
  captions: [],
  endCard: { productName: 'Serum', cta: 'Shop now', index: 'NO. 001', durationMs: 2000, sceneId: 's5', spokenText: 'Tap to try it.' },
  durationMs: 9000,
  aspects: ['9x16', '4x5', '1x1'],
  genes: { angle: 'TEXTURE_SENSORY' },
});

describe('experiment integrity from composition manifests (§20, §25 check 6: prod-24)', () => {
  const held = ['body', 'offer', 'cta', 'product', 'duration', 'scenes_2_plus', 'voiceover'];

  it('a hook variant that swaps only the opening passes', () => {
    const m = manifest();
    const v: CompositionManifest = {
      ...m,
      scenes: [{ ...m.scenes[0]!, overlayText: 'Hook B', spokenText: 'Hook B' }, m.scenes[1]!],
      voiceover: { ...m.voiceover!, segments: [{ ...m.voiceover!.segments[0]!, text: 'Hook B', clipAssetId: 'c9' }, m.voiceover!.segments[1]!] },
    };
    const changed = diffCompositions(m, v);
    expect(changed).toEqual(['hook']);
    expect(qaExperimentIntegrity({ changed: ['hook'], heldConstant: held }, { changed }).pass).toBe(true);
  });

  it('dropping the voice-over is caught as a leak of a held-constant component (the exp-01 confound)', () => {
    const m = manifest();
    const v: CompositionManifest = { ...m, scenes: [{ ...m.scenes[0]!, overlayText: 'Hook B' }, m.scenes[1]!], voiceover: null };
    const changed = diffCompositions(m, v);
    expect(changed).toContain('voiceover');
    const r = qaExperimentIntegrity({ changed: ['hook'], heldConstant: held }, { changed });
    expect(r).toMatchObject({ pass: false, hard: true });
    expect(r.detail).toMatch(/voiceover/);
  });

  it('a changed end-card index or body scene is a change to cta / body', () => {
    const m = manifest();
    expect(diffCompositions(m, { ...m, endCard: { ...m.endCard, index: 'AK-001-B' } })).toEqual(['cta']);
    expect(diffCompositions(m, { ...m, scenes: [m.scenes[0]!, { ...m.scenes[1]!, assetId: 'other' }] })).toEqual(['body', 'scenes_2_plus']);
    expect(diffCompositions(m, m)).toEqual([]);
  });
});

describe('customer QA summary (plan 03 P10: prod-38)', () => {
  it('names each kind of check in customer words, with the claims count', () => {
    const rows = customerQaSummary({
      pass: true,
      checks: [
        { check: 'product_fidelity', pass: true, hard: false, detail: 'Scene 2: Product matches reference' },
        { check: 'visual', pass: true, hard: false, detail: 'ok' },
        { check: 'claims', pass: true, hard: false, detail: '8 lines', data: { claimsUsed: 3 } },
        { check: 'platform', pass: true, hard: false, detail: '1080x1920' },
        { check: 'audio', pass: true, hard: false, detail: 'ok' },
        { check: 'experiment_integrity', pass: true, hard: false, detail: 'Standalone production (no controlled comparison)' },
        { check: 'asset_integrity', pass: true, hard: false, detail: 'ok' },
      ],
    });
    expect(rows.map((r) => r.label)).toEqual(['Product accuracy', 'Claims: 3 used, all verified', 'Visual quality', 'Voice and audio', 'Platform formats and safe zones', 'Files stored and verified']);
    expect(rows.every((r) => r.ok)).toBe(true);
    expect(customerQaSummary(null)).toEqual([]);
    expect(customerQaSummary({ checks: [{ check: 'product_fidelity', pass: false, hard: false, detail: 'drift' }] })).toEqual([{ label: 'Product accuracy', ok: false }]);
  });
});
