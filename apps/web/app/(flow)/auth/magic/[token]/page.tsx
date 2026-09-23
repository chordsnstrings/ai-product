import type { Metadata } from 'next';
import { previewMagicLink } from '@arkiv/auth';
import { LinkButton } from '@arkiv/ui';
import { ConfirmMagic } from './confirm';

export const metadata: Metadata = { title: 'Sign in · Arkiv', robots: { index: false } };

/** GET never consumes (mail scanners prefetch links); the button POSTs. Auto-submits for real browsers. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await previewMagicLink(token);
  if (p.status !== 'ok') {
    return (
      <div className="ak-wrap ak-section" style={{ maxWidth: 440 }}>
        <h1 className="ak-h1">{p.status === 'used' ? 'This link was already used' : p.status === 'expired' ? 'This link has expired' : 'This link isn’t valid'}</h1>
        <p className="ak-muted">Links work once and expire after 20 minutes. Your work is saved — request a new link to continue.</p>
        <LinkButton href="/login">Send a new link</LinkButton>
      </div>
    );
  }
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 440 }}>
      <h1 className="ak-h1">Signing you in</h1>
      <p className="ak-muted">as {p.email}</p>
      <ConfirmMagic token={token} />
    </div>
  );
}
