import type { Tx } from '@arkiv/db';
import { DomainError, PLANS, type PlanCode } from '@arkiv/shared';
import { providers } from '@arkiv/providers';
import { csvLine } from './funnel';
import { BALANCE_TYPES } from './ledger';

/**
 * Finance views of the staff console (plan 05 §7 revenue, §8 ledger & COGS). Staff read across tenants, so every
 * query ties rows to their own workspace explicitly and excludes test workspaces unless asked.
 */

const planPrice = (plan: unknown): number => PLANS[plan as PlanCode]?.priceMicros ?? 0;

// ───────────── §7 Revenue: MRR movements ─────────────

export interface SubscriptionEvent {
  workspaceId: string;
  /** The subscription row (events without one fall back to the workspace). */
  subjectId: string | null;
  type: 'SUBSCRIPTION_STARTED' | 'SUBSCRIPTION_CHANGED' | 'SUBSCRIPTION_ENDED';
  at: Date;
  payload: Record<string, unknown>;
}

export type MrrKind = 'new' | 'reactivation' | 'expansion' | 'contraction' | 'churned';

/** One priced movement. `delta` is signed; `plan` is the plan it is attributed to (the plan moved into, or left). */
export interface MrrMove {
  workspaceId: string;
  at: Date;
  kind: MrrKind;
  delta: number;
  plan: string;
}

export interface MrrClassified {
  moves: MrrMove[];
  /** Scheduled, not yet effective: kept apart from cancels and from MRR (Appendix C: downgrade ≠ cancel). */
  scheduled: { workspaceId: string; at: Date; kind: 'downgrade_scheduled' | 'cancel_scheduled' | 'cancel_withdrawn'; plan: string | null }[];
  /** Live plan per subscription after all events. */
  current: Map<string, { workspaceId: string; plan: string }>;
  /** First subscription month per workspace (its revenue cohort). */
  firstStart: Map<string, { at: Date; plan: string }>;
}

/**
 * Classify subscription events into MRR movements (Appendix C): a start is new MRR, or a reactivation when the
 * workspace had a subscription that ended; a plan change that takes effect (now, or a scheduled downgrade applied
 * at the period boundary) is expansion or contraction; an ended subscription is churned MRR. A scheduled downgrade
 * or cancellation moves no MRR until it takes effect.
 */
export function classifySubscriptionEvents(events: readonly SubscriptionEvent[]): MrrClassified {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const current = new Map<string, { workspaceId: string; plan: string }>();
  const ended = new Set<string>();
  const firstStart = new Map<string, { at: Date; plan: string }>();
  const moves: MrrMove[] = [];
  const scheduled: MrrClassified['scheduled'] = [];
  for (const e of sorted) {
    const key = e.subjectId ?? e.workspaceId;
    const p = e.payload ?? {};
    if (e.type === 'SUBSCRIPTION_STARTED') {
      const plan = String(p.plan ?? '');
      const prev = current.get(key);
      if (prev) {
        // A second start for the same subscription is a plan change, not new revenue.
        const delta = planPrice(plan) - planPrice(prev.plan);
        if (delta) moves.push({ workspaceId: e.workspaceId, at: e.at, kind: delta > 0 ? 'expansion' : 'contraction', delta, plan });
      } else {
        moves.push({ workspaceId: e.workspaceId, at: e.at, kind: ended.has(e.workspaceId) ? 'reactivation' : 'new', delta: planPrice(plan), plan });
        if (!firstStart.has(e.workspaceId)) firstStart.set(e.workspaceId, { at: e.at, plan });
      }
      current.set(key, { workspaceId: e.workspaceId, plan });
    } else if (e.type === 'SUBSCRIPTION_CHANGED') {
      if (typeof p.to === 'string' && (p.effective === 'now' || p.effective === 'applied')) {
        const from = typeof p.from === 'string' ? p.from : (current.get(key)?.plan ?? p.to);
        const delta = planPrice(p.to) - planPrice(from);
        if (delta) moves.push({ workspaceId: e.workspaceId, at: e.at, kind: delta > 0 ? 'expansion' : 'contraction', delta, plan: p.to });
        current.set(key, { workspaceId: e.workspaceId, plan: p.to });
      } else if (typeof p.to === 'string' && p.effective === 'period_end') {
        scheduled.push({ workspaceId: e.workspaceId, at: e.at, kind: 'downgrade_scheduled', plan: p.to });
      } else if (p.cancelAtPeriodEnd === true) {
        scheduled.push({ workspaceId: e.workspaceId, at: e.at, kind: 'cancel_scheduled', plan: current.get(key)?.plan ?? null });
      } else if (p.cancelAtPeriodEnd === false) {
        scheduled.push({ workspaceId: e.workspaceId, at: e.at, kind: 'cancel_withdrawn', plan: current.get(key)?.plan ?? null });
      }
    } else if (e.type === 'SUBSCRIPTION_ENDED') {
      const plan = current.get(key)?.plan ?? String(p.plan ?? '');
      moves.push({ workspaceId: e.workspaceId, at: e.at, kind: 'churned', delta: -planPrice(plan), plan });
      current.delete(key);
      ended.add(e.workspaceId);
    }
  }
  return { moves, scheduled, current, firstStart };
}

