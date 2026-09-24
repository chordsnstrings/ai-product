import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { auditView, mrrMovement } from '@arkiv/core';
import { PLANS, type PlanCode } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { dt, Grid, Kpi, money, Mono, Page, Section, Table, Tabs } from '@/components/ui';
import { consolePrefs, daysFrom } from '@/lib/prefs';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Billing' };

/** Plan 05 §7: Stripe mirror, reconciliation exceptions, unmatched events, dunning, revenue. */
export default async function Billing({ searchParams }: { searchParams: Promise<{ tab?: string; days?: string }> }) {
  const s = await requireStaff('billing.read');
  const sp = await searchParams;
  const tab = sp.tab ?? 'revenue';
  const prefs = await consolePrefs();
  const days = daysFrom(sp.days, prefs);
  const tz = prefs.tz;
  const d0 = await withAdmin(async (tx) => {
    await auditView(tx, s, 'billing', { tab, includeTest: prefs.includeTest });
    const t = (col = 'workspace_id') => notTest(tx, prefs, col);
    return {
      subs: await tx`select plan_code, status, count(*)::int as n from subscriptions where true ${t()} group by 1, 2`,
      mrrMove: await mrrMovement(tx, days, { includeTest: prefs.includeTest }),
      movements: await tx`select to_char(date_trunc('month', at, ${tz}) at time zone ${tz}, 'YYYY-MM') as month,
                                 count(*) filter (where type = 'SUBSCRIPTION_STARTED')::int as new,
                                 count(*) filter (where type = 'SUBSCRIPTION_CHANGED' and payload->>'effective' = 'now')::int as expansion,
                                 count(*) filter (where type = 'SUBSCRIPTION_CHANGED' and payload->>'effective' = 'period_end')::int as contraction,
                                 count(*) filter (where type = 'SUBSCRIPTION_CHANGED' and payload->>'cancelAtPeriodEnd' = 'true')::int as cancels
                          from events where type in ('SUBSCRIPTION_STARTED','SUBSCRIPTION_CHANGED') and at > now() - interval '12 months' ${t()} group by 1 order by 1 desc`,
      oneTime: await tx`select to_char(date_trunc('month', paid_at, ${tz}) at time zone ${tz}, 'YYYY-MM') as month, kind, count(*)::int as n, sum(amount_micros)::bigint as amt from purchases where status in ('paid','refunded') ${t()} group by 1, 2 order by 1 desc`,
      unmatched: await tx`select id, type, received_at, attempts, payload->'data'->'object'->>'customer' as customer, payload->'data'->'object'->'metadata'->>'workspace_id' as meta_ws from stripe_events where status = 'unmatched' order by received_at`,
      recon: await tx`
        select 'Paid purchase without project progress' as issue, p.workspace_id, p.id::text as ref, p.paid_at as at from purchases p join projects pr on pr.id = p.project_id
          where p.status = 'paid' and pr.state in ('STORYBOARD_READY') and p.paid_at < now() - interval '15 minutes'
        union all
        select 'Active subscription without period grant', s.workspace_id, s.id::text, s.current_period_start from subscriptions s
          where s.status = 'active' and not exists (select 1 from ledger_entries l where l.workspace_id = s.workspace_id and l.type = 'CREDIT_GRANTED' and l.unit = 'creative_test' and l.period_key = to_char(s.current_period_start, 'YYYY-MM-DD'))
        union all
        select 'Workspace ACTIVE_PAID without subscription', w.id, w.slug, w.updated_at from workspaces w
          where w.state = 'ACTIVE_PAID' and not exists (select 1 from subscriptions s where s.workspace_id = w.id and s.status in ('active','trialing','past_due'))
        union all
        select 'Stripe event failed processing', e.workspace_id, e.id, e.received_at from stripe_events e where e.status = 'failed'`,
      dunning: await tx`select w.id, w.name, s.plan_code, s.current_period_end, (select count(*) from email_log l where l.workspace_id = w.id and l.template = 'payment_failed')::int as emails
                        from workspaces w join subscriptions s on s.workspace_id = w.id and s.status = 'past_due' where (${prefs.includeTest} or not w.is_test) order by s.current_period_end`,
      disputes: await tx`select e.id, e.type, e.received_at, e.workspace_id, w.name from stripe_events e left join workspaces w on w.id = e.workspace_id where e.type like 'charge.dispute%' ${t('e.workspace_id')} order by e.received_at desc limit 50`,
    };
  });
  const active = d0.subs.filter((s) => ['active', 'trialing', 'past_due'].includes(s.status as string));
  const mrr = active.reduce((a, s) => a + PLANS[s.plan_code as PlanCode].priceMicros * Number(s.n), 0);
  return (
    <Page title="Billing & revenue" sub={`Test accounts ${prefs.includeTest ? 'included' : 'excluded'} · months in ${tz}`}>
      <Grid>
        <Kpi label="MRR" value={money(mrr, 0)} sub={`ARR ${money(mrr * 12, 0)}`} />
        <Kpi label={`Net new MRR (${days}d)`} value={money(d0.mrrMove.net, 0)} sub={`new ${money(d0.mrrMove.new, 0)} · expansion ${money(d0.mrrMove.expansion, 0)} · contraction ${money(d0.mrrMove.contraction, 0)} · churned ${money(d0.mrrMove.churned, 0)}`} alert={d0.mrrMove.net < 0} alertText="Shrinking" />
        <Kpi label="Active subscriptions" value={active.reduce((a, s) => a + Number(s.n), 0)} sub={active.map((s) => `${s.plan_code} ${s.n}`).join(' · ')} />
        <Kpi label="Unmatched Stripe events" value={d0.unmatched.length} alert={d0.unmatched.length > 0} />
        <Kpi label="Reconciliation exceptions" value={d0.recon.length} alert={d0.recon.length > 0} />
      </Grid>
      <Tabs label="Billing sections" base="/billing" current={tab} tabs={[['revenue', 'Revenue'], ['unmatched', 'Unmatched events'], ['recon', 'Reconciliation'], ['dunning', 'Dunning'], ['disputes', 'Disputes']]} />
      {tab === 'revenue' ? (
        <>
          <Table head={['Month', 'New subs', 'Upgrades', 'Downgrades', 'Cancels (logo churn)']} rows={d0.movements.map((m) => [m.month as string, m.new as number, m.expansion as number, m.contraction as number, m.cancels as number])} empty="No subscription movement yet." />
          <Section title="One-time revenue"><Table head={['Month', 'Kind', 'Count', 'Amount']} rows={d0.oneTime.map((o) => [o.month as string, o.kind as string, o.n as number, money(o.amt, 0)])} /></Section>
        </>
      ) : null}
      {tab === 'unmatched' ? (
        <Table head={['Received', 'Type', 'Customer', 'Metadata workspace', 'Attempts', 'Assign / ignore']} rows={d0.unmatched.map((e) => [
          dt(e.received_at), e.type as string, <Mono key="c">{(e.customer as string) ?? '—'}</Mono>, <Mono key="m">{(e.meta_ws as string) ?? '—'}</Mono>, e.attempts as number,
          <span key="a" className="ak-stack" style={{ ['--stack' as string]: '6px' }}>
            <ActForm inline action="billing.stripe_assign" extra={{ eventId: e.id }} submit="🔐 Assign (four-eyes)" fields={[{ name: 'workspaceId', label: 'Workspace id', required: true, defaultValue: (e.meta_ws as string) ?? '' }, { name: 'reason', label: 'Reason', required: true }]} />
            <ActButton small action="billing.stripe_ignore" payload={{ eventId: e.id }} reason>Ignore</ActButton>
          </span>,
        ])} empty="No unmatched events. Metadata is never trusted alone: assignment needs a second approver." />
      ) : null}
      {tab === 'recon' ? <Table head={['Issue', 'Workspace', 'Reference', 'Since']} rows={d0.recon.map((r) => [r.issue as string, <Link key="w" href={`/tenants/${r.workspace_id}?tab=billing`}>{String(r.workspace_id ?? '').slice(0, 8)}</Link>, <Mono key="r">{r.ref as string}</Mono>, dt(r.at)])} empty="Payments, grants and entitlements reconcile." /> : null}
      {tab === 'dunning' ? <Table head={['Workspace', 'Plan', 'Period end', 'Payment-failed emails']} rows={d0.dunning.map((x) => [<Link key="w" href={`/tenants/${x.id}?tab=billing`}>{x.name as string}</Link>, x.plan_code as string, dt(x.current_period_end), x.emails as number])} empty="Nobody past due." /> : null}
      {tab === 'disputes' ? <Table head={['Received', 'Event', 'Workspace']} rows={d0.disputes.map((x) => [dt(x.received_at), x.type as string, x.workspace_id ? <Link key="w" href={`/tenants/${x.workspace_id}?tab=billing`}>{(x.name as string) ?? String(x.workspace_id).slice(0, 8)}</Link> : '—'])} empty="No disputes. Evidence pack: delivery timestamps, ASSET_EXPORTED events, consent record and IP are on the tenant's Billing tab." /> : null}
    </Page>
  );
}
