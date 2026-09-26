import type { Tx } from '@arkiv/db';

/**
 * Creative fatigue (§45 "Creative winner fatigues: learning can remain historically valid while FatigueNeed rises;
 * recommend controlled refresh"). Fatigue is measured decay, not time since a computation: a variant's recent
 * click-through and hold rates against its own first days live, with rising frequency as supporting evidence.
 * The learning is untouched — only the need to refresh the winner rises.
 */

export interface DailyDelivery {
  date: string;
  impressions: number;
  clicks: number;
  videoStarts: number;
  video75: number;
  /** Impression-weighted average frequency that day, when the platform reports it. */
  frequency: number | null;
}

export interface FatigueReading {
  daysLive: number;
  baselineCtr: number | null;
  recentCtr: number | null;
  ctrDrop: number | null;
  baselineHold: number | null;
  recentHold: number | null;
  holdDrop: number | null;
  frequencyRise: number | null;
  fatigued: boolean;
  reason: string | null;
}

/** Days of delivery the baseline and the recent window each cover. */
export const FATIGUE_WINDOW_DAYS = 7;
/** A variant must have run this long before decay can be read. */
export const FATIGUE_MIN_DAYS = 14;
/** Impressions each window needs for its rate to mean anything. */
export const FATIGUE_MIN_IMPRESSIONS = 1000;
/** Relative drop in CTR or hold rate that counts as fatigue on its own. */
export const FATIGUE_DROP = 0.25;

const rate = (s: number, t: number) => (t > 0 ? s / t : null);
const drop = (base: number | null, recent: number | null) => (base && recent != null ? 1 - recent / base : null);

/** Read decay from daily delivery: first days live vs the latest days, with frequency as corroboration. */
export function measureFatigue(days: readonly DailyDelivery[]): FatigueReading {
  const sorted = [...days].filter((d) => d.impressions > 0).sort((a, b) => a.date.localeCompare(b.date));
  const empty: FatigueReading = { daysLive: 0, baselineCtr: null, recentCtr: null, ctrDrop: null, baselineHold: null, recentHold: null, holdDrop: null, frequencyRise: null, fatigued: false, reason: null };
  if (!sorted.length) return empty;
  const daysLive = Math.round((Date.parse(sorted.at(-1)!.date) - Date.parse(sorted[0]!.date)) / 86400_000) + 1;
  const base = sorted.slice(0, FATIGUE_WINDOW_DAYS);
  const recent = sorted.slice(-FATIGUE_WINDOW_DAYS);
  const sum = (xs: readonly DailyDelivery[], k: keyof DailyDelivery) => xs.reduce((n, d) => n + (Number(d[k]) || 0), 0);
  const freq = (xs: readonly DailyDelivery[]) => {
    const w = xs.filter((d) => d.frequency != null);
    const imp = sum(w, 'impressions');
    return imp > 0 ? w.reduce((n, d) => n + d.frequency! * d.impressions, 0) / imp : null;
  };
  const baselineCtr = rate(sum(base, 'clicks'), sum(base, 'impressions'));
  const recentCtr = rate(sum(recent, 'clicks'), sum(recent, 'impressions'));
  const baselineHold = rate(sum(base, 'video75'), sum(base, 'videoStarts'));
  const recentHold = rate(sum(recent, 'video75'), sum(recent, 'videoStarts'));
  const bf = freq(base);
  const rf = freq(recent);
  const out: FatigueReading = {
    daysLive,
    baselineCtr,
    recentCtr,
    ctrDrop: drop(baselineCtr, recentCtr),
    baselineHold,
    recentHold,
    holdDrop: drop(baselineHold, recentHold),
    frequencyRise: bf && rf != null ? rf / bf : null,
    fatigued: false,
    reason: null,
  };
  // Too young, or too little delivery in either window to read a decay.
  if (daysLive < FATIGUE_MIN_DAYS || sorted.length < FATIGUE_WINDOW_DAYS * 2) return out;
  if (sum(base, 'impressions') < FATIGUE_MIN_IMPRESSIONS || sum(recent, 'impressions') < FATIGUE_MIN_IMPRESSIONS) return out;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (out.ctrDrop != null && out.ctrDrop >= FATIGUE_DROP) {
    out.fatigued = true;
    out.reason = `click-through down ${pct(out.ctrDrop)} since its first week`;
  } else if (out.holdDrop != null && out.holdDrop >= FATIGUE_DROP && sum(recent, 'videoStarts') >= FATIGUE_MIN_IMPRESSIONS / 2) {
    out.fatigued = true;
    out.reason = `hold rate down ${pct(out.holdDrop)} since its first week`;
  } else if (out.frequencyRise != null && out.frequencyRise >= 1.5 && (out.ctrDrop ?? 0) >= 0.1) {
    out.fatigued = true;
    out.reason = `the same people see it ${out.frequencyRise.toFixed(1)}× as often and click-through is down ${pct(out.ctrDrop!)}`;
  }
  return out;
}