export async function subscriptionEvents(tx: Tx, opts: { includeTest?: boolean } = {}): Promise<SubscriptionEvent[]> {
  const rows = await tx`select workspace_id, subject_id, type, at, payload from events
                        where type in ('SUBSCRIPTION_STARTED', 'SUBSCRIPTION_CHANGED', 'SUBSCRIPTION_ENDED')
                          ${opts.includeTest ? tx`` : tx`and workspace_id not in (select id from workspaces where is_test)`}
                        order by at, seq`;
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, subjectId: (r.subject_id as string) ?? null, type: r.type as SubscriptionEvent['type'], at: new Date(r.at as string), payload: (r.payload as Record<string, unknown>) ?? {} }));
}

/** Movement totals over the last `days` (Pulse and Billing KPIs). */
export function mrrTotals(c: MrrClassified, since: Date) {
  const sum = (k: MrrKind) => c.moves.filter((m) => m.kind === k && m.at >= since).reduce((a, m) => a + Math.abs(m.delta), 0);
  const r = { new: sum('new') + sum('reactivation'), expansion: sum('expansion'), contraction: sum('contraction'), churned: sum('churned') };
  return { ...r, net: r.new + r.expansion - r.contraction - r.churned };
}

const monthKey = (d: Date, tz: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
};

export interface MrrMonth {
  month: string;
  startMrr: number;
  new: number;
  reactivation: number;
  expansion: number;
  contraction: number;
  churned: number;
  net: number;
  endMrr: number;
  startLogos: number;
  newLogos: number;
  churnedLogos: number;
  /** Churned logos ÷ logos at the start of the month. */
  logoChurn: number | null;
  /** Gross revenue churn: (churned + contraction) ÷ starting MRR. */
  revenueChurn: number | null;
  /** Net revenue churn: (churned + contraction − expansion) ÷ starting MRR (negative = net expansion). */
  netRevenueChurn: number | null;
  downgradesScheduled: number;
  cancelsScheduled: number;
}

export interface MrrReport {
  months: MrrMonth[];
  byPlan: { plan: string; subscriptions: number; mrr: number; new: number; expansion: number; contraction: number; churned: number; net: number }[];
  cohorts: { cohort: string; started: number; active: number; startMrr: number; mrrNow: number; churnedLogos: number; netRetention: number | null }[];
  mrr: number;
}

/**
 * Plan 05 §7 "Revenue: MRR, ARR, net new, expansion, contraction, churned MRR, by plan and cohort. Logo churn and
 * revenue churn tracked separately; pause/downgrade kept distinct from cancel". Months are calendar months in `tz`;
 * by-plan totals cover the same months; cohorts are the month a workspace first subscribed.
 */
