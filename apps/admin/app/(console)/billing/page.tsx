import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { auditView, currentPlanPrices, PRICE_NOTICE_DAYS, classifySubscriptionEvents, mrrReport, mrrTotals, reconciliationExceptions, subscriptionEvents } from '@arkiv/core';
import { assembleDisputeEvidence, DISPUTE_OPEN } from '@arkiv/billing';
import { PLANS, type PlanCode } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { dt, Grid, Kpi, money, Mono, Page, pct, Section, Table, Tabs } from '@/components/ui';
import { consolePrefs, daysFrom } from '@/lib/prefs';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Billing' };

const signed = (micros: number) => (micros ? `${micros < 0 ? '−' : '+'}${money(Math.abs(micros), 0)}` : '—');

/** Plan 05 §7: Stripe mirror, reconciliation exceptions, unmatched events, dunning, revenue, disputes. */
export default async function Billing({ searchParams }: { searchParams: Promise<{ tab?: string; days?: string; dispute?: string; ws?: string }> }) {
  const s = await requireStaff('billing.read');
  const sp = await searchParams;
  const tab = sp.tab ?? 'revenue';
  const prefs = await consolePrefs();
  const days = daysFrom(sp.days, prefs);
  const tz = prefs.tz;
  const d0 = await withAdmin(async (tx) => {
    // Viewing a dispute's evidence pack is a view of that tenant's data (§0.4): logged against the workspace.
    const packWs = tab === 'disputes' && sp.dispute && /^[0-9a-f-]{36}$/i.test(sp.ws ?? '') ? sp.ws! : null;
    await auditView(tx, s, 'billing', { tab, includeTest: prefs.includeTest, dispute: packWs ? sp.dispute : undefined }, packWs);
    const t = (col = 'workspace_id') => notTest(tx, prefs, col);
    const moves = classifySubscriptionEvents(await subscriptionEvents(tx, { includeTest: prefs.includeTest }));
    return {
      subs: await tx`select plan_code, status, count(*)::int as n from subscriptions where true ${t()} group by 1, 2`,
      mrrMove: mrrTotals(moves, new Date(Date.now() - days * 86400_000)),
      report: tab === 'revenue' ? mrrReport(moves, { months: 12, tz }) : null,
      oneTime: tab === 'revenue' ? await tx`select to_char(date_trunc('month', paid_at, ${tz}) at time zone ${tz}, 'YYYY-MM') as month, kind, count(*)::int as n, sum(amount_micros)::bigint as amt from purchases where status in ('paid','refunded') ${t()} group by 1, 2 order by 1 desc` : [],
      unmatched: await tx`select id, type, received_at, attempts, payload->'data'->'object'->>'customer' as customer, payload->'data'->'object'->'metadata'->>'workspace_id' as meta_ws from stripe_events where status = 'unmatched' order by received_at`,
      recon: await reconciliationExceptions(tx, { includeTest: prefs.includeTest }),
      stripeRecon: await tx`select e.id, e.kind, e.stripe_id, e.workspace_id, e.detail, e.created_at, e.last_seen_at, w.name from stripe_recon_exceptions e left join workspaces w on w.id = e.workspace_id
                            where e.resolved_at is null order by e.created_at desc limit 200`,
      lastRun: (await tx`select started_at, finished_at, status, counts, error from stripe_recon_runs order by started_at desc limit 1`)[0] ?? null,
      // §7 Dunning: past-due workspaces with Stripe's retry schedule and the payment-failed emails sent.
      dunning: await tx`select w.id, w.name, s.plan_code, s.current_period_end, s.payment_attempt_count, s.next_payment_attempt,
                               (select count(*) from email_log l where l.workspace_id = w.id and l.template = 'payment_failed')::int as emails,
                               (select max(l.created_at) from email_log l where l.workspace_id = w.id and l.template = 'payment_failed') as last_email
                        from workspaces w join subscriptions s on s.workspace_id = w.id and s.status = 'past_due' where (${prefs.includeTest} or not w.is_test) order by s.next_payment_attempt nulls first`,
      disputes: await tx`select d.id, d.workspace_id, d.status, d.reason, d.amount_cents, d.evidence_due_by, d.evidence_submitted_at, d.stripe_created_at, w.name
                         from stripe_disputes d join workspaces w on w.id = d.workspace_id where true ${t('d.workspace_id')} order by d.stripe_created_at desc nulls last limit 100`,
      // Plan 04 §3 price versions and the subscriber notices each one produced.
      prices: tab === 'prices' ? await tx`select v.*, st.name as by_name,
                                                 (select count(*) from price_change_notices n where n.plan_price_id = v.id)::int as notices,
                                                 (select count(*) from price_change_notices n where n.plan_price_id = v.id and n.applied_at is not null)::int as applied
                                          from plan_prices v left join staff_users st on st.id = v.created_by order by v.effective_from desc` : [],
      current: tab === 'prices' ? await currentPlanPrices(tx) : null,
      pack: packWs ? await tx.savepoint((sp2) => assembleDisputeEvidence(sp2, packWs, sp.dispute!)).catch(() => null) : null,
    };
  });
  const active = d0.subs.filter((x) => ['active', 'trialing', 'past_due'].includes(x.status as string));
  const mrr = active.reduce((a, x) => a + PLANS[x.plan_code as PlanCode].priceMicros * Number(x.n), 0);
  const openRecon = d0.recon.length + d0.stripeRecon.length;
  return (
    <Page title="Billing & revenue" sub={`Test accounts ${prefs.includeTest ? 'included' : 'excluded'} · months in ${tz}`}>
      <Grid>
        <Kpi label="MRR" value={money(mrr, 0)} sub={`ARR ${money(mrr * 12, 0)}`} />
        <Kpi label={`Net new MRR (${days}d)`} value={money(d0.mrrMove.net, 0)} sub={`new ${money(d0.mrrMove.new, 0)} · expansion ${money(d0.mrrMove.expansion, 0)} · contraction ${money(d0.mrrMove.contraction, 0)} · churned ${money(d0.mrrMove.churned, 0)}`} alert={d0.mrrMove.net < 0} alertText="Shrinking" />
        <Kpi label="Active subscriptions" value={active.reduce((a, x) => a + Number(x.n), 0)} sub={active.map((x) => `${x.plan_code} ${x.n}`).join(' · ')} />
        <Kpi label="Unmatched Stripe events" value={d0.unmatched.length} alert={d0.unmatched.length > 0} />
        <Kpi label="Reconciliation exceptions" value={openRecon} alert={openRecon > 0} sub={d0.lastRun ? `Stripe check ${d0.lastRun.status} ${dt(d0.lastRun.finished_at ?? d0.lastRun.started_at)}` : 'Stripe check not run yet'} />
      </Grid>
      <Tabs label="Billing sections" base="/billing" current={tab} tabs={[['revenue', 'Revenue'], ['unmatched', 'Unmatched events'], ['recon', 'Reconciliation'], ['dunning', 'Dunning'], ['disputes', 'Disputes'], ['prices', 'Plan prices']]} />
      {tab === 'prices' && d0.current ? (
        <>
          <Section title="Current prices">
            <Table head={['Plan', 'Price today', 'Built-in price']} rows={(Object.keys(PLANS) as PlanCode[]).map((p) => [PLANS[p].name, `${money(d0.current![p], 0)}/mo`, `${money(PLANS[p].priceMicros, 0)}/mo`])} />
          </Section>
          <Section title="Price versions and subscriber notices">
            <Table
              head={['Plan', 'Price', 'Effective from', 'Stripe price', 'Notices sent', 'Applied', 'By', 'Reason']}
              rows={d0.prices.map((v) => [v.plan_code as string, `${money(v.price_micros, 0)}/mo`, dt(v.effective_from), <Mono key="p">{(v.stripe_price_id as string) ?? '—'}</Mono>, v.notices as number, v.applied as number, (v.by_name as string) ?? '—', v.reason as string])}
              empty="No price changes yet: plans sell at their built-in prices."
            />
          </Section>
          <Section title="Schedule a price change">
            <div className="ak-panel" style={{ maxWidth: 560 }}>
              <p className="ak-small ak-muted" style={{ marginTop: 0 }}>At least {PRICE_NOTICE_DAYS} days out. Once another FINANCE member approves, every live subscriber of the plan is emailed notice; each moves to the new price at their first renewal on or after the date (no proration). New subscribers pay it from the date. Create the price in Stripe first.</p>
              <ActForm action="plan.price_schedule" submit="🔐 Request price change" fields={[
                { name: 'plan', label: 'Plan', type: 'select', options: Object.keys(PLANS) },
                { name: 'price', label: 'New monthly price (USD)', required: true },
                { name: 'effectiveOn', label: 'Effective on (YYYY-MM-DD)', required: true },
                { name: 'stripePriceId', label: 'Stripe price id', placeholder: 'price_…' },
                { name: 'reason', label: 'Reason', type: 'textarea', required: true },
              ]} />
            </div>
          </Section>
        </>
      ) : null}
      {tab === 'revenue' && d0.report ? (
        <>
          <p className="ak-small ak-muted">MRR movements from subscription events, priced at each plan’s price. Scheduled downgrades and cancellations move no MRR until they take effect (shown separately); logo churn counts customers, revenue churn counts money.</p>
          <Table head={['Month', 'Start MRR', 'New', 'Reactivation', 'Expansion', 'Contraction', 'Churned', 'Net new', 'End MRR', 'Logo churn', 'Revenue churn (gross / net)', 'Scheduled: downgrades · cancels']} rows={d0.report.months.map((m) => [
            m.month, money(m.startMrr, 0), signed(m.new), signed(m.reactivation), signed(m.expansion), signed(-m.contraction), signed(-m.churned), signed(m.net), money(m.endMrr, 0),
            m.logoChurn === null ? '—' : `${pct(m.logoChurn)} (${m.churnedLogos}/${m.startLogos})`,
            m.revenueChurn === null ? '—' : `${pct(m.revenueChurn)} / ${pct(m.netRevenueChurn ?? NaN)}`,
            `${m.downgradesScheduled} · ${m.cancelsScheduled}`,
          ])} empty="No subscription movement yet." />
          <div className="ak-grid-2" style={{ alignItems: 'start' }}>
            <Section title="By plan (last 12 months)">
              <Table head={['Plan', 'Subscriptions', 'MRR now', 'New', 'Expansion in', 'Contraction to', 'Churned', 'Net']} rows={d0.report.byPlan.map((p) => [PLANS[p.plan as PlanCode]?.name ?? p.plan, p.subscriptions, money(p.mrr, 0), signed(p.new), signed(p.expansion), signed(-p.contraction), signed(-p.churned), signed(p.net)])} />
            </Section>
            <Section title="By cohort (month of first subscription)">
              <Table head={['Cohort', 'Started', 'Still subscribed', 'MRR at start', 'MRR now', 'Net revenue retention']} rows={d0.report.cohorts.map((c) => [c.cohort, c.started, `${c.active} (${pct(c.started ? c.active / c.started : NaN, 0)})`, money(c.startMrr, 0), money(c.mrrNow, 0), pct(c.netRetention ?? NaN, 0)])} empty="No cohorts yet." />
            </Section>
          </div>
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
      {tab === 'recon' ? (
        <>
          <Section title="Payments ↔ ledger grants ↔ entitlements">
            <Table head={['Issue', 'Workspace', 'Reference', 'Since']} rows={d0.recon.map((r) => [r.issue, r.workspaceId ? <Link key="w" href={`/tenants/${r.workspaceId}?tab=ledger`}>{r.workspaceId.slice(0, 8)}</Link> : '—', <Mono key="r">{r.ref}</Mono>, dt(r.at)])} empty="Payments, grants and entitlements reconcile." />
          </Section>
          <Section title="Stripe ↔ our mirror (nightly full reconciliation)" right={<ActButton small action="billing.recon_run" payload={{}}>Run now</ActButton>}>
            <p className="ak-small ak-muted">
              {d0.lastRun ? `Last run ${dt(d0.lastRun.started_at)}: ${d0.lastRun.status}${d0.lastRun.error ? ` — ${d0.lastRun.error as string}` : ''}${d0.lastRun.status === 'completed' ? ` (${Object.entries(d0.lastRun.counts as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}.` : 'Not run yet.'} Customers and subscriptions are compared in full; charges over the last 35 days.
            </p>
            <Table head={['Difference', 'Stripe object', 'Workspace', 'Detail', 'First seen', 'Last seen', '']} rows={d0.stripeRecon.map((e) => [
              String(e.kind).replace(/_/g, ' '), <Mono key="s">{e.stripe_id as string}</Mono>,
              e.workspace_id ? <Link key="w" href={`/tenants/${e.workspace_id}?tab=billing`}>{(e.name as string) ?? String(e.workspace_id).slice(0, 8)}</Link> : '—',
              <Mono key="d">{JSON.stringify(e.detail)}</Mono>, dt(e.created_at), dt(e.last_seen_at),
              <ActButton key="r" small action="billing.recon_resolve" payload={{ id: e.id }} reason="How was it resolved?">Resolve</ActButton>,
            ])} empty="Stripe and our mirror agree." />
          </Section>
        </>
      ) : null}
      {tab === 'dunning' ? (
        <Table head={['Workspace', 'Plan', 'Period end', 'Failed attempts', 'Next retry', 'Payment-failed emails', 'Last email']} rows={d0.dunning.map((x) => [
          <Link key="w" href={`/tenants/${x.id}?tab=billing`}>{x.name as string}</Link>, x.plan_code as string, dt(x.current_period_end), x.payment_attempt_count as number,
          x.next_payment_attempt ? dt(x.next_payment_attempt) : <span key="n" className="ak-chip ak-chip--risk">no more retries</span>, x.emails as number, dt(x.last_email),
        ])} empty="Nobody past due." />
      ) : null}
      {tab === 'disputes' ? (
        <>
          <Table head={['Opened', 'Dispute', 'Workspace', 'Amount', 'Reason', 'Status', 'Evidence due', 'Evidence', '']} rows={d0.disputes.map((x) => [
            dt(x.stripe_created_at), <Mono key="i">{x.id as string}</Mono>, <Link key="w" href={`/tenants/${x.workspace_id}?tab=billing`}>{x.name as string}</Link>, money(Number(x.amount_cents) * 10_000),
            (x.reason as string) ?? '—', String(x.status).replace(/_/g, ' '), dt(x.evidence_due_by), x.evidence_submitted_at ? `submitted ${dt(x.evidence_submitted_at)}` : '—',
            <Link key="p" href={`/billing?tab=disputes&dispute=${encodeURIComponent(x.id as string)}&ws=${x.workspace_id}`}>{x.evidence_submitted_at ? 'View pack' : 'Preview pack'}</Link>,
          ])} empty="No disputes." />
          {d0.pack ? (
            <Section title={`Evidence pack — ${d0.pack.disputeId}`}>
              <div className="ak-grid-2" style={{ alignItems: 'start' }}>
                <div>
                  <Table head={['Field', 'Value']} rows={Object.entries(d0.pack.evidence).map(([k, v]) => [<Mono key="k">{k}</Mono>, <pre key="v" className="ak-small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{v}</pre>])} />
                </div>
                <div className="ak-panel">
                  <p className="ak-small">Payment: {d0.pack.payment.description}</p>
                  <p className="ak-small">{d0.pack.deliveries.length} deliveries · {d0.pack.exports.length} downloads · {d0.pack.consents.length} consent records · {d0.pack.receipts.length} emails</p>
                  {DISPUTE_OPEN.includes(d0.pack.status) && !d0.disputes.find((x) => x.id === d0.pack!.disputeId)?.evidence_submitted_at ? (
                    <ActForm action="billing.dispute_submit" extra={{ workspaceId: d0.pack.workspaceId, disputeId: d0.pack.disputeId }} submit="🔐 Submit to Stripe" fields={[
                      { name: 'note', label: 'Your summary for the bank (optional, sent first)', type: 'textarea' },
                      { name: 'reason', label: 'Reason (audit)', required: true },
                    ]} />
                  ) : <p className="ak-small ak-muted">This dispute no longer accepts evidence{d0.pack.status ? ` (${d0.pack.status.replace(/_/g, ' ')})` : ''}.</p>}
                </div>
              </div>
            </Section>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
