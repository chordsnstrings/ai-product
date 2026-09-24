import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { auditView, cogsBreakdown, INVOICE_VARIANCE_TOLERANCE, ledgerExplorer, providerInvoiceVariance, staffCan, workspaceMargins } from '@arkiv/core';
import { ActForm } from '@/components/act';
import { dt, money, Mono, Page, pct, Section, Table, Tabs } from '@/components/ui';
import { consolePrefs, daysFrom } from '@/lib/prefs';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Ledger & COGS' };

type SP = { tab?: string; ws?: string; type?: string; exp?: string; job?: string; days?: string };

/**
 * Plan 05 §8: never editable; corrections are new rows. COGS by provider/model/modality/resolution/duration,
 * workspace, plan and experiment; margin over two periods; stranded reservations; the ledger explorer with the
 * balance derivation; provider invoice reconciliation.
 */
export default async function Ledger({ searchParams }: { searchParams: Promise<SP> }) {
  const s = await requireStaff('ledger.read');
  const sp = await searchParams;
  const tab = sp.tab ?? 'cogs';
  const prefs = await consolePrefs();
  const days = daysFrom(sp.days, prefs);
  const tz = prefs.tz;
  const canImport = staffCan(s.roles, 'cogs.reconcile');
  const d0 = await withAdmin(async (tx) => {
    await auditView(tx, s, 'ledger', { tab, days, ws: sp.ws, type: sp.type, exp: sp.exp, job: sp.job, includeTest: prefs.includeTest });
    return {
      byModel: tab === 'cogs' ? await tx`select j.provider, j.model, j.task, count(*)::int as calls, coalesce(sum(j.actual_micros), 0)::bigint as spend, avg(j.latency_ms)::int as latency,
                                              count(*) filter (where j.status = 'failed')::int as failed
                                       from provider_jobs j where j.created_at > now() - make_interval(days => ${days}) ${notTest(tx, prefs, 'j.workspace_id')} group by 1, 2, 3 order by spend desc` : [],
      trend: tab === 'cogs' ? await tx`
        with spend as (select date_trunc('week', l.created_at, ${tz}) as wk, sum(l.amount)::bigint as spend,
                              coalesce(sum(l.amount) filter (where l.reason ilike '%retry%' or l.reason ilike '%repair%'), 0)::bigint as retry_spend
                       from ledger_entries l left join cost_authorizations a on a.id = l.authorization_id and a.workspace_id = l.workspace_id
                       where l.type = 'PROVIDER_COST_RECORDED' and coalesce(a.purpose, '') <> 'free_preview' and l.created_at > now() - interval '12 weeks'
                         ${notTest(tx, prefs, 'l.workspace_id')} group by 1),
             -- Appendix C: distinct paid ads (master or hook variant) the customer exported, not compositions.
             ex as (select date_trunc('week', e.at, ${tz}) as wk,
                           count(distinct (a.workspace_id::text || ':' || (a.lineage->>'projectId') || ':' || coalesce(a.lineage->>'variantId', 'master')))::int as exports
                    from events e join assets a on a.id = e.subject_id and a.workspace_id = e.workspace_id and a.kind = 'final_export'
                    join projects p on p.id::text = a.lineage->>'projectId' and p.workspace_id = a.workspace_id
                    where e.type = 'ASSET_EXPORTED' and p.kind in ('taste', 'standalone', 'creative_test') and e.at > now() - interval '12 weeks'
                      ${notTest(tx, prefs, 'e.workspace_id')} group by 1)
        select to_char(s.wk at time zone ${tz}, 'YYYY-MM-DD') as week, s.spend, coalesce(ex.exports, 0) as exports, s.retry_spend from spend s left join ex on ex.wk = s.wk order by s.wk desc` : [],
      cogs: tab === 'cogs' ? await cogsBreakdown(tx, { days, includeTest: prefs.includeTest }) : null,
      margins: tab === 'margin' ? await workspaceMargins(tx, { includeTest: prefs.includeTest }) : [],
      stranded: tab === 'stranded' ? await tx`select a.id, a.workspace_id, a.purpose, a.max_cost_micros, a.spent_micros, a.expires_at, a.status, w.name from cost_authorizations a join workspaces w on w.id = a.workspace_id
                                                where a.status = 'active' and a.expires_at < now() order by a.expires_at limit 100` : [],
      sweeps: tab === 'stranded' ? await tx`select type, count(*)::int as n from ledger_entries where actor like 'system:%' and type in ('CREDIT_RELEASED','CREDIT_EXPIRED') and created_at > now() - interval '7 days' group by 1` : [],
      explorer: tab === 'explorer' ? await ledgerExplorer(tx, { workspaceId: sp.ws, type: sp.type, experimentId: sp.exp, jobId: sp.job }).catch((e: Error) => ({ error: e.message })) : null,
      variance: tab === 'invoices' ? await providerInvoiceVariance(tx, { months: 6 }) : [],
      imports: tab === 'invoices' ? await tx`select provider, to_char(period, 'YYYY-MM') as month, count(*)::int as lines, sum(amount_micros)::bigint as total, max(created_at) as at from provider_invoice_lines group by 1, 2 order by 2 desc, 1 limit 24` : [],
    };
  });
  const ex = d0.explorer && !('error' in d0.explorer) ? d0.explorer : null;
  return (
    <Page title="Usage ledger & COGS" sub={`Last ${days === 1 ? 'day' : `${days} days`} · weeks in ${tz} · test accounts ${prefs.includeTest ? 'included' : 'excluded'}`}>
      <Tabs label="Ledger sections" base="/ledger" current={tab} params={{ days: sp.days }} tabs={[['cogs', 'COGS'], ['margin', 'Margin'], ['stranded', 'Stranded reservations'], ['explorer', 'Ledger explorer'], ['invoices', 'Provider invoices']]} />
      {tab === 'cogs' && d0.cogs ? (
        <>
          <Table head={['Week', 'Provider spend', 'Exported paid ads', 'Cost / usable export', 'QA retry share']} rows={d0.trend.map((t) => [t.week as string, money(t.spend), t.exports as number, Number(t.exports) ? money(Number(t.spend) / Number(t.exports)) : '—', pct(Number(t.spend) ? Number(t.retry_spend) / Number(t.spend) : NaN)])} empty="No provider spend yet." />
          <p className="ak-small">Fallback technique rate ({days}d): {pct(d0.cogs.fallback.scenes ? d0.cogs.fallback.fallback / d0.cogs.fallback.scenes : NaN)} of rendered scenes ended on a fallback (exact-product composite) — {d0.cogs.fallback.fallback} of {d0.cogs.fallback.scenes}.</p>
          <div className="ak-grid-2" style={{ alignItems: 'start' }}>
            <Section title={`By modality (${days}d)`}>
              <Table head={['Modality', 'Calls', 'Spend']} rows={d0.cogs.byModality.map((m) => [m.modality as string, m.calls as number, money(m.spend)])} empty="No calls." />
            </Section>
            <Section title={`Video by resolution and duration (${days}d)`}>
              <Table head={['Resolution', 'Clip length', 'Calls', 'Seconds', 'Spend', 'Per second']} rows={d0.cogs.byVideo.map((v) => [v.resolution as string, v.duration as string, v.calls as number, Math.round(Number(v.seconds)), money(v.spend), Number(v.seconds) ? money(Number(v.spend) / Number(v.seconds), 4) : '—'])} empty="No video calls." />
            </Section>
            <Section title={`By plan (${days}d)`}>
              <Table head={['Plan', 'Workspaces', 'Calls', 'Spend', 'Per workspace']} rows={d0.cogs.byPlan.map((p) => [p.plan as string, p.workspaces as number, p.calls as number, money(p.spend), money(Number(p.spend) / Math.max(1, Number(p.workspaces)))])} empty="No spend." />
            </Section>
            <Section title={`Top workspaces (${days}d)`}>
              <Table head={['Workspace', 'Plan', 'Calls', 'Spend']} rows={d0.cogs.byWorkspace.map((w) => [<Link key="w" href={`/tenants/${w.workspace_id}?tab=ledger`}>{w.name as string}</Link>, (w.plan_code as string) ?? '—', w.calls as number, money(w.spend)])} empty="No spend." />
            </Section>
            <Section title={`By experiment (${days}d)`}>
              <Table head={['Experiment', 'Workspace', 'Projects', 'Calls', 'Spend']} rows={d0.cogs.byExperiment.map((e) => [<Link key="e" href={`/ledger?tab=explorer&exp=${e.experiment_id}`}><Mono>{String(e.experiment_id).slice(0, 8)}</Mono></Link>, <Link key="w" href={`/tenants/${e.workspace_id}?tab=projects`}>{e.name as string}</Link>, e.projects as number, e.calls as number, money(e.spend)])} empty="No experiment spend." />
            </Section>
          </div>
          <Section title={`By provider / model / task (${days}d)`}>
            <Table head={['Provider', 'Model', 'Task', 'Calls', 'Failed', 'Spend', 'Avg latency']} rows={d0.byModel.map((m) => [m.provider as string, <Mono key="m">{m.model as string}</Mono>, m.task as string, m.calls as number, m.failed as number, money(m.spend), m.latency ? `${m.latency}ms` : '—'])} />
          </Section>
        </>
      ) : null}
      {tab === 'margin' ? (
        <>
          <p className="ak-small ak-muted">Revenue actually paid (one-off purchases net of refunds, mirrored subscription invoices; plan list price where no invoice is mirrored) minus variable COGS, over the last two 30-day periods. Flagged: below 0% margin in both periods.</p>
          <Table head={['Workspace', 'Plan', 'Revenue (last 30d)', 'COGS', 'Margin', 'Previous 30d margin', '']} rows={d0.margins.map((m) => {
            const [cur, prev] = m.periods;
            const fmt = (p?: { revenue: number; cogs: number; margin: number | null }) => (!p ? '—' : p.margin === null ? (p.cogs ? 'free usage' : '—') : pct(p.margin, 0));
            return [<Link key="w" href={`/tenants/${m.workspaceId}?tab=ledger`}>{m.name}</Link>, m.plan ?? '—', money(cur?.revenue ?? 0, 0), money(cur?.cogs ?? 0), <span key="c" style={{ color: cur?.margin != null && cur.margin < 0 ? 'var(--risk)' : undefined }}>{fmt(cur)}</span>, fmt(prev), m.flagged ? <span key="f" className="ak-chip ak-chip--risk">below 0% two periods</span> : ''];
          })} empty="No revenue or spend in the last 60 days." />
        </>
      ) : null}
      {tab === 'stranded' ? (
        <>
          <p className="ak-small">The sweeper settles expired authorizations every few minutes. Last 7 days it wrote: {d0.sweeps.map((x) => `${x.type} ×${x.n}`).join(', ') || 'nothing'}.</p>
          <Table head={['Authorization', 'Workspace', 'Purpose', 'Ceiling', 'Spent', 'Expired']} rows={d0.stranded.map((a) => [<Mono key="i">{String(a.id).slice(0, 8)}</Mono>, <Link key="w" href={`/tenants/${a.workspace_id}?tab=ledger`}>{a.name as string}</Link>, a.purpose as string, money(a.max_cost_micros), money(a.spent_micros), dt(a.expires_at)])} empty="No stranded reservations — the sweeper is keeping up." />
        </>
      ) : null}
      {tab === 'explorer' ? (
        <>
          <form className="ak-row" style={{ marginBottom: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <input type="hidden" name="tab" value="explorer" />
            <label className="ak-field"><span className="ak-label">Workspace id</span><input className="ak-input" name="ws" defaultValue={sp.ws} /></label>
            <label className="ak-field"><span className="ak-label">Entry type</span><input className="ak-input" name="type" placeholder="e.g. CREDIT_RESERVED" defaultValue={sp.type} /></label>
            <label className="ak-field"><span className="ak-label">Experiment id</span><input className="ak-input" name="exp" defaultValue={sp.exp} /></label>
            <label className="ak-field"><span className="ak-label">Job (provider job or authorization id)</span><input className="ak-input" name="job" defaultValue={sp.job} /></label>
            <button className="ak-btn ak-btn--sm">Filter</button>
          </form>
          {d0.explorer && 'error' in d0.explorer ? <p className="ak-error ak-small">{d0.explorer.error}</p> : null}
          {ex?.derivation.length ? (
            <Section title="Balance derivation (this workspace)">
              <Table head={['Unit', 'Derivation', 'Available']} rows={ex.derivation.map((u) => [
                u.unit,
                <span key="d" className="ak-small">{u.parts.filter((p) => p.counted).map((p) => `${p.type.replace('CREDIT_', '').toLowerCase()} ${p.total >= 0 ? '+' : '−'}${Math.abs(p.total)}`).join('  ')}{u.parts.some((p) => !p.counted) ? <span className="ak-muted"> (informational: {u.parts.filter((p) => !p.counted).map((p) => `${p.type.toLowerCase()} ${p.total}`).join(', ')})</span> : null}</span>,
                <strong key="a">{u.available}</strong>,
              ])} />
            </Section>
          ) : null}
          <Table head={['#', 'When', 'Workspace', 'Type', 'Unit', 'Amount', 'Balance (before → after)', 'Period', 'Experiment', 'Authorization', 'Job', 'Reason', 'Actor']} rows={(ex?.rows ?? []).map((e) => [
            e.id as number, dt(e.created_at), <Link key="w" href={`/ledger?tab=explorer&ws=${e.workspace_id}`}>{e.name as string}</Link>, <Mono key="t">{e.type as string}</Mono>, e.unit as string,
            e.unit === 'usd_micros' ? money(e.amount, 4) : String(e.amount),
            e.unit === 'usd_micros' ? '—' : e.counted ? `${e.balance_before} → ${e.balance_after}` : <span key="b" className="ak-muted">{String(e.balance_after)} (not counted)</span>,
            (e.period_key as string) ?? '—',
            e.experiment_id ? <Link key="x" href={`/ledger?tab=explorer&exp=${e.experiment_id}`}><Mono>{String(e.experiment_id).slice(0, 8)}</Mono></Link> : '—',
            e.authorization_id ? <Link key="a" href={`/ledger?tab=explorer&job=${e.authorization_id}`}><Mono>{String(e.authorization_id).slice(0, 8)}</Mono></Link> : '—',
            e.provider_job_id ? <Link key="j" href={`/ledger?tab=explorer&job=${e.provider_job_id}`}><Mono>{String(e.provider_job_id).slice(0, 8)}</Mono></Link> : '—',
            (e.reason as string) ?? '', <Mono key="ac">{e.actor as string}</Mono>,
          ])} empty="No ledger entries match." />
        </>
      ) : null}
      {tab === 'invoices' ? (
        <>
          <p className="ak-small ak-muted">Upload each provider’s monthly invoice CSV; it is matched to the provider cost we recorded per model and UTC month (PROVIDER_COST_RECORDED). A variance above {pct(INVOICE_VARIANCE_TOLERANCE, 0)} is flagged.</p>
          <Table head={['Month', 'Provider', 'Model', 'Invoiced', 'Recorded', 'Calls', 'Variance', '']} rows={d0.variance.map((v) => [
            v.period.slice(0, 7), v.provider, <Mono key="m">{v.model}</Mono>, v.invoicedMicros === null ? 'not on invoice' : money(v.invoicedMicros), money(v.recordedMicros), v.calls,
            v.varianceMicros === null ? '—' : `${money(v.varianceMicros)} (${pct(v.variancePct ?? NaN)})`,
            v.variancePct === null || Math.abs(v.variancePct) > INVOICE_VARIANCE_TOLERANCE ? <span key="f" className="ak-chip ak-chip--risk">check</span> : 'ok',
          ])} empty="No invoices imported yet." />
          <div className="ak-grid-2" style={{ alignItems: 'start' }}>
            <Section title="Imported invoices">
              <Table head={['Month', 'Provider', 'Lines', 'Total', 'Imported']} rows={d0.imports.map((i) => [i.month as string, i.provider as string, i.lines as number, money(i.total), dt(i.at)])} empty="None yet." />
            </Section>
            {canImport ? (
              <Section title="Import an invoice CSV">
                <div className="ak-panel">
                  <ActForm action="provider_invoice.import" submit="Import" fields={[
                    { name: 'provider', label: 'Provider', type: 'select', options: ['byteplus', 'anthropic', 'minimax'] },
                    { name: 'csv', label: 'CSV (month or date, model, amount USD; optional quantity, unit)', type: 'textarea', required: true, placeholder: 'month,model,quantity,unit,amount\n2026-09,seedance-2-5,5400,seconds,1231.20' },
                    { name: 'reason', label: 'Note (audit)' },
                  ]} />
                </div>
              </Section>
            ) : null}
          </div>
        </>
      ) : null}
    </Page>
  );
}
