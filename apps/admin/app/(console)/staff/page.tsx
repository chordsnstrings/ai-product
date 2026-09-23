import { withAdmin } from '@arkiv/db';
import { StaffRole } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { ago, d, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Staff' };

/** Plan 05 §23. Role changes are four-eyes; quarterly review: unconfirmed roles are removed after 14 days. */
export default async function Staff() {
  const me = await requireStaff('staff.manage');
  const rows = await withAdmin((tx) => tx`select u.*, (select max(last_seen_at) from staff_sessions s where s.staff_id = u.id) as last_seen,
      (select count(*) from admin_audit_log a where a.staff_id = u.id and a.at > now() - interval '30 days')::int as actions from staff_users u order by u.active desc, u.created_at`);
  const reviewDue = (x: Record<string, unknown>) => Date.now() - new Date(x.roles_confirmed_at as string).getTime() > 90 * 86400_000;
  return (
    <Page title="Staff" sub={`Roles: ${StaffRole.join(', ')}`}>
      <Table head={['Name', 'Email', 'Roles', 'Active', 'Last seen', 'Actions (30d)', 'Roles confirmed', '']} rows={rows.map((x) => [
        x.name as string, x.email as string, (x.roles as string[]).join(', '), x.active ? 'yes' : 'no', ago(x.last_seen), x.actions as number,
        <span key="c" style={{ color: reviewDue(x) ? 'var(--risk)' : undefined }}>{d(x.roles_confirmed_at)}{reviewDue(x) ? ' (review due)' : ''}</span>,
        x.active && x.id !== me.staffId ? (
          <span key="a" className="ak-row">
            <ActButton small action="staff.confirm_roles" payload={{ staffId: x.id }}>Confirm roles</ActButton>
            <ActForm inline action="staff.roles" extra={{ staffId: x.id }} submit="🔐 Change roles" fields={[{ name: 'roles', label: 'Roles', defaultValue: (x.roles as string[]).join(',') }, { name: 'reason', label: 'Reason', required: true }]} />
            <ActButton small danger action="staff.deprovision" payload={{ staffId: x.id }} reason confirm={`Deprovision ${x.email}? All sessions end now.`}>🔐 Deprovision</ActButton>
          </span>
        ) : null,
      ])} />
      <Section title="Invite staff">
        <div className="ak-panel" style={{ maxWidth: 520 }}>
          <ActForm action="staff.create" submit="🔐 Create" fields={[{ name: 'email', label: 'Email', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'password', label: 'Temporary password (≥ 14 chars)', required: true }, { name: 'roles', label: 'Roles (comma separated)', required: true, placeholder: 'SUPPORT' }]} />
        </div>
      </Section>
    </Page>
  );
}
