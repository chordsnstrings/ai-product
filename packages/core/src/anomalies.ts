import type { Tx } from '@arkiv/db';
import type { TenantContext } from './context';
import { recordAutomaticConfounder } from './experiment-state';

/**
 * External / viral sales events (§45 "External viral event drives sales: flag anomaly; avoid attributing lift
 * solely to creative"). A day whose purchases (or purchase value) jump far above the SKU's trailing baseline with
 * no matching rise in impressions or spend is a candidate 'viral_event' confounder. It waits for the merchant's
 * confirmation ('pending_confirmation') and confounds nothing until confirmed.
 */

export interface SkuDay {
  date: string;
  purchases: number;
  valueMicros: number;
  impressions: number;
  spendMicros: number;
}

export interface Spike {
  date: string;
  metric: 'purchases' | 'purchase_value';
  observed: number;
  baseline: number;
  threshold: number;
  impressionsLift: number;
  spendLift: number;
}

/** Trailing days forming the baseline. */
export const ANOMALY_BASELINE_DAYS = 28;
/** Robust z: observed must exceed median + K × scaled MAD. */
export const ANOMALY_K = 4;
/** Baseline days with delivery needed before a spike can be called. */
export const ANOMALY_MIN_BASELINE_DAYS = 14;
/** A spike needs at least this many purchases that day (no alarms on 0 → 2). */
export const ANOMALY_MIN_PURCHASES = 5;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mad = (xs: number[], med: number) => median(xs.map((x) => Math.abs(x - med)));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/**
 * Days among `check` (the most recent days) that spike: purchases or value above median + K·1.4826·MAD of the
 * trailing baseline (missing days count as zero), and the lift is at least twice any lift in impressions or spend
 * — a jump in sales that more delivery explains is not an anomaly.
 */
export function detectSpikes(days: readonly SkuDay[], check: readonly string[]): Spike[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: Spike[] = [];
  for (const date of check) {
    const today = byDate.get(date);
    if (!today) continue;
    const base: SkuDay[] = [];
    for (let i = ANOMALY_BASELINE_DAYS; i >= 1; i--) {
      const dd = addDays(date, -i);
      base.push(byDate.get(dd) ?? { date: dd, purchases: 0, valueMicros: 0, impressions: 0, spendMicros: 0 });
    }
    if (base.filter((b) => b.impressions > 0).length < ANOMALY_MIN_BASELINE_DAYS) continue;
    const lift = (k: keyof Omit<SkuDay, 'date'>) => {
      const m = median(base.map((b) => b[k]));
      return m > 0 ? today[k] / m : today[k] > 0 ? Infinity : 1;
    };
    const impressionsLift = lift('impressions');
    const spendLift = lift('spendMicros');
    const delivery = Math.max(1, impressionsLift, spendLift);
    for (const [metric, k] of [['purchases', 'purchases'], ['purchase_value', 'valueMicros']] as const) {
      const xs = base.map((b) => b[k]);
      const med = median(xs);
      // A floor on the spread: a flat baseline (MAD 0) must not turn any change into a spike.
      const spread = Math.max(1.4826 * mad(xs, med), med * 0.25, k === 'purchases' ? 1 : 1_000_000);
      const threshold = med + ANOMALY_K * spread;
      const observed = today[k];
      if (today.purchases < ANOMALY_MIN_PURCHASES || observed <= threshold) continue;
      const salesLift = med > 0 ? observed / med : Infinity;
      if (salesLift < 2 * delivery) continue;
      out.push({ date, metric, observed, baseline: med, threshold, impressionsLift, spendLift });
      break; // one candidate per day
    }
  }
  return out;
}

/**
 * Daily sweep for one workspace: per SKU, attributed observations (a variant's experiment or a creative's SKU) are
 * summed per day in the reporting currency; spikes on the last three days become candidate viral-event confounders,
 * once per SKU and day. Runs in the workspace's tenant transaction (the system worker opens it per workspace).
 */
export async function detectSalesAnomalies(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, now = new Date()): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const since = addDays(today, -(ANOMALY_BASELINE_DAYS + 3));
  const rows = await tx`
    with attributed as (
      select coalesce(x.sku_id, c.sku_id) as sku_id, o.date, o.purchases, coalesce(o.value_reporting_micros, 0) as value, o.impressions,
             coalesce(o.spend_reporting_micros, 0) as spend
      from performance_observations o
      left join variants v on v.id = o.variant_id and v.workspace_id = o.workspace_id
      left join experiments x on x.id = v.experiment_id and x.workspace_id = o.workspace_id
      left join creatives c on c.id = o.creative_id and c.workspace_id = o.workspace_id
      where o.workspace_id = ${ctx.workspaceId} and o.superseded_at is null and o.date >= ${since}::date
        and o.measurement_context not like 'MERCHANT\_IMPORTED%')
    select sku_id, date::text as date, sum(purchases)::float8 as purchases, sum(value)::float8 as value, sum(impressions)::float8 as impressions, sum(spend)::float8 as spend
    from attributed where sku_id is not null group by 1, 2`;
  const check = [1, 2, 3].map((n) => addDays(today, -n));
  let n = 0;
  for (const skuId of new Set(rows.map((r) => r.sku_id as string))) {
    const days = rows.filter((r) => r.sku_id === skuId).map((r) => ({ date: r.date as string, purchases: Number(r.purchases), valueMicros: Number(r.value), impressions: Number(r.impressions), spendMicros: Number(r.spend) }));
    for (const s of detectSpikes(days, check)) {
      const [dup] = await tx`select 1 from confounders where workspace_id = ${ctx.workspaceId} and sku_id = ${skuId} and kind = 'viral_event'
                             and starts_at::date = ${s.date}::date limit 1`;
      if (dup) continue;
      const note = `Sales jumped on ${s.date} (${s.metric === 'purchases' ? `${s.observed} purchases vs about ${Math.round(s.baseline)}` : 'purchase value far above normal'}) without more ad delivery. Was there a mention, press or influencer post?`;
      await recordAutomaticConfounder(tx, ctx, { skuId, kind: 'viral_event', startsAt: `${s.date}T00:00:00Z`, endsAt: 'P1D', note, detail: { ...s }, status: 'pending_confirmation' });
      n++;
    }
  }
  return n;
}
