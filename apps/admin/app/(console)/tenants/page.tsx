import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { PLANS, type PlanCode } from '@arkiv/shared';
import { ago, d, money, Page, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Tenants' };

/** Plan 05 §2.1: metadata only (no tenant content). Search by name/slug/id, member email, Stripe customer, Shopify domain, ad account. */
export default async function Tenants({ searchParams }: { searchParams: Promise<{ q?: string; state?: string; plan?: string; risk?: string; test?: string; filter?: string }> }) {
  await requireStaff('tenant.read');
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const rows = await withAdmin((tx) => tx`
    select w.id, w.name, w.slug, w.state, w.plan_code, w.created_at, w.is_vip, w.is_test, w.tags,
      (select max(s.last_seen_at) from sessions s join memberships m on m.user_id = s.user_id where m.workspace_id = w.id) as last_active,
      (select count(*) from skus where workspace_id = w.id)::int as skus,
      (select coalesce(sum(amount), 0) from ledger_entries where workspace_id = w.id and type = 'PROVIDER_COST_RECORDED' and created_at > now() - interval '30 days')::bigint as cogs30,
      (select coalesce(sum(amount_micros), 0) from purchases where workspace_id = w.id and status = 'paid' and paid_at > now() - interval '30 days')::bigint as rev30,
      (select count(*) from risk_flags where workspace_id = w.id and resolved_at is null)::int as risks,
      (select string_agg(provider || ':' || case when status = 'active' and last_success_at > now() - interval '7 days' then 'ok' else status end, ' ') from integrations where workspace_id = w.id and status <> 'disconnected') as conns
    from workspaces w
    where (${sp.test === '1'} or not w.is_test)
      and (${sp.state ?? ''} = '' or w.state = ${sp.state ?? ''})
      and (${sp.plan ?? ''} = '' or w.plan_code = ${sp.plan ?? ''})
      and (${sp.risk !== '1'} or exists (select 1 from risk_flags r where r.workspace_id = w.id and r.resolved_at is null))
      and (${sp.filter !== 'past_due'} or w.state = 'PAST_DUE')
      and (${sp.filter !== 'paid_no_export'} or (exists (select 1 from purchases p where p.workspace_id = w.id and p.status = 'paid')
            and not exists (select 1 from events e where e.workspace_id = w.id and e.type = 'ASSET_EXPORTED')))
      and (${q} = '' or w.name ilike ${'%' + q + '%'} or w.slug ilike ${'%' + q + '%'} or w.id::text = ${q}
           or exists (select 1 from memberships m join users u on u.id = m.user_id where m.workspace_id = w.id and u.email = ${q.toLowerCase()})
           or w.stripe_customer_id = ${q}
           or exists (select 1 from integrations i where i.workspace_id = w.id and i.external_account_id in (${q}, ${'act_' + q})))
    order by w.created_at desc limit 200`);
  const f = (k: string, v: string, label: string) => {
    const on = (sp as Record<string, string | undefined>)[k] === v;
    const qs = new URLSearchParams({ ...(sp as Record<string, string>), [k]: on ? '' : v });
    return <Link key={k + v} href={`/tenants?${qs}`} className={`ak-chip${on ? ' ak-chip--dec' : ''}`}>{label}</Link>;
  };
  return (
    <Page title="Tenants" sub={`${rows.length} shown · test accounts ${sp.test === '1' ? 'included' : 'hidden'}`}>
      <form className="ak-row" style={{ marginBottom: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label className="ak-field">
          <span className="ak-label">Search tenants</span>
          <input className="ak-input" name="q" defaultValue={q} placeholder="Name, slug, ID, member email, cus_…, shop.myshopify.com, ad account" style={{ minWidth: 380 }} />
        </label>
        <button className="ak-btn ak-btn--sm">Search</button>
      </form>
      <div className="ak-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {['ACTIVE_FREE', 'ACTIVE_PAID', 'PAST_DUE', 'CANCELLED', 'SUSPENDED', 'LOCKED', 'PURGE_SCHEDULED', 'PROVISIONAL'].map((s) => f('state', s, s.toLowerCase()))}
        {(['LAUNCH', 'GROWTH', 'SCALE'] as const).map((p) => f('plan', p, p.toLowerCase()))}
        {f('risk', '1', 'has risk flags')}
        {f('filter', 'paid_no_export', 'paid, no export')}
        {f('test', '1', 'include test')}
      </div>
      <Table
        head={['Workspace', 'State', 'Plan', 'MRR', '30d rev', '30d COGS', '30d margin', 'SKUs', 'Connections', 'Risk', 'Last active', 'Created']}
        rows={rows.map((r) => {
          const mrr = r.plan_code && ['ACTIVE_PAID', 'PAST_DUE'].includes(r.state as string) ? PLANS[r.plan_code as PlanCode].priceMicros : 0;
          const revenue = Number(r.rev30) + mrr;
          const margin = revenue ? (revenue - Number(r.cogs30)) / revenue : null;
          return [
            <Link key="n" href={`/tenants/${r.id}`}>{r.name as string}{r.is_vip ? ' ★' : ''}{r.is_test ? ' (test)' : ''}<span className="ak-small ak-muted" style={{ display: 'block' }}>{r.slug as string}</span></Link>,
            <span key="s" className="ak-mono">{String(r.state).toLowerCase()}</span>,
            (r.plan_code as string)?.toLowerCase() ?? '—',
            money(mrr, 0),
            money(r.rev30, 0),
            money(r.cogs30),
            <span key="m" style={{ color: margin !== null && margin < 0 ? 'var(--risk)' : undefined }}>{margin === null ? '—' : `${Math.round(margin * 100)}%`}</span>,
            r.skus as number,
            <span key="c" className="ak-mono ak-small">{(r.conns as string) ?? '—'}</span>,
            Number(r.risks) ? <span key="r" className="ak-chip ak-chip--warn">{r.risks as number}</span> : '—',
            ago(r.last_active),
            d(r.created_at),
          ];
        })}
      />
    </Page>
  );
}
