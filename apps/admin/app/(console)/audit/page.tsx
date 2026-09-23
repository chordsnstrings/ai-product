import { withAdmin } from '@arkiv/db';
import { dt, Mono, Page, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Audit log' };

/** Plan 05 §0.4: append-only; SUPER_ADMIN reads; CSV export. */
export default async function Audit({ searchParams }: { searchParams: Promise<{ q?: string; staff?: string; ws?: string }> }) {
  await requireStaff('audit.read');
  const sp = await searchParams;
  const rows = await withAdmin((tx) => tx`select a.*, s.name from admin_audit_log a left join staff_users s on s.id = a.staff_id
    where (${sp.q ?? ''} = '' or a.action ilike ${'%' + (sp.q ?? '') + '%'} or a.target_id = ${sp.q ?? ''})
      and (${sp.staff ?? ''} = '' or s.email ilike ${'%' + (sp.staff ?? '') + '%'})
      and (${sp.ws ?? ''} = '' or a.workspace_id::text = ${sp.ws ?? ''})
    order by a.id desc limit 500`);
  const qs = new URLSearchParams(sp as Record<string, string>).toString();
  return (
    <Page title="Audit log" actions={<a className="ak-btn ak-btn--secondary" href={`/api/audit.csv?${qs}`}>Export CSV</a>}>
      <form className="ak-row" style={{ marginBottom: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        <label className="ak-field"><span className="ak-label">Action or target</span><input className="ak-input" name="q" defaultValue={sp.q} /></label>
        <label className="ak-field"><span className="ak-label">Staff email</span><input className="ak-input" name="staff" defaultValue={sp.staff} /></label>
        <label className="ak-field"><span className="ak-label">Workspace id</span><input className="ak-input" name="ws" defaultValue={sp.ws} /></label>
        <button className="ak-btn ak-btn--sm">Filter</button>
      </form>
      <Table head={['#', 'When', 'Staff', 'Action', 'Target', 'Workspace', 'Reason', 'Change', 'IP']} rows={rows.map((r) => [r.id as number, dt(r.at), (r.name as string) ?? '—', <Mono key="a">{r.action as string}</Mono>, <Mono key="t">{`${r.target_type ?? ''}:${String(r.target_id ?? '').slice(0, 12)}`}</Mono>, <Mono key="w">{String(r.workspace_id ?? '').slice(0, 8)}</Mono>, <span key="r" className="ak-small">{(r.reason as string) ?? ''}</span>, <Mono key="c">{r.after ? JSON.stringify(r.after).slice(0, 80) : ''}</Mono>, <Mono key="ip">{String(r.ip ?? '')}</Mono>])} />
    </Page>
  );
}
