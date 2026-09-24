import { REPEATED_FIDELITY_TARGET, repeatedFidelityFailures } from '@arkiv/core';
import { withAdmin } from '@arkiv/db';
import { PLANS, type PlanCode } from '@arkiv/shared';
import { Grid, Kpi, money, Page, pct, Section, Table, ago } from '@/components/ui';
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

/** Plan 05 §1: is the business healthy right now? Test accounts are excluded from every metric. */
export default async function Pulse({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  await requireStaff('pulse.read');
  const range = ((await searchParams).range ?? '7') as '1' | '7' | '30';
  const days = Number(range) || 7;
  const m = await withAdmin(async (tx) => {
    const test = tx`(select id from workspaces where is_test)`;
    const funnel = await tx`
      select type, count(distinct coalesce(visitor_id, workspace_id::text))::int as n,
             count(distinct coalesce(visitor_id, workspace_id::text)) filter (where at > now() - make_interval(days => ${days * 2}) and at <= now() - make_interval(days => ${days}))::int as prev
      from funnel_events where at > now() - make_interval(days => ${days * 2}) and (workspace_id is null or workspace_id not in ${test})
      group by type`;
    const cur = await tx`
      select type, count(distinct coalesce(visitor_id, workspace_id::text))::int as n
      from funnel_events where at > now() - make_interval(days => ${days}) and (workspace_id is null or workspace_id not in ${test}) group by type`;
    const [rev] = await tx`select coalesce(sum(amount_micros) filter (where kind = 'taste'), 0)::bigint as taste, coalesce(sum(amount_micros), 0)::bigint as total
                           from purchases where status = 'paid' and paid_at > now() - make_interval(days => ${days}) and workspace_id not in ${test}`;
    const subs = await tx`select plan_code, count(*)::int as n from subscriptions where status in ('active','trialing','past_due') and workspace_id not in ${test} group by plan_code`;
    const [newSubs] = await tx`select count(*)::int as n from subscriptions where created_at > now() - make_interval(days => ${days}) and workspace_id not in ${test}`;
    const [jobs] = await tx`select count(*) filter (where state in ('STORYBOARD_APPROVED','RENDER_RESERVED','RENDERING','QA_RUNNING','COMPOSING','PLATFORM_VARIANTS','FINAL_QA'))::int as active,
                                   count(*) filter (where state in ('RENDERING','QA_RUNNING','COMPOSING') and updated_at < now() - interval '20 minutes')::int as stuck from projects`;
    const [outbox] = await tx`select extract(epoch from now() - min(created_at))::int as oldest from outbox where dispatched_at is null`;
    let queued: { oldest: number | null } = { oldest: null };
    try {
      const r = await tx.savepoint((sp) => sp`select extract(epoch from now() - min(created_on))::int as oldest from pgboss.job where state in ('created','retry') and start_after <= now() and name not like '%-dlq'`);
      queued = { oldest: (r[0]?.oldest as number | null) ?? null };
    } catch {
      /* pg-boss schema not visible yet (worker grants on start) */
    }
    const prov = await tx`select provider, count(*)::int as n, count(*) filter (where status = 'failed')::int as failed from provider_jobs where created_at > now() - interval '1 hour' group by provider`;
    const [qa] = await tx`select count(*) filter (where type = 'QA_PASSED')::int as passed, count(*) filter (where type = 'QA_FAILED')::int as failed
                          from events where type in ('QA_PASSED','QA_FAILED') and at > now() - make_interval(days => ${days}) and workspace_id not in ${test}`;
    // Standard §10: repeated product-fidelity failure on < 3% of paid projects.
    const fidelity = await repeatedFidelityFailures(tx, days);
    const [cogs] = await tx`select coalesce(sum(amount), 0)::bigint as spend from ledger_entries where type = 'PROVIDER_COST_RECORDED' and created_at > now() - make_interval(days => ${days}) and workspace_id not in ${test}`;
    const [today] = await tx`select coalesce(sum(amount), 0)::bigint as spend from ledger_entries where type = 'PROVIDER_COST_RECORDED' and created_at > date_trunc('day', now())`;
    const [prior] = await tx`select coalesce(sum(amount), 0)::bigint / 7 as avg from ledger_entries where type = 'PROVIDER_COST_RECORDED' and created_at between date_trunc('day', now()) - interval '7 days' and date_trunc('day', now())`;
    const [exports] = await tx`select count(*)::int as n from events where type = 'COMPOSITION_COMPLETED' and at > now() - make_interval(days => ${days}) and workspace_id not in ${test}`;
    const [conn] = await tx`select count(*)::int as n, count(*) filter (where status = 'active' and last_success_at > now() - interval '7 days')::int as fresh from integrations where status <> 'disconnected'`;
    const [risk] = await tx`select count(*)::int as n from risk_flags where raised_at > date_trunc('day', now()) and resolved_at is null`;
    const queues = await tx`
      select 'Restricted claims' as q, count(*)::int as n, min(created_at) as oldest, '/claims' as href from claims where status = 'RESTRICTED'
      union all select 'Unmatched Stripe', count(*)::int, min(received_at), '/billing?tab=unmatched' from stripe_events where status = 'unmatched'
      union all select 'Data requests', count(*)::int, min(created_at), '/privacy' from data_requests where status in ('open','in_progress')
      union all select 'Abuse signals (24h)', count(*)::int, min(at), '/abuse' from abuse_signals where at > now() - interval '24 hours'
      union all select 'Approvals', count(*)::int, min(created_at), '/approvals' from approvals where status = 'pending'
      union all select 'QA needs review', count(*)::int, min(updated_at), '/qa' from projects where state in ('NEEDS_USER_ACTION','PROVIDER_FAILED') and updated_at > now() - interval '7 days'`;
    return { funnel, cur, rev, subs, newSubs, jobs, outbox, queued, prov, qa, fidelity, cogs, today, prior, exports, conn, risk, queues };
  });
  const count = (t: string) => Number(m.cur.find((r) => r.type === t)?.n ?? 0);
  const prev = (t: string) => Number(m.funnel.find((r) => r.type === t)?.prev ?? 0);
  const mrr = m.subs.reduce((a, s) => a + PLANS[s.plan_code as PlanCode].priceMicros * Number(s.n), 0);
  const qaTotal = Number(m.qa!.passed) + Number(m.qa!.failed);
  const firstPass = qaTotal ? Number(m.qa!.passed) / qaTotal : NaN;
  const costPerExport = Number(m.exports!.n) ? Number(m.cogs!.spend) / Number(m.exports!.n) : NaN;
  const freshPct = Number(m.conn!.n) ? Number(m.conn!.fresh) / Number(m.conn!.n) : NaN;
  const oldestQueued = Math.max(Number(m.outbox?.oldest ?? 0), Number(m.queued?.oldest ?? 0));

  return (
    <Page title="Platform Pulse" sub="Test accounts excluded · times in UTC" actions={['1', '7', '30'].map((r) => <a key={r} className={`ak-chip${r === range ? ' ak-chip--dec' : ''}`} href={`/?range=${r}`}>{r === '1' ? 'Today' : `${r}d`}</a>)}>
      <Section title="Funnel">
        <div className="ak-scroll-x">
          <table className="ak-table">
            <thead><tr><th>Stage</th>{STAGES.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
            <tbody>
              <tr><td>Count</td>{STAGES.map(([t]) => <td key={t} className="ak-mono">{count(t)}</td>)}</tr>
              <tr>
                <td>Stage conversion</td>
                {STAGES.map(([t], i) => {
                  if (i === 0) return <td key={t}>—</td>;
                  const c = count(STAGES[i - 1]![0]) ? count(t) / count(STAGES[i - 1]![0]) : NaN;
                  const p = prev(STAGES[i - 1]![0]) ? prev(t) / prev(STAGES[i - 1]![0]) : NaN;
                  const drop = Number.isFinite(c) && Number.isFinite(p) && p > 0 && c < p * 0.75;
                  return <td key={t} className="ak-mono" style={{ color: drop ? 'var(--risk)' : undefined }}>{pct(c)}{drop ? ' ▼' : ''}</td>;
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Business">
        <Grid>
          <Kpi label="Taste revenue" value={money(m.rev!.taste, 0)} sub={`all one-time ${money(m.rev!.total, 0)}`} href="/billing" />
          <Kpi label="MRR" value={money(mrr, 0)} sub={`${m.subs.reduce((a, s) => a + Number(s.n), 0)} subscriptions · ${m.newSubs!.n} new`} href="/billing" />
          <Kpi label="Cost per usable export" value={Number.isFinite(costPerExport) ? money(costPerExport) : '—'} alert={costPerExport > 8_500_000} sub={`${m.exports!.n} exports · COGS ${money(m.cogs!.spend, 0)}`} href="/ledger" />
          <Kpi label="Provider spend today" value={money(m.today!.spend)} alert={Number(m.prior!.avg) > 0 && Number(m.today!.spend) > Number(m.prior!.avg) * 1.3} sub={`7d daily avg ${money(m.prior!.avg)}`} href="/ledger" />
        </Grid>
      </Section>
      <Section title="Production">
        <Grid>
          <Kpi label="Active jobs" value={m.jobs!.active} sub={`${m.jobs!.stuck} stuck > 20 min`} alert={Number(m.jobs!.stuck) > 0} href="/jobs" />
          <Kpi label="Oldest queued" value={oldestQueued ? ago(new Date(Date.now() - oldestQueued * 1000)) : '—'} alert={oldestQueued > 600} href="/jobs" />
          <Kpi label="QA first-pass" value={pct(firstPass, 0)} alert={Number.isFinite(firstPass) && firstPass < 0.7} sub={`${qaTotal} scene checks`} href="/qa" />
          <Kpi label="Repeated fidelity fails" value={pct(m.fidelity.rate)} alert={Number.isFinite(m.fidelity.rate) && m.fidelity.rate > REPEATED_FIDELITY_TARGET} sub={`${m.fidelity.repeated} of ${m.fidelity.paid} paid projects · target < ${pct(REPEATED_FIDELITY_TARGET, 0)}`} href="/qa" />
          <Kpi label="Connector freshness" value={pct(freshPct, 0)} alert={Number.isFinite(freshPct) && freshPct < 0.9} sub={`${m.conn!.fresh}/${m.conn!.n} fresh`} href="/integrations" />
          <Kpi label="Churn-risk (new today)" value={m.risk!.n} href="/retention" />
        </Grid>
        <div style={{ marginTop: 12 }}>
          <Table head={['Provider (1h)', 'Jobs', 'Failed', 'Failure rate']} rows={m.prov.map((p) => [p.provider as string, p.n as number, p.failed as number, <span key="r" style={{ color: Number(p.failed) / Number(p.n) > 0.05 ? 'var(--risk)' : undefined }}>{pct(Number(p.failed) / Number(p.n))}</span>])} empty="No provider calls in the last hour." />
        </div>
      </Section>
      <Section title="Open queues">
        <Table head={['Queue', 'Open', 'Oldest']} rows={m.queues.map((q) => [<a key="q" href={q.href as string}>{q.q as string}</a>, q.n as number, ago(q.oldest)])} />
      </Section>
    </Page>
  );
}
