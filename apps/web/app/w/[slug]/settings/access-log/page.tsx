import type { Metadata } from 'next';
import { withTenant } from '@arkiv/db';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Access log · Arkiv' };

const SHOWN = ['MEMBER_ADDED', 'MEMBER_REMOVED', 'MEMBER_ROLE_CHANGED', 'INTEGRATION_CONNECTED', 'INTEGRATION_DISCONNECTED', 'INTEGRATION_DEGRADED', 'ASSET_EXPORTED', 'SUBSCRIPTION_CHANGED', 'WORKSPACE_STATE_CHANGED', 'CLAIM_APPROVED'];

/** Staff break-glass sessions are always visible to the customer (plan 05 §0.3), alongside security-relevant events. */
export default async function AccessLog({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => ({
    staff: await tx`select staff_name, reason, ticket, write_access, started_at, expires_at, ended_at from break_glass_sessions order by started_at desc limit 50`,
    events: await tx`select type, actor, payload, at from events where type in ${tx(SHOWN)} order by at desc limit 100`,
  }));
  return (
    <div className="ak-stack" style={{ ['--stack' as string]: '32px' }}>
      <section>
        <p className="ak-label">Arkiv staff access</p>
        {d.staff.length === 0 ? (
          <p className="ak-small ak-muted">No Arkiv staff member has accessed this workspace. Support access requires a reason, is time-limited, and always appears here.</p>
        ) : (
          <table className="ak-table">
            <thead><tr><th>When</th><th>Who</th><th>Reason</th><th>Access</th></tr></thead>
            <tbody>
              {d.staff.map((s, i) => (
                <tr key={i}>
                  <td className="ak-mono">{new Date(s.started_at as string).toLocaleString()}</td>
                  <td>{s.staff_name as string}</td>
                  <td>{s.reason as string}{s.ticket ? ` (${s.ticket})` : ''}</td>
                  <td>{s.write_access ? 'read + write' : 'read only'} · {s.ended_at ? 'ended' : new Date(s.expires_at as string) > new Date() ? 'active' : 'expired'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <p className="ak-label">Security events</p>
        <table className="ak-table ak-dense">
          <thead><tr><th>When</th><th>Event</th><th>By</th></tr></thead>
          <tbody>
            {d.events.map((e, i) => (
              <tr key={i}>
                <td className="ak-mono">{new Date(e.at as string).toLocaleString()}</td>
                <td>{String(e.type).replace(/_/g, ' ').toLowerCase()}</td>
                <td className="ak-mono ak-small">{String(e.actor).split(':')[0]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
