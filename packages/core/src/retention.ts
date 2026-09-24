import type { Tx } from '@arkiv/db';

/**
 * Retention analytics for the console (plan 05 §17). Staff/admin role, aggregate only.
 */

/** Retention checkpoints: W1, W4, M2, M3 (days after the first paid plan started). */
export const RETENTION_POINTS = [
  { key: 'w1', label: 'W1', days: 7 },
  { key: 'w4', label: 'W4', days: 28 },
  { key: 'm2', label: 'M2', days: 60 },
  { key: 'm3', label: 'M3', days: 90 },
] as const;

export type RetentionDimension = 'plan' | 'page' | 'ad_account';

export interface RetentionRow {
  segment: string;
  customers: number;
  /** Per checkpoint: customers old enough to measure, and how many of them still had a plan then. */
  points: Record<(typeof RETENTION_POINTS)[number]['key'], { eligible: number; retained: number }>;
}

/**
 * Subscription cohort retention by plan (first plan chosen), acquisition page (the first landing page the customer's
 * visitor saw) or whether an ad account (Meta/TikTok) is connected. A customer is retained at day N when some
 * subscription covered that day (started on or before it, not ended by then; an ended subscription's end is its
 * SUBSCRIPTION_ENDED event, or its last update). Only cohorts started in the last `days`.
 */
export async function retentionCohorts(tx: Tx, opts: { by: RetentionDimension; days?: number; includeTest?: boolean }): Promise<RetentionRow[]> {
  const days = opts.days ?? 180;
  const segment =
    opts.by === 'plan'
      ? tx`c.plan_code`
      : opts.by === 'ad_account'
        ? tx`case when c.ad_connected then 'ad account connected' else 'no ad account' end`
        : tx`coalesce(c.landing, '(unattributed)')`;
  const points = RETENTION_POINTS.map((p) => p.days);
  const rows = await tx`
    with subs as (
      select s.workspace_id, s.plan_code, s.created_at as started,
             case when s.status in ('active', 'trialing', 'past_due') then null
                  else coalesce((select min(e.at) from events e where e.workspace_id = s.workspace_id and e.type = 'SUBSCRIPTION_ENDED' and e.subject_id = s.id), s.updated_at) end as ended
      from subscriptions s join workspaces w on w.id = s.workspace_id
      where ${!!opts.includeTest} or not w.is_test),
    firsts as (select distinct on (workspace_id) workspace_id, plan_code, started from subs order by workspace_id, started),
    ws_visitor as (select distinct on (workspace_id) workspace_id, visitor_id from funnel_events where visitor_id is not null and workspace_id is not null order by workspace_id, at),
    cohort as (
      select f.workspace_id, f.plan_code, f.started,
             (select l.page from funnel_events l where l.type = 'LP_VIEWED' and l.visitor_id = wv.visitor_id order by l.at limit 1) as landing,
             exists (select 1 from integrations i where i.workspace_id = f.workspace_id and i.provider in ('meta', 'tiktok') and i.status <> 'disconnected') as ad_connected
      from firsts f left join ws_visitor wv on wv.workspace_id = f.workspace_id
      where f.started > now() - make_interval(days => ${days})),
    measured as (
      select ${segment} as segment, c.workspace_id, p.d,
             c.started + make_interval(days => p.d) <= now() as eligible,
             exists (select 1 from subs x where x.workspace_id = c.workspace_id and x.started <= c.started + make_interval(days => p.d)
                     and (x.ended is null or x.ended > c.started + make_interval(days => p.d))) as retained
      from cohort c cross join unnest(${points}::int[]) as p(d))
    select segment, count(distinct workspace_id)::int as customers, d,
           count(*) filter (where eligible)::int as eligible, count(*) filter (where eligible and retained)::int as retained
    from measured group by segment, d order by segment, d`;
  const out = new Map<string, RetentionRow>();
  for (const r of rows) {
    const seg = String(r.segment);
    const row = out.get(seg) ?? { segment: seg, customers: Number(r.customers), points: { w1: { eligible: 0, retained: 0 }, w4: { eligible: 0, retained: 0 }, m2: { eligible: 0, retained: 0 }, m3: { eligible: 0, retained: 0 } } };
    const point = RETENTION_POINTS.find((p) => p.days === Number(r.d))!;
    row.points[point.key] = { eligible: Number(r.eligible), retained: Number(r.retained) };
    out.set(seg, row);
  }
  const last = (seg: string) => (seg.startsWith('(') ? 1 : 0);
  return [...out.values()].sort((a, b) => last(a.segment) - last(b.segment) || b.customers - a.customers || a.segment.localeCompare(b.segment));
}

/**
 * Day-30 SKU Review delivery (plan 05 §17, standard §9): every Day-30 review written in the window, with how its
 * email fared (the day30_review email to the workspace, matched by the review link).
 */
export async function day30ReviewDelivery(tx: Tx, opts: { days?: number; includeTest?: boolean } = {}) {
  const days = opts.days ?? 90;
  const reviews = await tx`
    select r.id, r.workspace_id, w.name as workspace, r.sku_id, s.name as sku, r.created_at,
           (select l.status from email_log l where l.workspace_id = r.workspace_id and l.template = 'day30_review' and l.created_at >= r.created_at
              and l.data->>'url' like '%/products/' || r.sku_id::text || '/review' order by l.created_at limit 1) as email_status,
           (select count(*) from email_log l where l.workspace_id = r.workspace_id and l.template = 'day30_review' and l.created_at >= r.created_at
              and l.data->>'url' like '%/products/' || r.sku_id::text || '/review')::int as emails
    from sku_reviews r join workspaces w on w.id = r.workspace_id left join skus s on s.id = r.sku_id and s.workspace_id = r.workspace_id
    where r.kind = 'day30' and r.created_at > now() - make_interval(days => ${days}) and (${!!opts.includeTest} or not w.is_test)
    order by r.created_at desc limit 200`;
  const summary = { written: reviews.length, emailed: 0, delivered: 0, bounced: 0, notSent: 0 };
  for (const r of reviews) {
    const st = r.email_status as string | null;
    if (!st) summary.notSent++;
    else {
      summary.emailed++;
      if (['delivered', 'opened', 'clicked'].includes(st)) summary.delivered++;
      if (st === 'bounced' || st === 'complained') summary.bounced++;
    }
  }
  return { reviews, summary };
}