export interface ExperimentFatigue {
  measuredAt: string;
  /** The leading variant whose fatigue asks for a refresh (null without a leader). */
  winnerVariantId: string | null;
  fatigued: boolean;
  reason: string | null;
  variants: Record<string, FatigueReading>;
}

/**
 * Measure and store fatigue for an experiment's variants (experiments.fatigue). Delivery is read in the measurement
 * context × window with the most impressions, so one ad's day is never counted twice across attribution windows.
 */
export async function recordFatigue(tx: Tx, experimentId: string, variantIds: string[], leaderId: string | null): Promise<ExperimentFatigue> {
  const rows = variantIds.length
    ? await tx`
        with main as (
          select measurement_context, attribution_window from performance_observations
          where variant_id = any(${variantIds}::uuid[]) and superseded_at is null
          group by 1, 2 order by sum(impressions) desc limit 1)
        select o.variant_id, o.date::text as date, sum(o.impressions)::float8 as impressions, sum(o.clicks)::float8 as clicks,
               sum(coalesce(o.video_starts, 0))::float8 as video_starts, sum(coalesce(o.video_75, 0))::float8 as video_75,
               (sum(o.frequency * o.impressions) filter (where o.frequency is not null) / nullif(sum(o.impressions) filter (where o.frequency is not null), 0))::float8 as frequency
        from performance_observations o join main m on m.measurement_context = o.measurement_context and m.attribution_window = o.attribution_window
        where o.variant_id = any(${variantIds}::uuid[]) and o.superseded_at is null
        group by 1, 2`
    : [];
  const variants: Record<string, FatigueReading> = {};
  for (const id of variantIds) {
    const days = rows.filter((r) => r.variant_id === id).map((r) => ({
      date: r.date as string,
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      videoStarts: Number(r.video_starts),
      video75: Number(r.video_75),
      frequency: r.frequency == null ? null : Number(r.frequency),
    }));
    if (days.length) variants[id] = measureFatigue(days);
  }
  const lead = leaderId ? variants[leaderId] : undefined;
  const f: ExperimentFatigue = { measuredAt: new Date().toISOString(), winnerVariantId: leaderId, fatigued: !!lead?.fatigued, reason: lead?.reason ?? null, variants };
  await tx`update experiments set fatigue = ${tx.json(f as never)}, fatigue_at = now() where id = ${experimentId}`;
  return f;
}

// ───────────── Creative families: spend-weighted deterioration (§20 FatigueNeed, §45) ─────────────

/** One creative family's (an angle's) delivery in the recent and the prior window. */
export interface FamilyDelivery {
  family: string;
  /** Spend over the last 14 days, in the reporting currency's micros. */
  spend14: number;
  recent: { impressions: number; clicks: number; videoStarts: number; video75: number };
  prior: { impressions: number; clicks: number; videoStarts: number; video75: number };
}

export interface FamilyFatigue {
  family: string;
  /** Share of the SKU's last-14-day spend this family carries (0–1). */
  spendShare: number;
  /** Relative drop of the shrunk CTR / hold rate, last 7 days vs the 14 before (null without enough delivery). */
  ctrDrop: number | null;
  holdDrop: number | null;
  /** 0 (steady) … 1 (a 30%+ drop). */
  deterioration: number;
  /** spendShare × deterioration: how much the SKU needs a replacement for this family. */
  need: number;
}

/** Relative drop that counts as full deterioration. */
export const FAMILY_FULL_DROP = 0.3;
/** Impressions each window needs before a family's trend is read. */
export const FAMILY_MIN_IMPRESSIONS = 1000;

/**
 * Each family's fatigue (§20 "Fatigue / replacement need — increase priority when current family carries spend and
 * deteriorates"): its share of the SKU's recent spend times the decay of its click-through and hold rates, last 7
 * days against the 14 before. Rates are shrunk toward the SKU's pooled rate (a Beta prior worth 2,000 impressions /
 * 500 video starts), so a small family's noisy week does not read as decay.
 */
