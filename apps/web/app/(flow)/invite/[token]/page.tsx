import type { Metadata } from 'next';
import { lookupInvite } from '@arkiv/core';
import { LinkButton } from '@arkiv/ui';
import { currentUser } from '@/lib/session';
import { LogoutButton } from '@/components/logout-button';
import { AcceptInvite } from './accept';

export const metadata: Metadata = { title: 'Invitation · Arkiv', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await lookupInvite(token);
  const user = await currentUser();
  if (inv.status !== 'ok') {
    return (
      <div className="ak-wrap ak-section" style={{ maxWidth: 480 }}>
        <h1 className="ak-h1">This invitation is {inv.status.replace('_', ' ')}</h1>
        <p className="ak-muted">{inv.workspaceName ? `Ask someone at ${inv.workspaceName} to send a new one.` : 'Ask the person who invited you to send a new one.'}</p>
      </div>
    );
  }
  const next = `/invite/${token}`;
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 480 }}>
      <p className="ak-label">Invitation</p>
      <h1 className="ak-h1">Join {inv.workspaceName}</h1>
      <p className="ak-muted">as {inv.role.toLowerCase()} · for {inv.email}</p>
      {!user ? (
        <LinkButton href={`/login?next=${encodeURIComponent(next)}`}>Log in as {inv.email} to accept</LinkButton>
      ) : user.email.toLowerCase() !== inv.email.toLowerCase() ? (
        <div className="ak-stack">
          <p>You’re signed in as <strong>{user.email}</strong>, but this invite is for <strong>{inv.email}</strong>.</p>
          <LogoutButton label="Switch account" className="ak-btn ak-btn--secondary" next={`/login?next=${encodeURIComponent(next)}`} />
        </div>
      ) : (
        <AcceptInvite token={token} />
      )}
    </div>
  );
}
