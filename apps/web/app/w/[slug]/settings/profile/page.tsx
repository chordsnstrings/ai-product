import type { Metadata } from 'next';
import { globalTx } from '@arkiv/db';
import { listSessions } from '@arkiv/auth';
import { requireUser } from '@/lib/session';
import { LogoutButton } from '@/components/logout-button';
import { MeButton, NameForm, PasskeyRegister } from '@/components/profile';

export const metadata: Metadata = { title: 'Profile · Arkiv' };

export default async function Profile({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const u = await requireUser(`/w/${slug}/settings/profile`);
  const sessions = await listSessions(u.userId);
  const passkeys = await globalTx((tx) => tx`select id, name, created_at, last_used_at from passkeys where user_id = ${u.userId} order by created_at`);
  const identities = await globalTx((tx) => tx`select provider, email from user_identities where user_id = ${u.userId}`);
  return (
    <div className="ak-stack" style={{ ['--stack' as string]: '32px', maxWidth: 720 }}>
      <section className="ak-panel">
        <h2 className="ak-label">You</h2>
        <p style={{ margin: 0 }}>{u.email}</p>
        <p className="ak-small ak-muted">Signed in with {[...new Set(identities.map((i) => i.provider as string))].join(', ') || 'email'}</p>
        <NameForm initial={u.name ?? ''} />
      </section>
      <section className="ak-panel">
        <h2 className="ak-label">Passkeys</h2>
        {passkeys.map((p) => (
          <div key={p.id as string} className="ak-index-row">
            <span>{(p.name as string) ?? 'Passkey'}<span className="ak-small ak-muted" style={{ display: 'block' }}>added {new Date(p.created_at as string).toLocaleDateString()}{p.last_used_at ? ` · used ${new Date(p.last_used_at as string).toLocaleDateString()}` : ''}</span></span>
            <MeButton action="passkey-delete" body={{ id: p.id }} confirm="Remove this passkey?">Remove</MeButton>
          </div>
        ))}
        <PasskeyRegister />
      </section>
      <section className="ak-panel">
        <h2 className="ak-label">Sessions</h2>
        {sessions.map((s) => (
          <div key={s.id as string} className="ak-index-row">
            <span>{String(s.user_agent ?? 'Unknown device').slice(0, 80)}<span className="ak-small ak-muted" style={{ display: 'block' }}>{s.ip as string} · last active {new Date(s.last_seen_at as string).toLocaleString()}{s.id === u.sessionId ? ' · this device' : ''}</span></span>
            {s.id !== u.sessionId ? <MeButton action="session-revoke" body={{ id: s.id }}>Sign out</MeButton> : null}
          </div>
        ))}
        <div className="ak-row" style={{ marginTop: 12 }}>
          <MeButton action="sessions-revoke-others">Sign out everywhere else</MeButton>
          <LogoutButton />
        </div>
      </section>
    </div>
  );
}