export function mrrReport(c: MrrClassified, opts: { months: number; tz: string; now?: Date }): MrrReport {
  const now = opts.now ?? new Date();
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15));
  for (let i = 0; i < opts.months; i++) {
    keys.unshift(monthKey(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - i, 15)), opts.tz));
  }
  const inWindow = new Set(keys);
  // Walk every move in time order, tracking MRR and live logos per workspace, to get each month's opening state.
  const perWs = new Map<string, number>();
  let mrr = 0;
  const logos = () => [...perWs.values()].filter((v) => v > 0).length;
  const rows = new Map<string, MrrMonth>();
  const blank = (month: string): MrrMonth => ({ month, startMrr: mrr, new: 0, reactivation: 0, expansion: 0, contraction: 0, churned: 0, net: 0, endMrr: mrr, startLogos: logos(), newLogos: 0, churnedLogos: 0, logoChurn: null, revenueChurn: null, netRevenueChurn: null, downgradesScheduled: 0, cancelsScheduled: 0 });
  const sorted = [...c.moves].sort((a, b) => a.at.getTime() - b.at.getTime());
  let i = 0;
  for (const month of keys) {
    // Moves before this month set its opening MRR.
    while (i < sorted.length && monthKey(sorted[i]!.at, opts.tz) < month) {
      const m = sorted[i++]!;
      mrr += m.delta;
      perWs.set(m.workspaceId, (perWs.get(m.workspaceId) ?? 0) + m.delta);
    }
    const row = blank(month);
    // Logos are judged month over month: a customer who left and came back within the month never churned.
    const activeAtStart = new Set([...perWs].filter(([, v]) => v > 0).map(([ws]) => ws));
    while (i < sorted.length && monthKey(sorted[i]!.at, opts.tz) === month) {
      const m = sorted[i++]!;
      mrr += m.delta;
      perWs.set(m.workspaceId, (perWs.get(m.workspaceId) ?? 0) + m.delta);
      if (m.kind === 'new' || m.kind === 'reactivation') row[m.kind] += m.delta;
      else if (m.kind === 'expansion') row.expansion += m.delta;
      else if (m.kind === 'contraction') row.contraction += -m.delta;
      else row.churned += -m.delta;
    }
    for (const [ws, v] of perWs) {
      if (activeAtStart.has(ws) && v <= 0) row.churnedLogos++;
      if (!activeAtStart.has(ws) && v > 0) row.newLogos++;
    }
    row.endMrr = mrr;
    row.net = row.new + row.reactivation + row.expansion - row.contraction - row.churned;
    row.logoChurn = row.startLogos ? row.churnedLogos / row.startLogos : null;
    row.revenueChurn = row.startMrr ? (row.churned + row.contraction) / row.startMrr : null;
    row.netRevenueChurn = row.startMrr ? (row.churned + row.contraction - row.expansion) / row.startMrr : null;
    rows.set(month, row);
  }
  for (const s of c.scheduled) {
    const row = rows.get(monthKey(s.at, opts.tz));
    if (!row) continue;
    if (s.kind === 'downgrade_scheduled') row.downgradesScheduled++;
    else if (s.kind === 'cancel_scheduled') row.cancelsScheduled++;
  }

  const plans = new Map<string, MrrReport['byPlan'][number]>();
  const planRow = (plan: string) => plans.get(plan) ?? plans.set(plan, { plan, subscriptions: 0, mrr: 0, new: 0, expansion: 0, contraction: 0, churned: 0, net: 0 }).get(plan)!;
  for (const code of Object.keys(PLANS)) planRow(code);
  for (const s of c.current.values()) {
    const r = planRow(s.plan);
    r.subscriptions++;
    r.mrr += planPrice(s.plan);
  }
  for (const m of c.moves) {
    if (!inWindow.has(monthKey(m.at, opts.tz))) continue;
    const r = planRow(m.plan);
    if (m.kind === 'new' || m.kind === 'reactivation') r.new += m.delta;
    else if (m.kind === 'expansion') r.expansion += m.delta;
    else if (m.kind === 'contraction') r.contraction += -m.delta;
    else r.churned += -m.delta;
    r.net += m.delta;
  }

  const cohorts = new Map<string, MrrReport['cohorts'][number]>();
  const liveByWs = new Map<string, number>();
  for (const s of c.current.values()) liveByWs.set(s.workspaceId, (liveByWs.get(s.workspaceId) ?? 0) + planPrice(s.plan));
  for (const [ws, f] of c.firstStart) {
    const key = monthKey(f.at, opts.tz);
    const r = cohorts.get(key) ?? { cohort: key, started: 0, active: 0, startMrr: 0, mrrNow: 0, churnedLogos: 0, netRetention: null };
    r.started++;
    r.startMrr += planPrice(f.plan);
    const live = liveByWs.get(ws) ?? 0;
    r.mrrNow += live;
    if (live > 0) r.active++;
    else r.churnedLogos++;
    cohorts.set(key, r);
  }
  for (const r of cohorts.values()) r.netRetention = r.startMrr ? r.mrrNow / r.startMrr : null;
  return {
    months: [...rows.values()].reverse(),
    byPlan: [...plans.values()],
    cohorts: [...cohorts.values()].sort((a, b) => b.cohort.localeCompare(a.cohort)),
    mrr: [...c.current.values()].reduce((a, s) => a + planPrice(s.plan), 0),
  };
}

