import { viewStaffInvite } from '@arkiv/auth';
import { DomainError } from '@arkiv/shared';
import { Mono } from '@/components/ui';
import { AcceptInviteForm } from './form';

export const metadata = { title: 'Accept invite', referrer: 'no-referrer' };

/**
 * Plan 05 §23 staff invite: the invitee enrols their own authenticator (the secret is shown only here) and sets
 * their own password. Roles apply once a second SUPER_ADMIN approves them; a passkey can be added after sign-in.
 */
export default async function AcceptInvite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await viewStaffInvite(token).catch((e) => {
    if (e instanceof DomainError) return null;
    throw e;
  });
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 460 }}>
      <p className="ak-label">Arkiv · Staff console</p>
      <h1 className="ak-h2">Accept your invite</h1>
      {invite ? (
        <>
          <p className="ak-small ak-muted">For {invite.name} ({invite.email}). Add this account to your authenticator app, then choose a password of at least 14 characters.</p>
          <div className="ak-panel ak-stack">
            <span className="ak-label">Authenticator secret</span>
            <Mono>{invite.totpSecret.replace(/(.{4})/g, '$1 ').trim()}</Mono>
            <a className="ak-small" href={invite.otpauth}>Open in authenticator app</a>
          </div>
          <AcceptInviteForm token={token} />
        </>
      ) : (
        <p className="ak-error" role="alert">This invite link has expired or was already used. Ask a SUPER_ADMIN to resend it.</p>
      )}
    </div>
  );
}