export function familyFatigue(rows: readonly FamilyDelivery[]): FamilyFatigue[] {
  const total = rows.reduce((n, r) => n + Math.max(0, r.spend14), 0);
  const sum = (k: 'impressions' | 'clicks' | 'videoStarts' | 'video75') => rows.reduce((n, r) => n + r.recent[k] + r.prior[k], 0);
  const pooledCtr = sum('impressions') > 0 ? sum('clicks') / sum('impressions') : 0.01;
  const pooledHold = sum('videoStarts') > 0 ? sum('video75') / sum('videoStarts') : 0.2;
  const shrunk = (s: number, t: number, rate: number, strength: number) => (s + rate * strength) / (t + strength);
  return rows.map((r) => {
    const enough = r.recent.impressions >= FAMILY_MIN_IMPRESSIONS && r.prior.impressions >= FAMILY_MIN_IMPRESSIONS;
    const ctrDrop = enough ? 1 - shrunk(r.recent.clicks, r.recent.impressions, pooledCtr, 2000) / shrunk(r.prior.clicks, r.prior.impressions, pooledCtr, 2000) : null;
    const holdEnough = r.recent.videoStarts >= FAMILY_MIN_IMPRESSIONS / 2 && r.prior.videoStarts >= FAMILY_MIN_IMPRESSIONS / 2;
    const holdDrop = holdEnough ? 1 - shrunk(r.recent.video75, r.recent.videoStarts, pooledHold, 500) / shrunk(r.prior.video75, r.prior.videoStarts, pooledHold, 500) : null;
    const drop = Math.max(ctrDrop ?? 0, holdDrop ?? 0);
    const deterioration = Math.max(0, Math.min(1, drop / FAMILY_FULL_DROP));
    const spendShare = total > 0 ? Math.max(0, r.spend14) / total : 0;
    return { family: r.family, spendShare, ctrDrop, holdDrop, deterioration, need: spendShare * deterioration };
  });
}

/**
 * A SKU's families from its delivery of the last 21 days: an observation belongs to the angle of the experiment
 * variant or the imported creative it is linked to. Tenant-scoped read (RLS), current revisions only.
 */
export async function skuFamilyFatigue(tx: Tx, skuId: string): Promise<FamilyFatigue[]> {
  const rows = await tx`
    select coalesce(v.genes->>'angle', e.genes->>'angle', c.genome->>'angle') as family,
      coalesce(sum(o.spend_reporting_micros) filter (where o.date > current_date - 14), 0)::float8 as spend14,
      coalesce(sum(o.impressions) filter (where o.date > current_date - 7), 0)::float8 as r_imp,
      coalesce(sum(o.clicks) filter (where o.date > current_date - 7), 0)::float8 as r_clk,
      coalesce(sum(o.video_starts) filter (where o.date > current_date - 7), 0)::float8 as r_vs,
      coalesce(sum(o.video_75) filter (where o.date > current_date - 7), 0)::float8 as r_v75,
      coalesce(sum(o.impressions) filter (where o.date <= current_date - 7), 0)::float8 as p_imp,
      coalesce(sum(o.clicks) filter (where o.date <= current_date - 7), 0)::float8 as p_clk,
      coalesce(sum(o.video_starts) filter (where o.date <= current_date - 7), 0)::float8 as p_vs,
      coalesce(sum(o.video_75) filter (where o.date <= current_date - 7), 0)::float8 as p_v75
    from performance_observations o
    left join variants v on v.id = o.variant_id and v.workspace_id = o.workspace_id
    left join experiments e on e.id = v.experiment_id and e.workspace_id = v.workspace_id
    left join creatives c on c.id = o.creative_id and c.workspace_id = o.workspace_id
    where o.superseded_at is null and o.date > current_date - 21
      and (e.sku_id = ${skuId} or c.sku_id = ${skuId})
    group by 1`;
  return familyFatigue(
    rows
      .filter((r) => r.family)
      .map((r) => ({
        family: r.family as string,
        spend14: Number(r.spend14),
        recent: { impressions: Number(r.r_imp), clicks: Number(r.r_clk), videoStarts: Number(r.r_vs), video75: Number(r.r_v75) },
        prior: { impressions: Number(r.p_imp), clicks: Number(r.p_clk), videoStarts: Number(r.p_vs), video75: Number(r.p_v75) },
      })),
  );
}

/**
 * FatigueNeed for a proposal (§20): the SKU's overall need for new creative (Σ spend share × deterioration over its
 * families) raises every candidate, and a candidate on a deteriorating family — a replacement for it — more. A winner
 * whose own decay was measured (experiments.fatigue) counts as a deteriorating family even without spend data.
 */
export function fatigueNeedFor(angle: string, families: readonly FamilyFatigue[], fatiguingAngles: ReadonlySet<string> = new Set()): number {
  const overall = Math.min(1, families.reduce((n, f) => n + f.need, 0));
  const own = families.find((f) => f.family === angle);
  const ownNeed = Math.max(own ? own.deterioration * Math.max(own.spendShare, 0.25) : 0, fatiguingAngles.has(angle) ? 0.6 : 0);
  const anyMeasured = fatiguingAngles.size > 0 ? 0.15 : 0;
  return Math.round(Math.max(0, Math.min(1, 0.2 + 0.4 * Math.max(overall, anyMeasured) + 0.4 * ownNeed)) * 1000) / 1000;
}