// ───────────── §8 Ledger explorer ─────────────

export interface LedgerFilter {
  workspaceId?: string | null;
  type?: string | null;
  experimentId?: string | null;
  /** A provider job or a Cost Governor authorization (the job's reservation). */
  jobId?: string | null;
  limit?: number;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v: string | null | undefined) => {
  const x = v?.trim() || null;
  if (x && !uuidRe.test(x)) throw new DomainError('INVALID', `“${x}” isn’t an id.`);
  return x;
};

/**
 * Plan 05 §8 "Ledger explorer: filter by workspace, event type, experiment and job; shows the balance derivation step
 * by step". The running balance per workspace and unit is computed over the whole ledger of the matching workspaces
 * (then filtered), so every row shows the balance before and after it, whatever the filter.
 */
export async function ledgerExplorer(tx: Tx, f: LedgerFilter) {
  const ws = asUuid(f.workspaceId);
  const exp = asUuid(f.experimentId);
  const job = asUuid(f.jobId);
  const type = f.type?.trim() || null;
  const counted = [...BALANCE_TYPES];
  const match = (a: string) => tx`
    (${ws}::uuid is null or ${tx(a)}.workspace_id = ${ws})
    and (${type}::text is null or ${tx(a)}.type = ${type})
    and (${exp}::uuid is null or exists (select 1 from projects p where p.id = ${tx(a)}.project_id and p.workspace_id = ${tx(a)}.workspace_id and p.experiment_id = ${exp}))
    and (${job}::uuid is null or ${tx(a)}.provider_job_id = ${job} or ${tx(a)}.authorization_id = ${job}
         or ${tx(a)}.authorization_id = (select j.authorization_id from provider_jobs j where j.id = ${job} and j.workspace_id = ${tx(a)}.workspace_id))`;
  const rows = await tx`
    with scope as (select distinct x.workspace_id from ledger_entries x where ${match('x')}),
    base as (
      select l.*, l.type in ${tx(counted)} as counted,
             sum(case when l.type in ${tx(counted)} then l.amount else 0 end) over (partition by l.workspace_id, l.unit order by l.id) as balance_after
      from ledger_entries l where l.workspace_id in (select workspace_id from scope))
    select b.*, b.balance_after - case when b.counted then b.amount else 0 end as balance_before, w.name, p.experiment_id
    from base b join workspaces w on w.id = b.workspace_id
    left join projects p on p.id = b.project_id and p.workspace_id = b.workspace_id
    where ${match('b')}
    order by b.id desc limit ${Math.min(1000, f.limit ?? 300)}`;
  // Derivation per unit for one workspace: Σ by type = available.
  const derivation = ws
    ? await tx`select unit, type, sum(amount)::bigint as total, count(*)::int as n from ledger_entries
               where workspace_id = ${ws} and unit <> 'usd_micros' group by 1, 2 order by 1, 2`
    : [];
  const units = new Map<string, { unit: string; parts: { type: string; total: number; n: number; counted: boolean }[]; available: number }>();
  for (const d of derivation) {
    const u = units.get(d.unit as string) ?? { unit: d.unit as string, parts: [], available: 0 };
    const counts = counted.includes(d.type as never);
    u.parts.push({ type: d.type as string, total: Number(d.total), n: Number(d.n), counted: counts });
    if (counts) u.available += Number(d.total);
    units.set(d.unit as string, u);
  }
  return { rows, derivation: [...units.values()] };
}

