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
