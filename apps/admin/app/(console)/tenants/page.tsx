import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { auditView, setting, staffCan } from '@arkiv/core';
import { PLANS, type PlanCode } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { BulkTag } from '@/components/bulk';
import { ago, d, FilterChip, money, Page, Section, Table } from '@/components/ui';
import { consolePrefs } from '@/lib/prefs';
import { requireStaff } from '@/lib/staff';
import { tenantFilters, tenantRows, type TenantFilters } from '@/lib/tenants-query';

export const metadata = { title: 'Tenants' };

const BULK_FORM = 'bulk-tenants';
type Conn = { provider: string; status: string; fresh: boolean };

/**
 * Plan 05 §2.1: metadata only (no tenant content). Search by name/slug/id, member email, Stripe customer,
 * Shopify domain, ad account; filters, saved views per staff member, bulk tag and CSV export (metadata only).
 */
export default async function Tenants({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireStaff('tenant.read');
  const f = tenantFilters(await searchParams);
  const prefs = await consolePrefs();
  const canTag = staffCan(s.roles, 'tenant.flags');
  const { rows, views } = await withAdmin(async (tx) => {
    await auditView(tx, s, 'tenants', f);
    const freeCap = await setting(tx, 'free_preview.cogs_cap_micros');
    return {
      rows: await tenantRows(tx, f, { limit: 200, tz: prefs.tz, freeCapMicros: Number(freeCap) }),
      views: await tx`select id, name, query from staff_saved_views where staff_id = ${s.staffId} and module = 'tenants' order by name`,
    };
  });
  const href = (patch: TenantFilters) => {
    const next = { ...f, ...patch };
    const qs = new URLSearchParams(Object.entries(next).filter((e): e is [string, string] => !!e[1]));
    return `/tenants${qs.size ? `?${qs}` : ''}`;
  };
  const chip = (k: keyof TenantFilters, v: string, label: string) => {
    const on = f[k] === v;
    return <FilterChip key={k + v} on={on} href={href({ [k]: on ? '' : v })}>{label}</FilterChip>;
  };
  const qs = new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => !!e[1])).toString();
  return (
    <Page title="Tenants" sub={`${rows.length} shown · test accounts ${f.test === '1' ? 'included' : 'hidden'} · created dates in ${prefs.tz}`} actions={<a className="ak-btn ak-btn--secondary ak-btn--sm" href={`/api/tenants.csv${qs ? `?${qs}` : ''}`}>Export CSV (metadata)</a>}>
      <form className="ak-row" style={{ marginBottom: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        {Object.entries(f).filter(([k]) => !['q', 'from', 'to'].includes(k)).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <label className="ak-field" style={{ flex: '1 1 240px', maxWidth: 520 }}>
          <span className="ak-label">Search tenants</span>
          <input className="ak-input" name="q" defaultValue={f.q ?? ''} placeholder="Name, slug, ID, member email, cus_…, shop.myshopify.com, ad account" />
        </label>
        <label className="ak-field" style={{ flex: '0 1 170px' }}><span className="ak-label">Created from</span><input className="ak-input" type="date" name="from" defaultValue={f.from ?? ''} /></label>
        <label className="ak-field" style={{ flex: '0 1 170px' }}><span className="ak-label">Created to</span><input className="ak-input" type="date" name="to" defaultValue={f.to ?? ''} /></label>
        <button className="ak-btn ak-btn--sm">Search</button>
      </form>
      <nav aria-label="Filters" className="ak-stack" style={{ ['--stack' as string]: '8px', marginBottom: 12 }}>
        <div className="ak-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="ak-label">State</span>
          {['ACTIVE_FREE', 'ACTIVE_PAID', 'PAST_DUE', 'CANCELLED', 'SUSPENDED', 'LOCKED', 'PURGE_SCHEDULED', 'PROVISIONAL'].map((st) => chip('state', st, st.toLowerCase()))}
        </div>
        <div className="ak-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="ak-label">Plan</span>
          {(['LAUNCH', 'GROWTH', 'SCALE'] as const).map((p) => chip('plan', p, p.toLowerCase()))}
          <span className="ak-label">Churn risk</span>
          {chip('risk', 'high', 'high')}{chip('risk', 'medium', 'medium')}{chip('risk', 'low', 'low')}{chip('risk', 'any', 'any flag')}
        </div>
        <div className="ak-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="ak-label">Connections</span>
          {chip('integration', 'healthy', 'all fresh')}{chip('integration', 'stale', 'stale')}{chip('integration', 'degraded', 'degraded / revoked')}{chip('integration', 'none', 'none')}
          <span className="ak-label">Money</span>
          {chip('filter', 'past_due', 'past due')}{chip('filter', 'paid_no_export', 'paid, no export')}{chip('filter', 'over_cogs_cap', 'over COGS cap (30d)')}
          {chip('test', '1', 'include test')}
        </div>
      </nav>
      <Section title="Saved views" right={qs ? <ActForm inline action="view.save" extra={{ module: 'tenants', query: f }} submit="Save current view" fields={[{ name: 'name', label: 'View name', required: true }]} /> : null}>
        <div className="ak-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {views.length ? views.map((v) => {
            const vq = new URLSearchParams(v.query as Record<string, string>).toString();
            return (
              <span key={v.id as string} className="ak-row" style={{ gap: 4 }}>
                <FilterChip on={vq === qs} href={`/tenants${vq ? `?${vq}` : ''}`}>{v.name as string}</FilterChip>
                <ActButton small action="view.delete" payload={{ id: v.id }} confirm={`Delete the saved view “${v.name as string}”?`}>×<span className="ak-sr"> delete {v.name as string}</span></ActButton>
              </span>
            );
          }) : <span className="ak-small ak-muted">None yet — filter the list, then save the view.</span>}
        </div>
      </Section>
      {canTag ? <div style={{ margin: '12px 0' }}><BulkTag formId={BULK_FORM} count={rows.length} /></div> : null}
      <Table
        head={[canTag ? <span key="sel" className="ak-sr">Select</span> : '', 'Workspace', 'State', 'Plan', 'MRR', '30d rev', '30d COGS', '30d margin', 'SKUs', 'Creative Tests', 'Connections', 'Churn risk', 'Flags', 'Last active', 'Created']}
        rows={rows.map((r) => {
          const mrr = r.paying ? PLANS[r.plan_code as PlanCode].priceMicros : 0;
          const revenue = Number(r.rev30) + mrr;
          const margin = revenue ? (revenue - Number(r.cogs30)) / revenue : null;
          const overCap = Number(r.cogs30) > Number(r.cogs_cap30);
          const flags = [r.state === 'SUSPENDED' ? 'suspended' : null, r.state === 'LOCKED' ? 'locked' : null, r.is_vip ? 'VIP' : null, r.is_test ? 'test' : null, ...((r.tags as string[]) ?? [])].filter(Boolean) as string[];
          return [
            canTag ? <input key="c" type="checkbox" name="ws" value={r.id as string} form={BULK_FORM} aria-label={`Select ${r.name as string}`} /> : '',
            <Link key="n" href={`/tenants/${r.id}`}>{r.name as string}<span className="ak-small ak-muted" style={{ display: 'block' }}>{r.slug as string}</span></Link>,
            <span key="s" className="ak-mono">{String(r.state).toLowerCase()}</span>,
            (r.plan_code as string)?.toLowerCase() ?? '—',
            money(mrr, 0),
            money(r.rev30, 0),
            <span key="cg" style={{ color: overCap ? 'var(--risk)' : undefined }}>{money(r.cogs30)}{overCap ? <span className="ak-small"> ⚠ over cap {money(r.cogs_cap30, 0)}</span> : null}</span>,
            <span key="m" style={{ color: margin !== null && margin < 0 ? 'var(--risk)' : undefined }}>{margin === null ? '—' : `${Math.round(margin * 100)}%`}</span>,
            r.skus as number,
            r.period ? `${r.tests_used}/${r.tests_granted} used · ${r.tests_available} left` : Number(r.tests_available) ? `${r.tests_available} left` : '—',
            <span key="cn" className="ak-row" style={{ gap: 4, flexWrap: 'wrap' }}>{((r.conns as Conn[]) ?? []).map((c) => <span key={c.provider} className={`ak-chip ${c.fresh ? 'ak-chip--ok' : ['degraded', 'revoked', 'paused'].includes(c.status) ? 'ak-chip--risk' : 'ak-chip--warn'}`}>{c.provider} · {c.fresh ? 'fresh' : c.status === 'active' ? 'stale' : c.status}</span>)}{(r.conns as Conn[]).length ? null : '—'}</span>,
            Number(r.risk_score) ? <span key="r" className={`ak-chip ${r.risk_band === 'high' ? 'ak-chip--risk' : r.risk_band === 'medium' ? 'ak-chip--warn' : ''}`}>{r.risk_score as number} · {r.risk_band as string}</span> : '—',
            <span key="f" className="ak-small">{flags.join(', ') || '—'}</span>,
            ago(r.last_active),
            d(r.created_at),
          ];
        })}
      />
    </Page>
  );
}
