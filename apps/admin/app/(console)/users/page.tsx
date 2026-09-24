import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { auditView, shouldMaskPii } from '@arkiv/core';
import { ago, d, Page, Table } from '@/components/ui';
import { piiView } from '@/lib/mask';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Users' };

/**
 * Plan 05 §3. SUPPORT sees masked emails and names (§0.2) and searches by exact email or ID only, so the list
 * can't be used to enumerate addresses.
 */
export default async function Users({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const s = await requireStaff('users.read');
  const q = ((await searchParams).q ?? '').trim();
  const pii = piiView(shouldMaskPii(s.roles));
  const rows = await withAdmin(async (tx) => {
    await auditView(tx, s, 'users', { q });
    const match = pii.mask
      ? tx`(${q} = '' or lower(u.email) = ${q.toLowerCase()} or u.id::text = ${q})`
      : tx`(${q} = '' or u.email ilike ${'%' + q + '%'} or u.name ilike ${'%' + q + '%'} or u.id::text = ${q})`;
    return tx`select u.id, u.email, u.name, u.created_at, u.locked_at, (select max(last_seen_at) from sessions s where s.user_id = u.id) as last_seen,
        (select count(*) from memberships m where m.user_id = u.id)::int as workspaces
      from users u where u.deleted_at is null and ${match} order by u.created_at desc limit 200`;
  });
  return (
    <Page title="Users" sub={`Customer identities. Staff accounts are separate even with the same email.${pii.mask ? ' Emails are masked for your role; search by exact email or ID.' : ''}`}>
      <form className="ak-row" style={{ marginBottom: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        <label className="ak-field" style={{ flex: '1 1 240px', maxWidth: 480 }}><span className="ak-label">Search users</span><input className="ak-input" name="q" defaultValue={q} placeholder={pii.mask ? 'Exact email or ID' : 'Email, name or ID'} /></label>
        <button className="ak-btn ak-btn--sm">Search</button>
      </form>
      <Table head={['User', 'Workspaces', 'Last seen', 'Created', 'Status']} rows={rows.map((u) => [<Link key="u" href={`/users/${u.id}`}>{pii.email(u.email)}{u.name ? <span className="ak-small ak-muted"> · {pii.name(u.name)}</span> : null}</Link>, u.workspaces as number, ago(u.last_seen), d(u.created_at), u.locked_at ? 'locked' : 'active'])} />
    </Page>
  );
}
