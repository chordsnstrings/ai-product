import type { Tx } from '@arkiv/db';
import { firstRenderAcceptance, REPEATED_FIDELITY_TARGET, repeatedFidelityFailures } from './qa-metrics';

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

// ───────────── Standard §10 internal retention targets ─────────────

export interface RetentionTarget {
  key: 'first_export' | 'performance_source' | 'growth_tests' | 'month2_retention' | 'monthly_churn' | 'first_render' | 'repeated_fidelity';
  label: string;
  /** The measured value: a share (0–1), or for growth_tests the median tests per customer. Null: nobody to measure yet. */
  value: number | null;
  /** How many customers / projects the value is over. */
  n: number;
  target: number;
  /** Whether the value must be above (min) or below (max) the target. */
  direction: 'min' | 'max';
  /** Below / above target (never raised without anyone to measure). */
  alert: boolean;
  unit: 'share' | 'tests';
}

const target = (t: Omit<RetentionTarget, 'alert'>): RetentionTarget => ({
  ...t,
  alert: t.value != null && (t.direction === 'min' ? t.value < t.target : t.value > t.target),
});

/**
 * Standard §10 internal retention targets, measured over customers who started paying in the last `days` (180 by
 * default) and, for the per-project ones, the last 90 days. "If retention misses, … diagnose whether
 * recommendations, trust, output quality or integration value are failing" — so each is shown with its threshold.
 *  - first paid output export > 80%: a customer's first delivered paid ad was exported;
 *  - performance source within 14 days > 60%: a Meta/TikTok account connected or a performance CSV imported within
 *    14 days of the first payment (customers paying for at least 14 days);
 *  - Growth customers complete ≥ 3 Creative Tests in their first 30 days: the median Growth customer does;
 *  - Month-2 logo retention > 70%: still subscribed 60 days after the first plan started;
 *  - monthly logo churn < 5%: subscribers 30 days ago whose plans have all ended since;
 *  - first-render acceptance after automatic QA/repair > 70% and repeated product-fidelity failure < 3% of paid
 *    projects: the Appendix C / QA definitions (qa-metrics.ts).
 * Staff/admin role, aggregate only; test workspaces excluded unless `includeTest`.
 */
