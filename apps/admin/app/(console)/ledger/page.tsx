import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { dt, money, Mono, Page, pct, Section, Table, Tabs } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Ledger & COGS' };

/** Plan 05 §8: never editable; corrections are new rows. COGS by provider/model/workspace; margin; stranded reservations. */
export default async function Ledger({ searchParams }: { searchParams: Promise<{ tab?: string; ws?: string; type?: string }> }) {
  await requireStaff('ledger.read');
  const sp = await searchParams;
  const tab = sp.tab ?? 'cogs';
  const d0 = await withAdmin(async (tx) => ({
    byModel: await tx`select j.provider, j.model, j.task, count(*)::int as calls, coalesce(sum(j.actual_micros), 0)::bigint as spend, avg(j.latency_ms)::int as latency,
                             count(*) filter (where j.status = 'failed')::int as failed
                      from provider_jobs j where j.created_at > now() - interval '30 days' group by 1, 2, 3 order by spend desc`,
    trend: await tx`
      with spend as (select date_trunc('week', created_at) as wk, sum(amount)::bigint as spend,
                            coalesce(sum(amount) filter (where reason ilike '%retry%' or reason ilike '%repair%'), 0)::bigint as retry_spend
                     from ledger_entries where type = 'PROVIDER_COST_RECORDED' and created_at > now() - interval '12 weeks' group by 1),
           ex as (select date_trunc('week', at) as wk, count(*)::int as exports from events where type = 'COMPOSITION_COMPLETED' and at > now() - interval '12 weeks' group by 1)
      select to_char(s.wk, 'YYYY-MM-DD') as week, s.spend, coalesce(ex.exports, 0) as exports, s.retry_spend from spend s left join ex on ex.wk = s.wk order by s.wk desc`,
    margin: await tx`select w.id, w.name, w.plan_code,
                            coalesce((select sum(amount_micros) from purchases p where p.workspace_id = w.id and p.status = 'paid' and p.paid_at > now() - interval '30 days'), 0)::bigint
                              + case w.plan_code when 'LAUNCH' then 49000000 when 'GROWTH' then 99000000 when 'SCALE' then 199000000 else 0 end * (w.state in ('ACTIVE_PAID','PAST_DUE'))::int as revenue,
                            coalesce((select sum(amount) from ledger_entries l where l.workspace_id = w.id and l.type = 'PROVIDER_COST_RECORDED' and l.created_at > now() - interval '30 days'), 0)::bigint as cogs
                     from workspaces w where not w.is_test order by cogs desc limit 100`,
    stranded: await tx`select a.id, a.workspace_id, a.purpose, a.max_cost_micros, a.spent_micros, a.expires_at, a.status, w.name from cost_authorizations a join workspaces w on w.id = a.workspace_id
                       where a.status = 'active' and a.expires_at < now() order by a.expires_at limit 100`,
    sweeps: await tx`select type, count(*)::int as n from ledger_entries where actor like 'system:%' and type in ('CREDIT_RELEASED','CREDIT_EXPIRED') and created_at > now() - interval '7 days' group by 1`,
    entries: tab === 'explorer' ? await tx`select l.*, w.name from ledger_entries l join workspaces w on w.id = l.workspace_id
                                          where (${sp.ws ?? ''} = '' or l.workspace_id::text = ${sp.ws ?? ''}) and (${sp.type ?? ''} = '' or l.type = ${sp.type ?? ''}) order by l.id desc limit 300` : [],
  }));
  return (
    <Page title="Usage ledger & COGS">
      <Tabs base="/ledger" current={tab} tabs={[['cogs', 'COGS'], ['margin', 'Margin'], ['stranded', 'Stranded reservations'], ['explorer', 'Ledger explorer']]} />
      {tab === 'cogs' ? (
        <>
          <Table head={['Week', 'Provider spend', 'Exports', 'Cost / usable export', 'QA retry share']} rows={d0.trend.map((t) => [t.week as string, money(t.spend), t.exports as number, Number(t.exports) ? money(Number(t.spend) / Number(t.exports)) : '—', pct(Number(t.spend) ? Number(t.retry_spend) / Number(t.spend) : NaN)])} empty="No provider spend yet." />
          <Section title="By provider / model / task (30d)">
            <Table head={['Provider', 'Model', 'Task', 'Calls', 'Failed', 'Spend', 'Avg latency']} rows={d0.byModel.map((m) => [m.provider as string, <Mono key="m">{m.model as string}</Mono>, m.task as string, m.calls as number, m.failed as number, money(m.spend), m.latency ? `${m.latency}ms` : '—'])} />
          </Section>
        </>
      ) : null}
      {tab === 'margin' ? <Table head={['Workspace', 'Plan', '30d revenue', '30d COGS', 'Margin']} rows={d0.margin.map((m) => { const mg = Number(m.revenue) ? (Number(m.revenue) - Number(m.cogs)) / Number(m.revenue) : null; return [<Link key="w" href={`/tenants/${m.id}?tab=ledger`}>{m.name as string}</Link>, (m.plan_code as string) ?? '—', money(m.revenue, 0), money(m.cogs), <span key="g" style={{ color: mg !== null && mg < 0 ? 'var(--risk)' : undefined }}>{mg === null ? (Number(m.cogs) ? 'free usage' : '—') : pct(mg, 0)}</span>]; })} /> : null}
      {tab === 'stranded' ? (
        <>
          <p className="ak-small">The sweeper settles expired authorizations every few minutes. Last 7 days it wrote: {d0.sweeps.map((s) => `${s.type} ×${s.n}`).join(', ') || 'nothing'}.</p>
          <Table head={['Authorization', 'Workspace', 'Purpose', 'Ceiling', 'Spent', 'Expired']} rows={d0.stranded.map((a) => [<Mono key="i">{String(a.id).slice(0, 8)}</Mono>, <Link key="w" href={`/tenants/${a.workspace_id}?tab=ledger`}>{a.name as string}</Link>, a.purpose as string, money(a.max_cost_micros), money(a.spent_micros), dt(a.expires_at)])} empty="No stranded reservations — the sweeper is keeping up." />
        </>
      ) : null}
      {tab === 'explorer' ? (
        <>
          <form className="ak-row" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="explorer" /><input className="ak-input" name="ws" placeholder="Workspace id" defaultValue={sp.ws} /><input className="ak-input" name="type" placeholder="Type e.g. CREDIT_RESERVED" defaultValue={sp.type} /><button className="ak-btn ak-btn--sm">Filter</button></form>
          <Table head={['#', 'When', 'Workspace', 'Type', 'Unit', 'Amount', 'Period', 'Authorization', 'Reason', 'Actor']} rows={d0.entries.map((e) => [e.id as number, dt(e.created_at), e.name as string, <Mono key="t">{e.type as string}</Mono>, e.unit as string, e.unit === 'usd_micros' ? money(e.amount, 4) : String(e.amount), (e.period_key as string) ?? '—', <Mono key="a">{String(e.authorization_id ?? '').slice(0, 8)}</Mono>, (e.reason as string) ?? '', <Mono key="ac">{e.actor as string}</Mono>])} />
        </>
      ) : null}
    </Page>
  );
}
