import { describe, expect, it } from 'vitest';
import { fitCeiling, planSceneModes, type PlannerFacts, type PlannerScene } from './production-planner';

/** Production Planner (standard §23 "chooses the medium scene by scene"; prod-01). */
const facts: PlannerFacts = { transparency: 'opaque', referenceViews: 1, keyedCutout: true, videoAvailable: true, remixFootage: false };
const scene = (purpose: string, productionMode: string, durationMs = 3000): PlannerScene => ({ purpose, productionMode, durationMs });

describe('Production Planner', () => {
  it('keeps packaging and CTA shots on the exact product, whatever was proposed', () => {
    const p = planSceneModes([scene('product_reveal', 'GENERATIVE_INTERACTION'), scene('cta', 'HYBRID')], facts);
    expect(p.map((x) => x.mode)).toEqual(['STRICT_COMPOSITE', 'STRICT_COMPOSITE']);
    expect(p[0]!.reason).toMatch(/exact product/);
  });

  it('keeps a short hands-on beat generated, and says why', () => {
    const [p] = planSceneModes([scene('demonstration', 'GENERATIVE_INTERACTION', 4000)], facts);
    expect(p).toMatchObject({ mode: 'GENERATIVE_INTERACTION', reason: expect.stringMatching(/checked against your product photos/) });
  });

  it('transparent packaging with too few views is composited, not generated (§44)', () => {
    const [p] = planSceneModes([scene('demonstration', 'GENERATIVE_INTERACTION')], { ...facts, transparency: 'transparent' });
    expect(p).toMatchObject({ mode: 'STRICT_COMPOSITE', reason: expect.stringMatching(/transparent packaging/) });
    const [enough] = planSceneModes([scene('demonstration', 'GENERATIVE_INTERACTION')], { ...facts, transparency: 'transparent', referenceViews: 3 });
    expect(enough!.mode).toBe('GENERATIVE_INTERACTION');
  });

  it('long beats, an unavailable video partner and unmakeable modes become hybrids with their reason', () => {
    const p = planSceneModes(
      [scene('demonstration', 'GENERATIVE_INTERACTION', 7000), scene('routine', 'REAL_ASSET_REMIX'), scene('proof', 'HYBRID')],
      facts,
    );
    expect(p.map((x) => x.mode)).toEqual(['HYBRID', 'HYBRID', 'HYBRID']);
    expect(p[0]!.reason).toMatch(/short beats/);
    expect(p[1]!.reason).toMatch(/no rights-cleared footage/);
    const [down] = planSceneModes([scene('demonstration', 'GENERATIVE_INTERACTION')], { ...facts, videoAvailable: false });
    expect(down).toMatchObject({ mode: 'HYBRID', reason: expect.stringMatching(/video partner is unavailable/) });
    const [remix] = planSceneModes([scene('routine', 'REAL_ASSET_REMIX')], { ...facts, remixFootage: true });
    expect(remix).toMatchObject({ mode: 'HYBRID', reason: expect.stringMatching(/isn’t available in this ad yet/) });
  });

  it('sheds the lowest-priority generated scenes, one at a time, until the plan fits its ceiling', () => {
    const scenes = [scene('hook', 'GENERATIVE_INTERACTION'), scene('demonstration', 'GENERATIVE_INTERACTION'), scene('problem', 'GENERATIVE_INTERACTION'), scene('cta', 'STRICT_COMPOSITE')];
    const planned = planSceneModes(scenes, facts);
    // Each generated scene costs 1.0, everything else nothing.
    const cost = (modes: readonly string[]) => modes.filter((m) => m === 'GENERATIVE_INTERACTION').length;
    const fitted = fitCeiling(scenes, planned, cost, 1, facts);
    expect(fitted.map((x) => x.mode)).toEqual(['HYBRID', 'GENERATIVE_INTERACTION', 'HYBRID', 'STRICT_COMPOSITE']);
    expect(fitted[0]!.reason).toMatch(/cost limit/);
    expect(fitCeiling(scenes, planned, cost, null, facts)).toEqual(planned);
    // Nothing left to shed: the plan is returned as is (the Cost Governor refuses it at approval).
    expect(fitCeiling(scenes, planned, () => 99, 1, facts).filter((x) => x.mode === 'GENERATIVE_INTERACTION')).toHaveLength(0);
  });
});