// ───────────── §8 COGS ─────────────

/**
 * Plan 05 §8 "COGS: by provider, model, modality, resolution and duration; by workspace; by plan; by experiment …
 * Share of spend on QA retries. Fallback technique rate." Spend is each provider job's recorded actual cost.
 */
export async function cogsBreakdown(tx: Tx, opts: { days: number; includeTest?: boolean }) {
  const t = (col: string) => (opts.includeTest ? tx`` : tx`and ${tx(col)} not in (select id from workspaces where is_test)`);
  const since = tx`now() - make_interval(days => ${opts.days})`;
  const spend = tx`coalesce(sum(j.actual_micros), 0)::bigint`;
  const [byModality, byVideo, byWorkspace, byPlan, byExperiment, fallback] = [
    // Task family → modality (route task names start with their family).
    await tx`select case when j.task like 'video.%' then 'video' when j.task like 'image.%' then 'image' when j.task like 'tts.%' then 'voice' else 'text (LLM)' end as modality,
                    count(*)::int as calls, ${spend} as spend from provider_jobs j
             where j.created_at > ${since} ${t('j.workspace_id')} group by 1 order by spend desc`,
    // Video by resolution and duration (units the gateway records with each call).
    await tx`select coalesce(j.input_refs->'units'->>'resolution', 'unknown') as resolution,
                    case when j.input_refs->'units'->>'seconds' is null then 'unknown'
                         when (j.input_refs->'units'->>'seconds')::numeric <= 5 then '≤5s'
                         when (j.input_refs->'units'->>'seconds')::numeric <= 10 then '6–10s' else '>10s' end as duration,
                    count(*)::int as calls, coalesce(sum((j.input_refs->'units'->>'seconds')::numeric), 0)::float as seconds, ${spend} as spend
             from provider_jobs j where j.task like 'video.%' and j.created_at > ${since} ${t('j.workspace_id')} group by 1, 2 order by spend desc`,
    await tx`select j.workspace_id, w.name, w.plan_code, count(*)::int as calls, ${spend} as spend from provider_jobs j join workspaces w on w.id = j.workspace_id
             where j.created_at > ${since} ${t('j.workspace_id')} group by 1, 2, 3 order by spend desc limit 20`,
    await tx`select coalesce(w.plan_code, 'no plan (free / one-off)') as plan, count(distinct j.workspace_id)::int as workspaces, count(*)::int as calls, ${spend} as spend
             from provider_jobs j join workspaces w on w.id = j.workspace_id where j.created_at > ${since} ${t('j.workspace_id')} group by 1 order by spend desc`,
    await tx`select p.experiment_id, j.workspace_id, w.name, count(distinct p.id)::int as projects, count(*)::int as calls, ${spend} as spend
             from provider_jobs j join projects p on p.id = j.project_id and p.workspace_id = j.workspace_id join workspaces w on w.id = j.workspace_id
             where p.experiment_id is not null and j.created_at > ${since} ${t('j.workspace_id')} group by 1, 2, 3 order by spend desc limit 20`,
    // Scenes that ended on a fallback technique (repeated QA failure → exact-product composite) among scenes rendered.
    await tx`select count(distinct v.scene_id)::int as scenes, count(distinct v.scene_id) filter (where v.lineage->>'fallback' = 'true')::int as fallback
             from scene_versions v where v.created_at > ${since} ${t('v.workspace_id')}`,
  ];
  return { byModality, byVideo, byWorkspace, byPlan, byExperiment, fallback: { scenes: Number(fallback[0]?.scenes ?? 0), fallback: Number(fallback[0]?.fallback ?? 0) } };
}

