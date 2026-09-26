import { describe, expect, it } from 'vitest';
import { baselineFrom, BASELINE_MIN_TRIALS, compareVariants, DEFAULT_BASELINES, nextLearningState, posterior, probAbove, probBest } from './statistics';

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

  it('shrinks toward the SKU baseline, else the account, else the default assumption (§21)', () => {
    const def = DEFAULT_BASELINES.hold_rate;
    // No pool past the floor: the default.
    expect(baselineFrom('hold_rate', [{ level: 'sku', successes: 10, trials: 100 }])).toMatchObject({ rate: def.rate, strength: def.strength, level: 'default' });
    // The account has volume, the SKU too little: the account's rate, strength proportional to its volume.
    const acct = baselineFrom('hold_rate', [{ level: 'sku', successes: 10, trials: 100 }, { level: 'account', successes: 2_000, trials: 6_000 }]);
    expect(acct.level).toBe('account');
    expect(acct.rate).toBeCloseTo(1 / 3);
    expect(acct.strength).toBe(def.strength); // capped: never more weight than the default assumption
    // Strength grows with the pool's volume below the cap.
    expect(baselineFrom('cvr', [{ level: 'account', successes: 30, trials: 1_000 }])).toMatchObject({ level: 'account', rate: 0.03, strength: 100 });
    // The SKU has enough of its own: it wins, and a huge pool never outweighs the default strength.
    const sku = baselineFrom('hold_rate', [{ level: 'sku', successes: 30_000, trials: 100_000 }, { level: 'account', successes: 2_000, trials: 6_000 }]);
    expect(sku).toMatchObject({ level: 'sku', rate: 0.3, strength: def.strength });
    expect(BASELINE_MIN_TRIALS.ctr).toBeGreaterThan(BASELINE_MIN_TRIALS.cvr);
    // The same small sample lands nearer a high account baseline than the default one.
    const obs = { successes: 20, trials: 200 };
    expect(posterior(obs, acct).mean).toBeGreaterThan(posterior(obs, def).mean);
  });

  it('P(winner genes beat loser genes) is high when the winner carries the lead and low when it flips', () => {
    const strong = posterior({ successes: 900, trials: 3_000 }, DEFAULT_BASELINES.hold_rate);
    const weak = posterior({ successes: 500, trials: 3_000 }, DEFAULT_BASELINES.hold_rate);
    expect(probAbove([strong], [weak])).toBeGreaterThan(0.99);
    expect(probAbove([weak], [strong])).toBeLessThan(0.01);
    expect(probAbove([weak, strong], [weak])).toBeGreaterThan(0.99); // best of the winners
    expect(probAbove([], [weak])).toBe(0.5); // nothing to compare
  });
});
