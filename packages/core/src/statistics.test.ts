import { describe, expect, it } from 'vitest';
import { compareVariants, DEFAULT_BASELINES, nextLearningState, posterior, probBest } from './statistics';

describe('statistics (§21, §45)', () => {
  it('shrinks a tiny sample toward the baseline (no false winner)', () => {
    const p = posterior({ successes: 3, trials: 40 }, DEFAULT_BASELINES.ctr); // raw 7.5% CTR
    expect(p.raw).toBeCloseTo(0.075);
    expect(p.mean).toBeLessThan(0.02);
  });

  it('tiny spend + high ROAS style result stays GATHERING_SIGNAL', () => {
    const r = compareVariants('ctr', [
      { variantId: 'a', obs: { successes: 9, trials: 300 }, days: 1 },
      { variantId: 'b', obs: { successes: 2, trials: 310 }, days: 1 },
    ], DEFAULT_BASELINES.ctr, 5_000, 'b');
    expect(r.state).toBe('GATHERING_SIGNAL');
    expect(r.leader).toBeNull();
    expect(r.explanation).toMatch(/Too early/);
  });

  it('declares ACTIONABLE only with floors met, high P(best) and a material lift', () => {
    const r = compareVariants('ctr', [
      { variantId: 'control', obs: { successes: 240, trials: 20_000 }, days: 5 },
      { variantId: 'texture', obs: { successes: 360, trials: 20_000 }, days: 5 },
    ], DEFAULT_BASELINES.ctr, 8_000, 'control');
    expect(r.state).toBe('ACTIONABLE');
    expect(r.leader).toBe('texture');
    expect(r.liftVsControl!).toBeGreaterThan(0.1);
  });

  it('is DIRECTIONAL when the lead is real but not decisive', () => {
    const r = compareVariants('ctr', [
      { variantId: 'control', obs: { successes: 120, trials: 10_500 }, days: 4 },
      { variantId: 'v', obs: { successes: 138, trials: 10_400 }, days: 4 },
    ], DEFAULT_BASELINES.ctr, 8_000, 'control');
    expect(r.state).toBe('DIRECTIONAL');
  });

  it('is reproducible (seeded)', () => {
    const posts = [posterior({ successes: 50, trials: 1000 }, DEFAULT_BASELINES.ctr), posterior({ successes: 60, trials: 1000 }, DEFAULT_BASELINES.ctr)];
    expect(probBest(posts)).toEqual(probBest(posts));
  });

  it('weakens then invalidates contradicted learnings', () => {
    expect(nextLearningState('ACTIONABLE', 0.2, false)).toBe('WEAKENING');
    expect(nextLearningState('WEAKENING', 0.2, false)).toBe('INVALIDATED');
    expect(nextLearningState('ACTIONABLE', 0.01, true)).toBe('INVALIDATED');
    expect(nextLearningState('DIRECTIONAL', 0.97, true)).toBe('ACTIONABLE');
  });
});