// ───────────── §8 Margin ─────────────

export interface WorkspaceMargin {
  workspaceId: string;
  name: string;
  plan: string | null;
  periods: { revenue: number; cogs: number; margin: number | null }[];
  /** Below 0% margin in both of the last two periods. */
  flagged: boolean;
}

/**
 * Plan 05 §8 "Margin: per workspace (revenue − variable COGS), flagging tenants below 0% margin for 2 consecutive
 * periods". Periods are the last two `periodDays` windows. Revenue is what was actually paid: one-off purchases net
 * of refunds and mirrored subscription invoices; a subscription with no mirrored invoice in a period counts at its
 * plan's list price (PLANS) when it was live then.
 */
export async function workspaceMargins(tx: Tx, opts: { periodDays?: number; includeTest?: boolean; limit?: number } = {}): Promise<WorkspaceMargin[]> {
  const days = opts.periodDays ?? 30;
  const prices = tx.json(Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, p.priceMicros])));
  const rows = await tx`
    with periods as (select n, now() - make_interval(days => ${days} * n) as p_from, now() - make_interval(days => ${days} * (n - 1)) as p_to from generate_series(1, 2) n),
    ws as (select id, name, plan_code from workspaces w where (${opts.includeTest ?? false} or not w.is_test)),
    oneoff as (select p.workspace_id, pr.n, sum(p.amount_micros - p.refunded_micros)::bigint as micros from purchases p join periods pr on p.paid_at >= pr.p_from and p.paid_at < pr.p_to
               where p.status in ('paid', 'refunded') group by 1, 2),
    invoiced as (select i.workspace_id, pr.n, sum(i.amount_paid_cents - coalesce((select sum(r.amount_micros) from refunds r where r.workspace_id = i.workspace_id and r.payment_intent_id = i.payment_intent_id and r.status = 'succeeded'), 0) / 10000)::bigint * 10000 as micros
                 from stripe_invoices i join periods pr on coalesce(i.stripe_created_at, i.period_start) >= pr.p_from and coalesce(i.stripe_created_at, i.period_start) < pr.p_to
                 where i.status = 'paid' group by 1, 2),
    listed as (select s.workspace_id, pr.n, sum((${prices}->>s.plan_code)::bigint)::bigint as micros from subscriptions s join periods pr
                 on s.created_at < pr.p_to and (s.status in ('active', 'trialing', 'past_due') or s.updated_at >= pr.p_from)
               where not exists (select 1 from invoiced iv where iv.workspace_id = s.workspace_id and iv.n = pr.n) group by 1, 2),
    cogs as (select l.workspace_id, pr.n, sum(l.amount)::bigint as micros from ledger_entries l join periods pr on l.created_at >= pr.p_from and l.created_at < pr.p_to
             where l.type = 'PROVIDER_COST_RECORDED' group by 1, 2)
    select ws.id, ws.name, ws.plan_code, pr.n,
           (coalesce(o.micros, 0) + coalesce(iv.micros, 0) + coalesce(ls.micros, 0))::bigint as revenue, coalesce(c.micros, 0)::bigint as cogs
    from ws cross join periods pr
    left join oneoff o on o.workspace_id = ws.id and o.n = pr.n
    left join invoiced iv on iv.workspace_id = ws.id and iv.n = pr.n
    left join listed ls on ls.workspace_id = ws.id and ls.n = pr.n
    left join cogs c on c.workspace_id = ws.id and c.n = pr.n
    where exists (select 1 from ledger_entries l where l.workspace_id = ws.id and l.type = 'PROVIDER_COST_RECORDED' and l.created_at >= now() - make_interval(days => ${days * 2}))
       or exists (select 1 from purchases p where p.workspace_id = ws.id and p.paid_at >= now() - make_interval(days => ${days * 2}))
       or exists (select 1 from subscriptions s where s.workspace_id = ws.id and (s.status in ('active', 'trialing', 'past_due') or s.updated_at >= now() - make_interval(days => ${days * 2})))
    order by ws.id, pr.n`;
  const byWs = new Map<string, WorkspaceMargin>();
  for (const r of rows) {
    const m = byWs.get(r.id as string) ?? { workspaceId: r.id as string, name: r.name as string, plan: (r.plan_code as string) ?? null, periods: [], flagged: false };
    const revenue = Number(r.revenue);
    const cogs = Number(r.cogs);
    // No revenue in a period (free usage) has no margin; only paying tenants can be flagged.
    m.periods[Number(r.n) - 1] = { revenue, cogs, margin: revenue ? (revenue - cogs) / revenue : null };
    byWs.set(r.id as string, m);
  }
  const out = [...byWs.values()];
  for (const m of out) m.flagged = m.periods.length === 2 && m.periods.every((p) => p && p.margin !== null && p.margin < 0);
  return out.sort((a, b) => Number(b.flagged) - Number(a.flagged) || (b.periods[0]?.cogs ?? 0) - (a.periods[0]?.cogs ?? 0)).slice(0, opts.limit ?? 200);
}

