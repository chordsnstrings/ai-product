import { describe, expect, it } from 'vitest';
import { baselineFrom, BASELINE_MIN_TRIALS, commercialVeto, compareCommercial, compareVariants, DEFAULT_BASELINES, MIN_EFFECT, nextLearningState, posterior, probAbove, probBest } from './statistics';

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

  it('without a control, ACTIONABLE needs a material lift over the runner-up (§21 commercial effect)', () => {
    // Huge volume: a 5% relative difference is statistically separable but too small to act on.
    const small = compareVariants('ctr', [
      { variantId: 'a', obs: { successes: 21_000, trials: 1_000_000 }, days: 10 },
      { variantId: 'b', obs: { successes: 20_000, trials: 1_000_000 }, days: 10 },
    ], DEFAULT_BASELINES.ctr, 50_000, null);
    expect(small.variants.find((v) => v.variantId === 'a')!.probBest).toBeGreaterThan(0.95);
    expect(small.lift!).toBeLessThan(MIN_EFFECT);
    expect(small.liftVsControl).toBeNull();
    expect(small.state).toBe('INCONCLUSIVE');
    expect(small.explanation).toMatch(/small/);
    // Too few days to call it equivalent: a lean, never actionable.
    const early = compareVariants('ctr', [
      { variantId: 'a', obs: { successes: 21_000, trials: 1_000_000 }, days: 4 },
      { variantId: 'b', obs: { successes: 20_000, trials: 1_000_000 }, days: 4 },
    ], DEFAULT_BASELINES.ctr, 50_000, null);
    expect(early.state).toBe('DIRECTIONAL');
    // A material lift over the runner-up is actionable.
    const big = compareVariants('ctr', [
      { variantId: 'a', obs: { successes: 360, trials: 20_000 }, days: 5 },
      { variantId: 'b', obs: { successes: 240, trials: 20_000 }, days: 5 },
    ], DEFAULT_BASELINES.ctr, 8_000, null);
    expect(big.state).toBe('ACTIONABLE');
    expect(big.lift!).toBeGreaterThan(MIN_EFFECT);
    expect(big.explanation).toMatch(/next best/);
  });

  it('compares CPA and ROAS with conversion and order-value uncertainty (§21)', () => {
    const r = compareCommercial([
      { variantId: 'cheap', spend: 1_000, purchases: 60, purchaseValue: 3_000, days: 10 },
      { variantId: 'dear', spend: 1_000, purchases: 30, purchaseValue: 1_500, days: 10 },
    ], 8_000)!;
    expect(r.cpa.leader).toBe('cheap');
    expect(r.cpa.state).toBe('ACTIONABLE');
    const cheap = r.cpa.variants.find((v) => v.variantId === 'cheap')!;
    expect(cheap.posterior.raw).toBeCloseTo(1000 / 60);
    expect(cheap.posterior.ciLow).toBeLessThan(cheap.posterior.mean);
    expect(cheap.posterior.ciHigh).toBeGreaterThan(cheap.posterior.mean);
    expect(r.roas.leader).toBe('cheap');
    // Seeded: reproducible.
    expect(compareCommercial([
      { variantId: 'cheap', spend: 1_000, purchases: 60, purchaseValue: 3_000, days: 10 },
      { variantId: 'dear', spend: 1_000, purchases: 30, purchaseValue: 1_500, days: 10 },
    ], 8_000)).toEqual(r);
    // A few purchases: too early, whatever the ratio.
    const early = compareCommercial([
      { variantId: 'a', spend: 40, purchases: 3, purchaseValue: 900, days: 2 },
      { variantId: 'b', spend: 40, purchases: 1, purchaseValue: 30, days: 2 },
    ], 8_000)!;
    expect(early.roas.state).toBe('GATHERING_SIGNAL');
    expect(early.roas.leader).toBeNull();
    expect(early.roas.explanation).toMatch(/more purchases/);
    // Fewer than two variants that spent: nothing to compare.
    expect(compareCommercial([{ variantId: 'a', spend: 10, purchases: 1, purchaseValue: 20, days: 1 }], 8_000)).toBeNull();
  });

  it('order-value variability widens ROAS more than CPA when purchases are few', () => {
    const r = compareCommercial([
      { variantId: 'a', spend: 500, purchases: 25, purchaseValue: 1_250, days: 8 },
      { variantId: 'b', spend: 500, purchases: 25, purchaseValue: 1_250, days: 8 },
    ], 8_000)!;
    const a = r.roas.variants.find((v) => v.variantId === 'a')!;
    const c = r.cpa.variants.find((v) => v.variantId === 'a')!;
    const relRoas = (a.posterior.ciHigh - a.posterior.ciLow) / a.posterior.mean;
    const relCpa = (c.posterior.ciHigh - c.posterior.ciLow) / c.posterior.mean;
    expect(relRoas).toBeGreaterThan(relCpa);
    expect(r.roas.state).not.toBe('ACTIONABLE');
  });

  it('a rate leader that probably costs more per purchase is vetoed', () => {
    const r = compareCommercial([
      { variantId: 'clicky', spend: 1_000, purchases: 30, purchaseValue: 1_500, days: 10 },
      { variantId: 'seller', spend: 1_000, purchases: 60, purchaseValue: 3_000, days: 10 },
    ], 8_000)!;
    expect(commercialVeto(r.cpa, 'clicky')).toMatch(/costs more per purchase/);
    expect(commercialVeto(r.cpa, 'seller')).toBeNull();
    expect(commercialVeto(null, 'clicky')).toBeNull();
    // Before the purchase floor the rate result stands.
    const early = compareCommercial([
      { variantId: 'clicky', spend: 100, purchases: 2, purchaseValue: 100, days: 3 },
      { variantId: 'seller', spend: 100, purchases: 9, purchaseValue: 450, days: 3 },
    ], 8_000)!;
    expect(commercialVeto(early.cpa, 'clicky')).toBeNull();
  });
});
