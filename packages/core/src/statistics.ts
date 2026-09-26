import type { SignalState } from '@arkiv/shared';

/**
 * StatisticsService (§21). Deterministic — never LLM intuition.
 *  - Rate metrics (CTR, hold rate, CVR) use Beta-Binomial shrinkage toward the recent SKU/account/platform
 *    baseline so tiny samples cannot produce false winners (§45 "tiny spend but high ROAS").
 *  - Evidence floors scale with account volume.
 *  - States: GATHERING_SIGNAL → DIRECTIONAL → ACTIONABLE, and WEAKENING / INVALIDATED for existing learnings.
 * Seeded sampling keeps results reproducible (§41).
 */

export type RateMetric = 'ctr' | 'hold_rate' | 'cvr';

export interface Baseline {
  rate: number;
  /** Prior strength in pseudo-trials: how much we trust the baseline (higher = more shrinkage). */
  strength: number;
}

export interface RateObs {
  successes: number;
  trials: number;
}

export interface Posterior {
  alpha: number;
  beta: number;
  mean: number;
  ciLow: number;
  ciHigh: number;
  raw: number | null;
}

/**
 * Default baselines for US DTC skincare paid social, used only when neither the SKU nor the account has enough
 * recent volume in the measurement context (baselineFrom).
 */
export const DEFAULT_BASELINES: Record<RateMetric, Baseline> = {
  ctr: { rate: 0.012, strength: 2000 },
  hold_rate: { rate: 0.18, strength: 400 },
  cvr: { rate: 0.025, strength: 300 },
};

export function posterior(obs: RateObs, base: Baseline): Posterior {
  const a0 = Math.max(0.5, base.rate * base.strength);
  const b0 = Math.max(0.5, (1 - base.rate) * base.strength);
  const alpha = a0 + obs.successes;
  const beta = b0 + Math.max(0, obs.trials - obs.successes);
  const mean = alpha / (alpha + beta);
  const [ciLow, ciHigh] = betaInterval(alpha, beta, 0.9);
  return { alpha, beta, mean, ciLow, ciHigh, raw: obs.trials > 0 ? obs.successes / obs.trials : null };
}

/** Normal approximation of the Beta quantiles (adequate for alpha, beta > ~5; clamped to [0,1]). */
export function betaInterval(alpha: number, beta: number, level: number): [number, number] {
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const z = level >= 0.95 ? 1.96 : level >= 0.9 ? 1.645 : 1.282;
  const sd = Math.sqrt(variance);
  return [Math.max(0, mean - z * sd), Math.min(1, mean + z * sd)];
}

