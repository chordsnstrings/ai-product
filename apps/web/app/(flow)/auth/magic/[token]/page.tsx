import type { Metadata } from 'next';
import { maskEmail, previewMagicLink } from '@arkiv/auth';
import { MAGIC_LINK_TTL_MIN } from '@arkiv/shared';
import { LinkButton } from '@arkiv/ui';
import { currentUser } from '@/lib/session';
import { ConfirmMagic } from './confirm';
import { ResendMagic } from './resend';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };

/**
 * GET never consumes (mail scanners prefetch links, some of them running scripts); only pressing Continue POSTs
 * (plan 03 Part C). A link clicked again in the browser it already signed in says so; elsewhere it's "used".
 */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await previewMagicLink(token);
  if (p.status === 'used' && p.consumedUserId) {
    const me = await currentUser();
    if (me && me.userId === p.consumedUserId) {
      return (
        <div className="ak-wrap ak-section" style={{ maxWidth: 440 }}>
          <h1 className="ak-h1">Already signed in</h1>
          <p className="ak-muted">You used this link on this device already, as {me.email}.</p>
          <LinkButton href={p.redirectTo ?? '/app'}>Continue</LinkButton>
        </div>
      );
    }
  }
  if (p.status !== 'ok') {
    return (
      <div className="ak-wrap ak-section" style={{ maxWidth: 440 }}>
        <h1 className="ak-h1">{p.status === 'used' ? 'This link was already used' : p.status === 'expired' ? 'This link has expired' : 'This link isn’t valid'}</h1>
        <p className="ak-muted">Links work once and expire after {MAGIC_LINK_TTL_MIN} minutes. Your work is saved — get a new link to continue.</p>
        {p.email ? <ResendMagic token={token} to={maskEmail(p.email)} ttlMinutes={MAGIC_LINK_TTL_MIN} /> : <LinkButton href="/login">Send a new link</LinkButton>}
      </div>
    );
  }
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 440 }}>
      <h1 className="ak-h1">Sign in to Arkiv</h1>
      <p className="ak-muted">as {p.email}</p>
      <ConfirmMagic token={token} />
    </div>
  );
}