// ───────────── §8 Provider invoice reconciliation ─────────────

export interface ProviderInvoiceLine {
  period: string; // YYYY-MM-01
  model: string;
  quantity: number | null;
  unit: string | null;
  amountMicros: number;
}

/**
 * Parse a provider's monthly invoice CSV (BytePlus / Anthropic / MiniMax exports differ, so the header is matched
 * loosely): a month (or a billing date), a model / product line, an amount in USD, and optionally quantity and unit.
 */
export function parseProviderInvoiceCsv(text: string): ProviderInvoiceLine[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new DomainError('INVALID', 'Paste a header row and at least one invoice line.');
  if (lines.length > 5001) throw new DomainError('INVALID', 'Import at most 5,000 lines at a time.');
  const head = csvLine(lines[0]!).map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iPeriod = col('month', 'period', 'billing_month', 'billing_period', 'date', 'invoice_date', 'usage_month');
  const iModel = col('model', 'model_id', 'product', 'item', 'description', 'sku');
  const iAmount = col('amount', 'amount_usd', 'cost', 'cost_usd', 'total', 'total_usd', 'charge');
  const iQty = col('quantity', 'qty', 'usage', 'units_used');
  const iUnit = col('unit', 'uom', 'usage_unit');
  if (iPeriod < 0 || iModel < 0 || iAmount < 0) throw new DomainError('INVALID', 'The header needs month (or date), model and amount columns.');
  return lines.slice(1).map((l, n) => {
    const c = csvLine(l);
    const raw = c[iPeriod] ?? '';
    const m = /^(\d{4})-(\d{2})(?:-\d{2})?/.exec(raw);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new DomainError('INVALID', `Line ${n + 2}: months look like 2026-09 (or a date 2026-09-30).`);
    const amount = Number((c[iAmount] ?? '').replace(/[$,\s]/g, ''));
    if (!Number.isFinite(amount) || amount < 0) throw new DomainError('INVALID', `Line ${n + 2}: amount must be a positive number in USD.`);
    const model = (c[iModel] ?? '').trim();
    if (!model) throw new DomainError('INVALID', `Line ${n + 2}: model is missing.`);
    const qty = iQty >= 0 && c[iQty] ? Number(c[iQty]!.replace(/[,\s]/g, '')) : null;
    return { period: `${m[1]}-${m[2]}-01`, model: model.slice(0, 200), quantity: qty !== null && Number.isFinite(qty) ? qty : null, unit: iUnit >= 0 ? (c[iUnit] || null) : null, amountMicros: Math.round(amount * 1e6) };
  });
}