/** Mulberry32: tiny seeded PRNG for reproducible Monte Carlo. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(r: () => number) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Marsaglia–Tsang gamma sampler → Beta via two gammas. */
function sampleGamma(k: number, r: () => number): number {
  if (k < 1) return sampleGamma(k + 1, r) * Math.pow(r(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gaussian(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const sampleBeta = (a: number, b: number, r: () => number) => {
  const x = sampleGamma(a, r);
  return x / (x + sampleGamma(b, r));
};

/** P(each variant is best) under the shrunk posteriors. */
export function probBest(posts: Posterior[], draws = 4000, seed = 42): number[] {
  const r = rng(seed);
  const wins = posts.map(() => 0);
  for (let i = 0; i < draws; i++) {
    let best = -1;
    let bestV = -Infinity;
    posts.forEach((p, j) => {
      const v = sampleBeta(p.alpha, p.beta, r);
      if (v > bestV) {
        bestV = v;
        best = j;
      }
    });
    wins[best]!++;
  }
  return wins.map((w) => w / draws);
}

/**
 * P(the best of `a` beats the best of `b`) under the shrunk posteriors — how strongly new evidence supports an
 * existing learning whose winner genes are carried by `a` and loser genes by `b` (§21 strengthen/weaken).
 */
export function probAbove(a: Posterior[], b: Posterior[], draws = 4000, seed = 7): number {
  if (!a.length || !b.length) return 0.5;
  const r = rng(seed);
  let wins = 0;
  for (let i = 0; i < draws; i++) {
    const va = Math.max(...a.map((p) => sampleBeta(p.alpha, p.beta, r)));
    const vb = Math.max(...b.map((p) => sampleBeta(p.alpha, p.beta, r)));
    if (va > vb) wins++;
  }
  return wins / draws;
}

/**
 * Observed volume at one level of the baseline hierarchy (§21): this SKU, then the whole ad account — both always
 * within one measurement context (platform), never pooled across platforms.
 */
export interface BaselinePool {
  level: 'sku' | 'account';
  successes: number;
  trials: number;
}

/** Minimum trials before a pool is trusted as a baseline, per metric (below it the next level is used). */
export const BASELINE_MIN_TRIALS: Record<RateMetric, number> = { ctr: 20_000, hold_rate: 5_000, cvr: 500 };
/** Prior strength per observed trial: a baseline never carries more weight than a tenth of its own volume. */
const BASELINE_K = 0.1;

/**
 * The shrinkage target for a comparison (§21 "Bayesian shrinkage toward the recent SKU/account/platform
 * baseline"): the most specific pool with enough volume, its prior strength growing with that volume up to the
 * default strength. With no pool past the floor, the default assumption is used.
 */
export function baselineFrom(metric: RateMetric, pools: BaselinePool[], def: Baseline = DEFAULT_BASELINES[metric]): Baseline & { level: BaselinePool['level'] | 'default' } {
  for (const level of ['sku', 'account'] as const) {
    const p = pools.find((x) => x.level === level);
    if (!p || p.trials < BASELINE_MIN_TRIALS[metric] || p.successes <= 0) continue;
    const rate = Math.min(0.99, Math.max(0.0001, p.successes / p.trials));
    return { rate, strength: Math.min(def.strength, BASELINE_K * p.trials), level };
  }
  return { ...def, level: 'default' };
}

export interface EvidenceFloor {
  minTrials: number;
  minDays: number;
  minSuccesses: number;
}

/**
 * Floors scale with account volume (§21): small accounts get lighter floors and qualitative language (§48
 * "very low ad spend"). TikTok notes volatility declines after ~25 results or 7 days [R11]; we treat that
 * as a sanity anchor, not a universal threshold.
 */
export function evidenceFloor(metric: RateMetric, dailyImpressions: number): EvidenceFloor {
  const small = dailyImpressions < 3_000;
  switch (metric) {
    case 'ctr':
      return { minTrials: small ? 4_000 : 10_000, minDays: small ? 5 : 3, minSuccesses: small ? 25 : 60 };
    case 'hold_rate':
      return { minTrials: small ? 1_500 : 4_000, minDays: 3, minSuccesses: 100 };
    case 'cvr':
      return { minTrials: small ? 300 : 800, minDays: 7, minSuccesses: 25 };
  }
}

export interface VariantEvidence {
  variantId: string;
  obs: RateObs;
  days: number;
}

export interface ComparisonResult {
  metric: RateMetric;
  state: 'GATHERING_SIGNAL' | 'DIRECTIONAL' | 'ACTIONABLE' | 'INCONCLUSIVE';
  variants: (VariantEvidence & { posterior: Posterior; probBest: number; meetsFloor: boolean })[];
  leader: string | null;
  liftVsControl: number | null;
  explanation: string;
}

/**
 * Compare variants on one metric in ONE measurement context (never mixed, §30/§45).
 * ACTIONABLE requires every variant past its floor, a leader with P(best) ≥ 0.95 and a material lift (≥ 10%).
 */
export function compareVariants(
  metric: RateMetric,
  variants: VariantEvidence[],
  base: Baseline,
  dailyImpressions: number,
  controlId: string | null,
): ComparisonResult {
  const floor = evidenceFloor(metric, dailyImpressions);
  const posts = variants.map((v) => posterior(v.obs, base));
  const pb = variants.length > 1 ? probBest(posts) : [1];
  const rows = variants.map((v, i) => ({
    ...v,
    posterior: posts[i]!,
    probBest: pb[i]!,
    meetsFloor: v.obs.trials >= floor.minTrials && v.days >= floor.minDays && v.obs.successes >= floor.minSuccesses,
  }));
  const leaderIdx = pb.indexOf(Math.max(...pb));
  const leader = rows[leaderIdx]!;
  const control = controlId ? rows.find((r) => r.variantId === controlId) : null;
  const lift = control && control !== leader ? leader.posterior.mean / control.posterior.mean - 1 : null;
  const allFloors = rows.every((r) => r.meetsFloor);
  const anyFloor = rows.some((r) => r.meetsFloor);

  let state: ComparisonResult['state'];
  let explanation: string;
  if (!anyFloor) {
    state = 'GATHERING_SIGNAL';
    const need = Math.max(0, floor.minTrials - Math.min(...rows.map((r) => r.obs.trials)));
    explanation = `Too early to call. About ${need.toLocaleString('en-US')} more ${metric === 'cvr' ? 'clicks' : 'impressions'} needed per variant.`;
  } else if (allFloors && leader.probBest >= 0.95 && (lift === null || Math.abs(lift) >= 0.1)) {
    state = 'ACTIONABLE';
    explanation = `${pct(leader.probBest)} likely to be the strongest on ${label(metric)}${lift !== null ? `, about ${pct(lift)} above the control` : ''}.`;
  } else if (allFloors && leader.probBest < 0.7 && days(rows) >= floor.minDays * 2) {
    state = 'INCONCLUSIVE';
    explanation = 'Enough data, no meaningful difference. Treat these variants as equivalent on this metric.';
  } else {
    state = 'DIRECTIONAL';
    explanation = `Leaning toward one variant (${pct(leader.probBest)} chance it’s best), but not enough to act on yet.`;
  }
  return { metric, state, variants: rows, leader: state === 'GATHERING_SIGNAL' ? null : leader.variantId, liftVsControl: lift, explanation };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const label = (m: RateMetric) => ({ ctr: 'click-through rate', hold_rate: 'hold rate', cvr: 'conversion rate' })[m];
const days = (rows: { days: number }[]) => Math.min(...rows.map((r) => r.days));

/**
 * Learning state update (§21 table): new evidence can strengthen, weaken or invalidate an existing learning.
 * `supports` is P(learning direction holds) under the newest comparable evidence.
 */
export function nextLearningState(current: SignalState, supports: number, newEvidenceActionable: boolean): SignalState {
  if (newEvidenceActionable && supports <= 0.05) return 'INVALIDATED';
  if (supports < 0.35) return current === 'WEAKENING' ? 'INVALIDATED' : 'WEAKENING';
  if (supports >= 0.95 && newEvidenceActionable) return 'ACTIONABLE';
  if (current === 'WEAKENING' && supports >= 0.7) return 'DIRECTIONAL';
  return current;
}

/** Aggregate observations into rate evidence for a metric. */
export function toRate(metric: RateMetric, o: { impressions: number; clicks: number; purchases: number; video_starts?: number | null; video_75?: number | null }): RateObs {
  switch (metric) {
    case 'ctr':
      return { successes: o.clicks, trials: o.impressions };
    case 'hold_rate':
      return { successes: o.video_75 ?? 0, trials: o.video_starts ?? 0 };
    case 'cvr':
      return { successes: o.purchases, trials: o.clicks };
  }
}
