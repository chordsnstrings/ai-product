import type { Metadata } from 'next';
import { globalTx } from '@arkiv/db';
import { lookupOwnershipTransfer } from '@arkiv/core';
import { LinkButton } from '@arkiv/ui';
import { currentUser } from '@/lib/session';
import { DecideOwnership } from './decide';

export const metadata: Metadata = { title: 'Confirm new owner · Arkiv', robots: { index: false } };

/**
 * Plan 05 §2.2 Members: Arkiv support asked to transfer ownership; a current Owner confirms here, signed in, from
 * the link we emailed them. Opening the page changes nothing (link scanners are harmless); only the button does.
 */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await lookupOwnershipTransfer(token);
  if (t.status !== 'pending') {
    const said = { confirmed: 'already confirmed', declined: 'declined', cancelled: 'withdrawn by Arkiv support', expired: 'expired', not_found: 'not valid' }[t.status];
    return (
      <div className="ak-wrap ak-section" style={{ maxWidth: 520 }}>
        <h1 className="ak-h1">This request is {said}</h1>
        <p className="ak-muted">Nothing was changed by this link. If you still need a new owner{t.workspaceName ? ` for ${t.workspaceName}` : ''}, contact Arkiv support.</p>
      </div>
    );
  }
  const user = await currentUser();
  const next = `/ownership/${token}`;
  const isOwner = user
    ? (await globalTx((tx) => tx`select role from list_user_workspaces(${user.userId}) where workspace_id = ${t.workspaceId}`))[0]?.role === 'OWNER'
    : false;
  const newOwner = t.toName ? `${t.toName} (${t.toEmail})` : t.toEmail;
  return (
    <div className="ak-wrap ak-section ak-stack" style={{ maxWidth: 520 }}>
      <p className="ak-label">Ownership · your confirmation</p>
      <h1 className="ak-h1">Make {newOwner} the owner of {t.workspaceName}?</h1>
      <p className="ak-muted">Arkiv support ({t.staffName}) asked for this. If you confirm, you become an admin and they become the owner, with control of billing, members and deletion. Nothing changes unless you confirm.</p>
      <p className="ak-small">Reason given: {t.reason}</p>
      <p className="ak-small ak-muted">This link expires {new Date(t.expiresAt).toUTCString()}.</p>
      {!user ? (
        <LinkButton href={`/login?next=${encodeURIComponent(next)}`}>Log in to answer</LinkButton>
      ) : !isOwner ? (
        <p>You’re signed in as <strong>{user.email}</strong>, who isn’t an owner of {t.workspaceName}. Only a current owner can answer this request.</p>
      ) : (
        <DecideOwnership token={token} />
      )}
    </div>
  );
}
