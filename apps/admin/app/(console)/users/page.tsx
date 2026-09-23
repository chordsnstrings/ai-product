import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { ago, d, Page, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Users' };

export default async function Users({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireStaff('users.read');
  const q = ((await searchParams).q ?? '').trim();
  const rows = await withAdmin((tx) => tx`select u.id, u.email, u.name, u.created_at, u.locked_at, (select max(last_seen_at) from sessions s where s.user_id = u.id) as last_seen,
      (select count(*) from memberships m where m.user_id = u.id)::int as workspaces
    from users u where u.deleted_at is null and (${q} = '' or u.email ilike ${'%' + q + '%'} or u.name ilike ${'%' + q + '%'} or u.id::text = ${q}) order by u.created_at desc limit 200`);
  return (
    <Page title="Users" sub="Customer identities. Staff accounts are separate even with the same email.">
      <form className="ak-row" style={{ marginBottom: 12, alignItems: 'end' }}>
        <label className="ak-field"><span className="ak-label">Search users</span><input className="ak-input" name="q" defaultValue={q} placeholder="Email, name or ID" style={{ minWidth: 320 }} /></label>
        <button className="ak-btn ak-btn--sm">Search</button>
      </form>
      <Table head={['User', 'Workspaces', 'Last seen', 'Created', 'Status']} rows={rows.map((u) => [<Link key="u" href={`/users/${u.id}`}>{u.email as string}{u.name ? <span className="ak-small ak-muted"> · {u.name as string}</span> : null}</Link>, u.workspaces as number, ago(u.last_seen), d(u.created_at), u.locked_at ? 'locked' : 'active'])} />
    </Page>
  );
}