export async function retentionTargets(tx: Tx, opts: { days?: number; includeTest?: boolean } = {}): Promise<RetentionTarget[]> {
  const days = opts.days ?? 180;
  const test = !!opts.includeTest;
  const [x] = await tx`
    with ws as (select id from workspaces where ${test} or not is_test),
    first_paid as (
      select workspace_id, min(at) as at from (
        select workspace_id, paid_at as at from purchases where status in ('paid', 'refunded') and paid_at is not null
        union all select workspace_id, created_at from subscriptions) p
      where workspace_id in (select id from ws) group by workspace_id),
    cohort as (select * from first_paid where at > now() - make_interval(days => ${days})),
    first_delivered as (
      select distinct on (p.workspace_id) p.workspace_id, p.id from projects p join cohort c on c.workspace_id = p.workspace_id
      where p.kind in ('taste', 'standalone', 'creative_test') and p.state = 'COMPLETE' order by p.workspace_id, p.updated_at),
    exported as (
      select f.workspace_id from first_delivered f
      where exists (select 1 from events e join assets a on a.id = e.subject_id and a.workspace_id = e.workspace_id and a.kind = 'final_export'
                    where e.type = 'ASSET_EXPORTED' and e.workspace_id = f.workspace_id and a.lineage->>'projectId' = f.id::text)),
    perf_cohort as (select * from cohort where at <= now() - interval '14 days'),
    perf_connected as (
      select c.workspace_id from perf_cohort c
      where exists (select 1 from integrations i where i.workspace_id = c.workspace_id and i.provider in ('meta', 'tiktok') and i.created_at <= c.at + interval '14 days')
         or exists (select 1 from performance_observations o where o.workspace_id = c.workspace_id and o.platform = 'manual' and o.ingested_at <= c.at + interval '14 days'))
    select (select count(*) from first_delivered)::int as delivered, (select count(*) from exported)::int as exported,
           (select count(*) from perf_cohort)::int as perf_n, (select count(*) from perf_connected)::int as perf_ok`;
  // Growth customers' Creative Tests (consumed entitlements) in their first 30 days.
  const growth = await tx`
    select s.workspace_id,
           (select count(*) from ledger_entries l where l.workspace_id = s.workspace_id and l.type = 'CREDIT_CONSUMED' and l.unit = 'creative_test'
              and l.created_at between s.created_at and s.created_at + interval '30 days')::int as tests
    from (select distinct on (workspace_id) workspace_id, plan_code, created_at from subscriptions order by workspace_id, created_at) s
    join workspaces w on w.id = s.workspace_id
    where s.plan_code = 'GROWTH' and s.created_at <= now() - interval '30 days' and s.created_at > now() - make_interval(days => ${days})
      and (${test} or not w.is_test)`;
  const tests = growth.map((g) => Number(g.tests)).sort((a, b) => a - b);
  const median = tests.length ? (tests.length % 2 ? tests[(tests.length - 1) / 2]! : (tests[tests.length / 2 - 1]! + tests[tests.length / 2]!) / 2) : null;
  // Month-2 logo retention across all plans (the M2 checkpoint of the cohort table).
  const m2 = (await retentionCohorts(tx, { by: 'plan', days: Math.max(days, 365), includeTest: test })).reduce(
    (a, r) => ({ eligible: a.eligible + r.points.m2.eligible, retained: a.retained + r.points.m2.retained }),
    { eligible: 0, retained: 0 },
  );
  // Monthly logo churn: live 30 days ago, no live plan since its last plan ended in the window.
  const [churn] = await tx`
    with subs as (
      select s.workspace_id, s.created_at as started,
             case when s.status in ('active', 'trialing', 'past_due') then null
                  else coalesce((select min(e.at) from events e where e.workspace_id = s.workspace_id and e.type = 'SUBSCRIPTION_ENDED' and e.subject_id = s.id), s.updated_at) end as ended
      from subscriptions s join workspaces w on w.id = s.workspace_id where ${test} or not w.is_test),
    start_live as (select distinct workspace_id from subs where started <= now() - interval '30 days' and (ended is null or ended > now() - interval '30 days')),
    still as (select distinct workspace_id from subs where ended is null)
    select (select count(*) from start_live)::int as base, (select count(*) from start_live s where s.workspace_id not in (select workspace_id from still))::int as churned`;
  const fr = await firstRenderAcceptance(tx, 90, { includeTest: test });
  const fid = await repeatedFidelityFailures(tx, 90, { includeTest: test });
  const share = (a: number, b: number) => (b ? a / b : null);
  return [
    target({ key: 'first_export', label: 'First paid output exported', value: share(Number(x!.exported), Number(x!.delivered)), n: Number(x!.delivered), target: 0.8, direction: 'min', unit: 'share' }),
    target({ key: 'performance_source', label: 'Performance source connected within 14 days of paying', value: share(Number(x!.perf_ok), Number(x!.perf_n)), n: Number(x!.perf_n), target: 0.6, direction: 'min', unit: 'share' }),
    target({ key: 'growth_tests', label: 'Growth: Creative Tests completed in the first 30 days (median)', value: median, n: tests.length, target: 3, direction: 'min', unit: 'tests' }),
    target({ key: 'month2_retention', label: 'Month-2 logo retention', value: share(m2.retained, m2.eligible), n: m2.eligible, target: 0.7, direction: 'min', unit: 'share' }),
    target({ key: 'monthly_churn', label: 'Monthly logo churn (last 30 days)', value: share(Number(churn!.churned), Number(churn!.base)), n: Number(churn!.base), target: 0.05, direction: 'max', unit: 'share' }),
    target({ key: 'first_render', label: 'First-render acceptance after automatic QA/repair (90 days)', value: fr.delivered ? fr.rate : null, n: fr.delivered, target: 0.7, direction: 'min', unit: 'share' }),
    target({ key: 'repeated_fidelity', label: 'Repeated product-fidelity failure, paid projects (90 days)', value: fid.paid ? fid.rate : null, n: fid.paid, target: REPEATED_FIDELITY_TARGET, direction: 'max', unit: 'share' }),
  ];
}
