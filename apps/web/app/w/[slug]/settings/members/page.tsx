import type { Metadata } from 'next';
import { withTenant } from '@arkiv/db';
import { listMembers, planQuota } from '@arkiv/core';
import type { PlanCode } from '@arkiv/shared';
import { ActionButton, ActionForm } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';
import { formatDate } from '@arkiv/shared/format';

export const metadata: Metadata = { title: 'Members · Arkiv' };

export default async function Members({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => ({
    members: await listMembers(tx),
    invites: await tx`select id, email, role, expires_at from invites where accepted_at is null and revoked_at is null and expires_at > now() order by created_at desc`,
    lim: await planQuota(tx, w.ctx.planCode as PlanCode | null),
  }));
  const lim = d.lim;
  const isOwner = w.ctx.role === 'OWNER';
  const isAdmin = isOwner || w.ctx.role === 'ADMIN';
  return (
    <div className="ak-grid-2" style={{ alignItems: 'start' }}>
      <div>
        <p className="ak-label">{d.members.length + d.invites.length} of {lim.members} seats</p>
        <table className="ak-table">
          <thead><tr><th>Person</th><th>Role</th><th /></tr></thead>
          <tbody>
            {d.members.map((m) => {
              const self = m.user_id === w.user?.id;
              return (
                <tr key={m.user_id as string}>
                  <td>{(m.name as string) ?? m.email}<span className="ak-small ak-muted" style={{ display: 'block' }}>{m.email as string}{self ? ' · you' : ''}</span></td>
                  <td className="ak-mono">{String(m.role).toLowerCase()}</td>
                  <td>
                    <div className="ak-row">
                      {isAdmin && m.role !== 'OWNER' && !self ? (
                        <>
                          {(['ADMIN', 'MEMBER', 'VIEWER'] as const).filter((r) => r !== m.role).map((r) => (
                            <ActionButton key={r} slug={slug} action="member-role" body={{ userId: m.user_id, role: r }} variant="text">Make {r.toLowerCase()}</ActionButton>
                          ))}
                          <ActionButton slug={slug} action="member-remove" body={{ userId: m.user_id }} variant="text" danger confirm={`Remove ${m.email}? They lose access immediately.`}>Remove</ActionButton>
                        </>
                      ) : null}
                      {isOwner && !self && m.role === 'ADMIN' ? (
                        <ActionButton slug={slug} action="transfer" body={{ userId: m.user_id }} variant="text" confirm={`Make ${m.email} the owner? You'll become an admin.`}>Transfer ownership</ActionButton>
                      ) : null}
                      {self && m.role !== 'OWNER' ? <ActionButton slug={slug} action="member-remove" body={{ userId: m.user_id }} variant="text" danger confirm="Leave this workspace?">Leave</ActionButton> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {d.invites.map((i) => (
              <tr key={i.id as string}>
                <td>{i.email as string}<span className="ak-small ak-muted" style={{ display: 'block' }}>invited · expires {formatDate(i.expires_at as string)}</span></td>
                <td className="ak-mono">{String(i.role).toLowerCase()}</td>
                <td>{isAdmin ? <ActionButton slug={slug} action="invite-revoke" body={{ id: i.id }} variant="text">Revoke</ActionButton> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isAdmin ? (
        <div className="ak-panel">
          <h2 className="ak-label">Invite someone</h2>
          <ActionForm slug={slug} action="invite" submit="Send invite" fields={[
            { name: 'email', label: 'Email', type: 'email', required: true },
            { name: 'role', label: 'Role', type: 'select', defaultValue: 'MEMBER', options: [{ value: 'ADMIN', label: 'Admin — billing, members, integrations' }, { value: 'MEMBER', label: 'Member — products and tests' }, { value: 'VIEWER', label: 'Viewer — read only' }] },
          ]} />
        </div>
      ) : null}
    </div>
  );
}
