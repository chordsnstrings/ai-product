import { withAdmin } from '@arkiv/db';
import { ACCESS_REVIEW_DAYS, ACCESS_REVIEW_GRACE_DAYS } from '@arkiv/core';
import { StaffRole } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { ago, d, dt, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Staff' };

/**
 * Plan 05 §23 (invite, roles four-eyes, require passkey, deprovision, audit trail; quarterly review: unconfirmed
 * roles are removed after 14 days) and §0.1 IP allowlists per role.
 */
export default async function Staff() {
  const me = await requireStaff('staff.manage');
  const d0 = await withAdmin(async (tx) => ({
    rows: await tx`select u.*, (select max(last_seen_at) from staff_sessions s where s.staff_id = u.id) as last_seen,
                          (select count(*) from staff_passkeys p where p.staff_id = u.id)::int as passkeys,
                          (select count(*) from admin_audit_log a where a.staff_id = u.id and a.at > now() - interval '30 days')::int as actions,
                          (select max(i.expires_at) from staff_invites i where i.staff_id = u.id and i.accepted_at is null and i.revoked_at is null) as invite_expires
                   from staff_users u order by u.active desc, u.created_at`,
    pending: await tx`select a.created_at, a.payload, a.reason, r.name as requester, t.email as target from approvals a
                      join staff_users r on r.id = a.requested_by left join staff_users t on t.id = (a.payload->>'staffId')::uuid
                      where a.action = 'staff.roles' and a.status = 'pending' order by a.created_at desc`,
    policies: await tx`select role, enabled, cidrs::text[] as cidrs, updated_at from staff_role_ip_policies`,
  }));
  const reviewDue = (x: Record<string, unknown>) => Date.now() - new Date(x.roles_confirmed_at as string).getTime() > ACCESS_REVIEW_DAYS * 86400_000;
  const policy = new Map(d0.policies.map((p) => [p.role as string, p]));
  const holders = (role: string) => d0.rows.filter((x) => x.active && (x.roles as string[]).includes(role)).length;
  return (
    <Page title="Staff" sub={`Roles: ${StaffRole.join(', ')}`}>
      <Table head={['Name', 'Email', 'Roles', 'Second factor', 'Active', 'Last seen', 'Actions (30d)', 'Roles confirmed', '']} rows={d0.rows.map((x) => [
        x.name as string, x.email as string, (x.roles as string[]).join(', '),
        <span key="f" className="ak-small">{x.require_passkey ? 'passkey required' : Number(x.passkeys) ? 'passkey or code' : 'code'}{Number(x.passkeys) ? ` · ${x.passkeys} passkey${Number(x.passkeys) === 1 ? '' : 's'}` : ''}</span>,
        x.active ? 'yes' : x.invite_expires ? <span key="i" className="ak-small">{new Date(x.invite_expires as string) > new Date() ? `invited · link valid until ${dt(x.invite_expires)}` : 'invite expired'}</span> : 'no', ago(x.last_seen), <a key="t" href={`/audit?staff=${encodeURIComponent(x.email as string)}`}>{x.actions as number}</a>,
        <span key="c" style={{ color: reviewDue(x) ? 'var(--risk)' : undefined }}>{d(x.roles_confirmed_at)}{reviewDue(x) ? ' (review due)' : ''}</span>,
        x.active && x.id !== me.staffId ? (
          <span key="a" className="ak-row" style={{ flexWrap: 'wrap' }}>
            <ActButton small action="staff.confirm_roles" payload={{ staffId: x.id }}>Confirm roles</ActButton>
            <ActForm inline action="staff.roles" extra={{ staffId: x.id }} submit="🔐 Change roles" fields={[{ name: 'roles', label: 'Roles', defaultValue: (x.roles as string[]).join(',') }, { name: 'reason', label: 'Reason', required: true }]} />
            <ActButton small action="staff.require_passkey" payload={{ staffId: x.id, required: !x.require_passkey }} reason={x.require_passkey ? 'Why may they use an authenticator code again?' : 'Why require a passkey (e.g. FINANCE access)?'}>
              {x.require_passkey ? '🔐 Allow codes again' : '🔐 Require passkey'}
            </ActButton>
            <ActButton small danger action="staff.deprovision" payload={{ staffId: x.id }} reason confirm={`Deprovision ${x.email}? All sessions end now.`}>🔐 Deprovision</ActButton>
          </span>
        ) : !x.active && x.invite_expires ? (
          <span key="a" className="ak-row" style={{ flexWrap: 'wrap' }}>
            <ActButton small action="staff.invite_resend" payload={{ staffId: x.id }}>🔐 Resend invite</ActButton>
            <ActButton small danger action="staff.deprovision" payload={{ staffId: x.id }} reason confirm={`Withdraw the invite for ${x.email}?`}>🔐 Withdraw invite</ActButton>
          </span>
        ) : null,
      ])} />
      <Section title="Quarterly access review">
        <p className="ak-small ak-muted" style={{ maxWidth: 760 }}>Every {ACCESS_REVIEW_DAYS} days each member’s roles must be re-confirmed (Confirm roles, or change them). Roles not confirmed within {ACCESS_REVIEW_GRACE_DAYS} days of falling due are removed automatically and the member’s sessions end.</p>
        <Table head={['Staff', 'Roles', 'Confirmed', 'Due', 'Removed automatically on', '']} rows={d0.rows.filter((x) => x.active && (x.roles as string[]).length && reviewDue(x)).map((x) => {
          const due = new Date(x.roles_confirmed_at as string).getTime() + ACCESS_REVIEW_DAYS * 86400_000;
          return [x.email as string, (x.roles as string[]).join(', '), d(x.roles_confirmed_at), d(new Date(due)), <strong key="r" style={{ color: 'var(--risk)' }}>{d(new Date(due + ACCESS_REVIEW_GRACE_DAYS * 86400_000))}</strong>,
            x.id !== me.staffId ? <ActButton key="c" small action="staff.confirm_roles" payload={{ staffId: x.id }}>Confirm roles</ActButton> : <span key="c" className="ak-small ak-muted">another SUPER_ADMIN confirms yours</span>];
        })} empty="Nobody is due for review." />
      </Section>
      <Section title="Network allowlist per role">
        <p className="ak-small ak-muted" style={{ maxWidth: 760 }}>Checked at sign-in and on every request; an unknown client address is refused once a role lists networks. On by default for FINANCE and SUPER_ADMIN — an enabled role enforces as soon as it lists at least one network (CIDR, e.g. 203.0.113.0/24). A staff member’s personal list, if any, adds to their roles’ networks. Changes that would lock you out are refused.</p>
        <Table head={['Role', 'Staff', 'Status', 'Networks', 'Updated', 'Change']} rows={StaffRole.map((role) => {
          const p = policy.get(role);
          const cidrs = (p?.cidrs as string[] | undefined) ?? [];
          const status = !p?.enabled ? 'off' : cidrs.length ? 'enforced' : 'on — no networks yet (not enforced)';
          return [
            <Mono key="r">{role}</Mono>, holders(role),
            <span key="s" className={`ak-chip ${status === 'enforced' ? 'ak-chip--ok' : p?.enabled ? 'ak-chip--warn' : ''}`}>{status}</span>,
            <Mono key="c">{cidrs.join(', ') || '—'}</Mono>, p ? dt(p.updated_at) : '—',
            <ActForm key="f" inline action="staff.ip_policy" extra={{ role }} submit="🔐 Save" fields={[
              { name: 'enabled', label: 'On', type: 'checkbox', defaultValue: !!p?.enabled },
              { name: 'cidrs', label: 'Networks (comma separated)', defaultValue: cidrs.join(', ') },
              { name: 'reason', label: 'Reason', required: true },
            ]} />,
          ];
        })} />
      </Section>
      <Section title="Invite staff">
        <div className="ak-panel" style={{ maxWidth: 520 }}>
          <p className="ak-small ak-muted">We email a single-use link (valid 48 hours). They set their own password and enrol their authenticator, so nobody else ever holds their factors. The roles you request take effect once another SUPER_ADMIN approves them (four-eyes). Require a passkey for them once they’ve added one.</p>
          <ActForm action="staff.invite" submit="🔐 Send invite" fields={[
            { name: 'email', label: 'Email', required: true },
            { name: 'name', label: 'Name', required: true },
            { name: 'roles', label: 'Roles (comma separated)', required: true, placeholder: 'SUPPORT' },
            { name: 'reason', label: 'Reason (why they need these roles)', type: 'textarea', required: true },
          ]} />
        </div>
      </Section>
      <Section title="Pending role approvals">
        <Table head={['Requested', 'Staff', 'Roles', 'By', 'Reason']} rows={d0.pending.map((p) => [d(p.created_at), (p.target as string) ?? String((p.payload as { staffId: string }).staffId).slice(0, 8), ((p.payload as { roles: string[] }).roles ?? []).join(', '), p.requester as string, p.reason as string])} empty="None — decide requests in Approvals." />
      </Section>
    </Page>
  );
}
