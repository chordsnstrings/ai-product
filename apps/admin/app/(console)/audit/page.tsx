import { withAdmin } from '@arkiv/db';
import { dt, Mono, Page, Table } from '@/components/ui';
import { auditFilters, auditRows, jsonDiff } from '@/lib/audit-query';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Audit log' };

const show = (v: unknown) => (v === undefined ? '—' : JSON.stringify(v));

/** The before/after of a row as a field diff, expandable (plan 05 §0.4 "before/after (diffable JSON)"). */
function Change({ before, after }: { before: unknown; after: unknown }) {
  if (before == null && after == null) return null;
  const changes = before == null ? null : jsonDiff(before, after ?? undefined);
  const summary = changes ? `${changes.length} field${changes.length === 1 ? '' : 's'} changed` : JSON.stringify(after).slice(0, 60);
  return (
    <details>
      <summary className="ak-mono ak-small" style={{ cursor: 'pointer' }}>{summary}</summary>
      {changes ? (
        <table className="ak-table ak-small" style={{ marginTop: 6 }}>
          <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
          <tbody>{changes.map((c) => <tr key={c.path}><td className="ak-mono">{c.path}</td><td className="ak-mono" style={{ color: 'var(--risk)' }}><del>{show(c.before)}</del></td><td className="ak-mono"><ins>{show(c.after)}</ins></td></tr>)}</tbody>
        </table>
      ) : <pre className="ak-mono ak-small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{JSON.stringify(after, null, 2)}</pre>}
    </details>
  );
}

/** Plan 05 §0.4: append-only; SUPER_ADMIN reads; CSV export with the same filters. */
export default async function Audit({ searchParams }: { searchParams: Promise<{ q?: string; staff?: string; ws?: string }> }) {
  await requireStaff('audit.read');
  const sp = await searchParams;
  const f = auditFilters(sp);
  const rows = await withAdmin((tx) => auditRows(tx, f, 500));
  const qs = new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => !!e[1])).toString();
  return (
    <Page title="Audit log" actions={<a className="ak-btn ak-btn--secondary" href={`/api/audit.csv${qs ? `?${qs}` : ''}`}>Export CSV{qs ? ' (filtered)' : ''}</a>}>
      <form className="ak-row" style={{ marginBottom: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        <label className="ak-field"><span className="ak-label">Action or target</span><input className="ak-input" name="q" defaultValue={f.q ?? ''} /></label>
        <label className="ak-field"><span className="ak-label">Staff email</span><input className="ak-input" name="staff" defaultValue={f.staff ?? ''} /></label>
        <label className="ak-field"><span className="ak-label">Workspace id</span><input className="ak-input" name="ws" defaultValue={f.ws ?? ''} /></label>
        <button className="ak-btn ak-btn--sm">Filter</button>
      </form>
      <Table head={['#', 'When', 'Staff', 'Action', 'Target', 'Workspace', 'Reason', 'Change', 'IP']} rows={rows.map((r) => [r.id as number, dt(r.at), (r.name as string) ?? '—', <Mono key="a">{r.action as string}</Mono>, <Mono key="t">{`${r.target_type ?? ''}:${String(r.target_id ?? '').slice(0, 12)}`}</Mono>, <Mono key="w">{String(r.workspace_id ?? '').slice(0, 8)}</Mono>, <span key="r" className="ak-small">{(r.reason as string) ?? ''}</span>, <Change key="c" before={r.before} after={r.after} />, <Mono key="ip">{String(r.ip ?? '')}</Mono>])} />
    </Page>
  );
}