/** Store an invoice (staff role). Lines for the same month and model add up; a re-import replaces that month × model. */
export async function importProviderInvoice(tx: Tx, provider: string, lines: ProviderInvoiceLine[], by: { staffId: string; batchId: string }) {
  const merged = new Map<string, ProviderInvoiceLine>();
  for (const l of lines) {
    const k = `${l.period}|${l.model}`;
    const prev = merged.get(k);
    merged.set(k, prev ? { ...prev, amountMicros: prev.amountMicros + l.amountMicros, quantity: prev.quantity !== null && l.quantity !== null ? prev.quantity + l.quantity : (prev.quantity ?? l.quantity) } : { ...l });
  }
  for (const l of merged.values()) {
    await tx`insert into provider_invoice_lines (provider, period, model, quantity, unit, amount_micros, import_batch, imported_by)
             values (${provider}, ${l.period}, ${l.model}, ${l.quantity}, ${l.unit}, ${l.amountMicros}, ${by.batchId}, ${by.staffId})
             on conflict (provider, period, model) do update set quantity = excluded.quantity, unit = excluded.unit, amount_micros = excluded.amount_micros,
               import_batch = excluded.import_batch, imported_by = excluded.imported_by, created_at = now()`;
  }
  return merged.size;
}

export interface InvoiceVariance {
  provider: string;
  period: string;
  model: string;
  invoicedMicros: number | null;
  recordedMicros: number;
  calls: number;
  varianceMicros: number | null;
  variancePct: number | null;
}

/** A variance beyond this share of the invoiced amount is flagged. */
export const INVOICE_VARIANCE_TOLERANCE = 0.05;

/**
 * Plan 05 §8: the provider's invoice vs what we recorded (sum of provider_jobs.actual_micros, the source of
 * PROVIDER_COST_RECORDED), per provider × model × UTC month. Invoices name models by their wire id; our jobs record
 * the logical model, so either spelling matches. Months that have an invoice for the provider also list the models
 * we recorded but the invoice doesn't mention.
 */
export async function providerInvoiceVariance(tx: Tx, opts: { months?: number } = {}): Promise<InvoiceVariance[]> {
  const months = opts.months ?? 6;
  const invoiced = await tx`select provider, to_char(period, 'YYYY-MM-DD') as period, model, amount_micros from provider_invoice_lines
                            where period >= date_trunc('month', now() at time zone 'UTC')::date - make_interval(months => ${months})`;
  if (!invoiced.length) return [];
  const recorded = await tx`
    select provider, model, to_char(date_trunc('month', created_at at time zone 'UTC'), 'YYYY-MM-DD') as period,
           coalesce(sum(actual_micros), 0)::bigint as micros, count(*)::int as calls
    from provider_jobs where actual_micros is not null
      and created_at >= (date_trunc('month', now() at time zone 'UTC') - make_interval(months => ${months})) at time zone 'UTC'
    group by 1, 2, 3`;
  const p = await providers();
  const out: InvoiceVariance[] = [];
  const used = new Set<number>();
  for (const inv of invoiced) {
    const matches = recorded
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.provider === inv.provider && r.period === inv.period && (r.model === inv.model || p.wireModel(r.model as string) === inv.model));
    for (const m of matches) used.add(m.idx);
    const rec = matches.reduce((a, m) => a + Number(m.r.micros), 0);
    const calls = matches.reduce((a, m) => a + Number(m.r.calls), 0);
    const inMicros = Number(inv.amount_micros);
    out.push({ provider: inv.provider as string, period: inv.period as string, model: inv.model as string, invoicedMicros: inMicros, recordedMicros: rec, calls, varianceMicros: inMicros - rec, variancePct: inMicros ? (inMicros - rec) / inMicros : rec ? -1 : 0 });
  }
  const invoicedMonths = new Set(invoiced.map((i) => `${i.provider}|${i.period}`));
  recorded.forEach((r, idx) => {
    if (used.has(idx) || !invoicedMonths.has(`${r.provider}|${r.period}`)) return;
    out.push({ provider: r.provider as string, period: r.period as string, model: r.model as string, invoicedMicros: null, recordedMicros: Number(r.micros), calls: Number(r.calls), varianceMicros: null, variancePct: null });
  });
  return out.sort((a, b) => b.period.localeCompare(a.period) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
