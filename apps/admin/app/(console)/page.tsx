import { withAdmin } from '@arkiv/db';
import { ACTIVE_PRODUCTION_STATES, mrrMovement, qaQueueSql } from '@arkiv/core';
import { PLANS, type PlanCode, type ProjectState } from '@arkiv/shared';
import { ago, FilterChip, Grid, Kpi, money, Page, pct, Section, Table } from '@/components/ui';
import { consolePrefs, daysFrom } from '@/lib/prefs';
import { conversionDrop, hardFailAlert, SLA_HOURS, slaBreach } from '@/lib/pulse';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Pulse' };

const STAGES = [
  ['LP_VIEWED', 'Visitors'],
  ['UPLOAD_STARTED', 'Upload'],
  ['CONCEPTS_READY', 'Concepts'],
  ['STORYBOARD_READY', 'Storyboard'],
  ['TASTE_PAID', 'Taste'],
  ['SUBSCRIPTION_STARTED', 'Subscribed'],
] as const;

/**
 * Plan 05 §1: is the business healthy right now? Range and timezone come from the console-wide selector (a
 * ?range= link overrides); test accounts are excluded unless the console preference includes them. Every tile
 * links to its module, pre-filtered.
 */
export default async function Pulse({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  await requireStaff('pulse.read');
  const prefs = await consolePrefs();
  const days = daysFrom((await searchParams).range, prefs, 30);
  const tz = prefs.tz;
  const m = await withAdmin(async (tx) => {
    const t = (col = 'workspace_id') => notTest(tx, prefs, col);
    // Current window, and the fixed trailing 7 days before it as the baseline for stage conversion.
    const funnel = await tx`
      select type,
             count(distinct coalesce(visitor_id, workspace_id::text)) filter (where at > now() - make_interval(days => ${days}))::int as n,
             count(distinct coalesce(visitor_id, workspace_id::text)) filter (where at <= now() - make_interval(days => ${days}))::int as base
      from funnel_events where at > now() - make_interval(days => ${days + 7}) ${t()} group by type`;
    const [rev] = await tx`select coalesce(sum(amount_micros) filter (where kind = 'taste'), 0)::bigint as taste, coalesce(sum(amount_micros), 0)::bigint as total
                           from purchases where status = 'paid' and paid_at > now() - make_interval(days => ${days}) ${t()}`;
    const subs = await tx`select plan_code, count(*)::int as n from subscriptions where status in ('active','trialing','past_due') ${t()} group by plan_code`;
    const mrrMove = await mrrMovement(tx, days, { includeTest: prefs.includeTest });
    const jobs = await tx`select state, count(*)::int as n, count(*) filter (where updated_at < now() - interval '20 minutes' and state in ('RENDERING','QA_RUNNING','COMPOSING'))::int as stuck
                          from projects where state in ${tx(ACTIVE_PRODUCTION_STATES as ProjectState[])} ${t()} group by state`;
    const [outbox] = await tx`select extract(epoch from now() - min(created_at))::int as oldest from outbox where dispatched_at is null`;
    let queued: { oldest: number | null } = { oldest: null };
    try {
      const r = await tx.savepoint((sp) => sp`select extract(epoch from now() - min(created_on))::int as oldest from pgboss.job where state in ('created','retry') and start_after <= now() and name not like '%-dlq'`);
      queued = { oldest: (r[0]?.oldest as number | null) ?? null };
    } catch {
      /* pg-boss schema not visible yet (worker grants on start) */
    }
    const prov = await tx`select provider, count(*)::int as n, count(*) filter (where status = 'failed')::int as failed from provider_jobs where created_at > now() - interval '1 hour' ${t()} group by provider`;
    const [qa] = await tx`select count(*) filter (where type = 'QA_PASSED')::int as passed, count(*) filter (where type = 'QA_FAILED')::int as failed,
                                 count(*) filter (where type = 'QA_FAILED' and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(payload->'checks') = 'array' then payload->'checks' else '[]'::jsonb end) c
                                   where c->>'check' = 'product_fidelity' and coalesce((c->>'hard')::boolean, false) and not coalesce((c->>'pass')::boolean, true)))::int as hard
                          from events where type in ('QA_PASSED','QA_FAILED') and at > now() - make_interval(days => ${days}) ${t()}`;
    const [cogs] = await tx`select coalesce(sum(amount), 0)::bigint as spend from ledger_entries where type = 'PROVIDER_COST_RECORDED' and created_at > now() - make_interval(days => ${days}) ${t()}`;
    // "Today" and the forecast baseline use calendar days in the console timezone.
    const [today] = await tx`select coalesce(sum(amount), 0)::bigint as spend from ledger_entries where type = 'PROVIDER_COST_RECORDED' and created_at >= date_trunc('day', now(), ${tz}) ${t()}`;
    const [prior] = await tx`select coalesce(sum(amount), 0)::bigint / 7 as avg from ledger_entries where type = 'PROVIDER_COST_RECORDED'
                             and created_at >= date_trunc('day', now(), ${tz}) - interval '7 days' and created_at < date_trunc('day', now(), ${tz}) ${t()}`;
    const [exports] = await tx`select count(*)::int as n from events where type = 'COMPOSITION_COMPLETED' and at > now() - make_interval(days => ${days}) ${t()}`;
    const [conn] = await tx`select count(*)::int as n, count(*) filter (where status = 'active' and last_success_at > now() - interval '7 days')::int as fresh from integrations where status <> 'disconnected' ${t()}`;
    const [risk] = await tx`select count(*)::int as n from risk_flags where raised_at >= date_trunc('day', now(), ${tz}) and resolved_at is null ${t()}`;
    const queues = await tx`
      select 'Restricted claims' as q, count(*)::int as n, min(created_at) as oldest, '/claims' as href from claims where status = 'RESTRICTED' ${t()}
      union all select 'QA review', count(*)::int, min(updated_at), '/qa' from (${qaQueueSql(tx, { includeTest: prefs.includeTest })}) qa
      union all select 'Unmatched Stripe', count(*)::int, min(received_at), '/billing?tab=unmatched' from stripe_events where status = 'unmatched'
      union all select 'Data requests', count(*)::int, min(created_at), '/privacy' from data_requests where status in ('open','in_progress') ${t()}
      union all select 'Abuse signals (24h)', count(*)::int, min(at), '/abuse' from abuse_signals where at > now() - interval '24 hours' ${t()}
      union all select 'Approvals', count(*)::int, min(created_at), '/approvals' from approvals where status = 'pending'`;
    return { funnel, rev, subs, mrrMove, jobs, outbox, queued, prov, qa, cogs, today, prior, exports, conn, risk, queues };
  });
  const count = (t: string) => Number(m.funnel.find((r) => r.type === t)?.n ?? 0);
  const base = (t: string) => Number(m.funnel.find((r) => r.type === t)?.base ?? 0);
  const mrr = m.subs.reduce((a, s) => a + PLANS[s.plan_code as PlanCode].priceMicros * Number(s.n), 0);
  const qaTotal = Number(m.qa!.passed) + Number(m.qa!.failed);
  const firstPass = qaTotal ? Number(m.qa!.passed) / qaTotal : NaN;
  const hardRate = qaTotal ? Number(m.qa!.hard) / qaTotal : NaN;
  const costPerExport = Number(m.exports!.n) ? Number(m.cogs!.spend) / Number(m.exports!.n) : NaN;
  const freshPct = Number(m.conn!.n) ? Number(m.conn!.fresh) / Number(m.conn!.n) : NaN;
  const oldestQueued = Math.max(Number(m.outbox?.oldest ?? 0), Number(m.queued?.oldest ?? 0));
  const activeJobs = m.jobs.reduce((a, j) => a + Number(j.n), 0);
  const stuck = m.jobs.reduce((a, j) => a + Number(j.stuck), 0);
  const byState = ACTIVE_PRODUCTION_STATES.map((st) => [st, Number(m.jobs.find((j) => j.state === st)?.n ?? 0)] as const).filter(([, n]) => n > 0);
  const spendAlert = Number(m.prior!.avg) > 0 && Number(m.today!.spend) > Number(m.prior!.avg) * 1.3;
  const signed = (micros: number) => `${micros < 0 ? '−' : '+'}${money(Math.abs(micros), 0)}`;

  return (
    <Page
      title="Platform Pulse"
      sub={`Last ${days === 1 ? 'day' : `${days} days`} · test accounts ${prefs.includeTest ? 'included' : 'excluded'} · days in ${tz}`}
      actions={<nav aria-label="Range" className="ak-row" style={{ gap: 6 }}>{[1, 7, 30].map((r) => <FilterChip key={r} on={r === days} href={`/?range=${r}`}>{r === 1 ? 'Today' : `${r}d`}</FilterChip>)}</nav>}
    >
      <Section title="Funnel" right={<a className="ak-small" href={`/funnel?days=${days}`}>Open funnel</a>}>
        <div className="ak-scroll-x">
          <table className="ak-table">
            <thead><tr><th>Stage</th>{STAGES.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
            <tbody>
              <tr><td>Count</td>{STAGES.map(([t]) => <td key={t} className="ak-mono">{count(t)}</td>)}</tr>
              <tr>
                <td>Stage conversion (vs trailing 7d)</td>
                {STAGES.map(([t], i) => {
                  if (i === 0) return <td key={t}>—</td>;
                  const prevStage = STAGES[i - 1]![0];
                  const c = count(prevStage) ? count(t) / count(prevStage) : NaN;
                  const b = base(prevStage) ? base(t) / base(prevStage) : NaN;
                  const drop = conversionDrop(c, b);
                  return <td key={t} className="ak-mono" style={{ color: drop ? 'var(--risk)' : undefined }}>{pct(c)}{Number.isFinite(b) ? <span className="ak-muted"> ({pct(b)})</span> : null}{drop ? <> ▼<span className="ak-sr"> more than 25% below the 7-day baseline</span></> : null}</td>;
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Business">
        <Grid>
          <Kpi label="Taste revenue" value={money(m.rev!.taste, 0)} sub={`all one-time ${money(m.rev!.total, 0)}`} href={`/billing?tab=revenue`} />
          <Kpi label="Subscription MRR" value={money(mrr, 0)} sub={`${m.subs.reduce((a, s) => a + Number(s.n), 0)} subscriptions`} href="/billing?tab=revenue" />
          <Kpi label="Net new MRR" value={signed(m.mrrMove.net)} sub={`new ${money(m.mrrMove.new, 0)} · expansion ${money(m.mrrMove.expansion, 0)} · contraction ${money(m.mrrMove.contraction, 0)} · churned ${money(m.mrrMove.churned, 0)}`} alert={m.mrrMove.net < 0} alertText="Shrinking" href="/billing?tab=revenue" />
          <Kpi label="Cost per usable export" value={Number.isFinite(costPerExport) ? money(costPerExport) : '—'} alert={costPerExport > 8_500_000} alertText="Above $8.50" sub={`${m.exports!.n} exports · COGS ${money(m.cogs!.spend, 0)}`} href={`/ledger?tab=cogs&days=${days}`} />
          <Kpi label="Provider spend today" value={money(m.today!.spend)} alert={spendAlert} alertText="Over 130% of forecast" sub={`forecast (7d daily avg) ${money(m.prior!.avg)}`} href="/ledger?tab=cogs&days=1" />
        </Grid>
      </Section>
      <Section title="Production">
        <Grid>
          <Kpi label="Active jobs" value={activeJobs} sub={byState.length ? byState.map(([st, n]) => `${st.toLowerCase().replace(/_/g, ' ')} ${n}`).join(' · ') : 'none in flight'} href="/jobs" />
          <Kpi label="Stuck > 20 min" value={stuck} alert={stuck > 0} alertText="Stuck" href="/jobs?stuck=1" />
          <Kpi label="Oldest queued" value={oldestQueued ? ago(new Date(Date.now() - oldestQueued * 1000)) : '—'} alert={oldestQueued > 600} alertText="Over 10 min" href="/jobs" />
          <Kpi label="QA first-pass" value={pct(firstPass, 0)} alert={Number.isFinite(firstPass) && firstPass < 0.7} alertText="Below 70%" sub={`${qaTotal} checks`} href="/qa" />
          <Kpi label="Hard fidelity fails" value={pct(hardRate)} alert={hardFailAlert(Number(m.qa!.hard), qaTotal)} alertText="Above 3%" sub={`${m.qa!.hard} of ${qaTotal}`} href="/qa" />
          <Kpi label="Connector freshness" value={pct(freshPct, 0)} alert={Number.isFinite(freshPct) && freshPct < 0.9} alertText="Below 90%" sub={`${m.conn!.fresh}/${m.conn!.n} fresh`} href="/integrations?stale=1" />
          <Kpi label="Churn-risk (new today)" value={m.risk!.n} href="/retention?since=today" />
        </Grid>
        <div style={{ marginTop: 12 }}>
          <Table head={['Provider (1h)', 'Jobs', 'Failed', 'Failure rate']} rows={m.prov.map((p) => {
            const high = Number(p.failed) / Number(p.n) > 0.05;
            return [p.provider as string, p.n as number, p.failed as number, <span key="r" style={{ color: high ? 'var(--risk)' : undefined }}>{pct(Number(p.failed) / Number(p.n))}{high ? ' ⚠ above 5%' : ''}</span>];
          })} empty="No provider calls in the last hour." />
        </div>
      </Section>
      <Section title="Open queues">
        <Table head={['Queue', 'Open', 'Oldest', 'SLA', '']} rows={m.queues.map((q) => {
          const sla = SLA_HOURS[q.q as string];
          const breach = slaBreach(q.q as string, Number(q.n), (q.oldest as string) ?? null);
          return [<a key="q" href={q.href as string}>{q.q as string}</a>, q.n as number, ago(q.oldest), sla ? `${sla >= 48 ? `${Math.round(sla / 24)}d` : `${sla}h`}` : '—', breach ? <span key="b" className="ak-chip ak-chip--risk"><span aria-hidden="true">⚠</span> SLA breach</span> : ''];
        })} />
      </Section>
    </Page>
  );
}
