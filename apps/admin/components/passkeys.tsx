'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { post, reauthenticate } from './act';

/** Add a passkey to your own staff account: a fresh second factor first (🔐), then the browser's WebAuthn prompt. */
export function AddPasskey() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="ak-row"
      style={{ alignItems: 'end', flexWrap: 'wrap' }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
          const options = await post('/api/passkeys', { step: 'options' }).catch(async (x) => {
            if (!(x as { details?: { reauth?: boolean } }).details?.reauth) throw x;
            await reauthenticate();
            return post('/api/passkeys', { step: 'options' });
          });
          const response = await startRegistration({ optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'] });
          const r = await post('/api/passkeys', { step: 'verify', response, name: name || undefined });
          setMsg({ ok: true, text: String(r.message ?? 'Passkey added.') });
          setName('');
          router.refresh();
        } catch (x) {
          setMsg({ ok: false, text: (x as Error).name === 'NotAllowedError' ? 'Passkey setup cancelled.' : (x as Error).message });
        }
        setBusy(false);
      }}
    >
      <label className="ak-field" style={{ flex: '1 1 200px', maxWidth: 320 }}>
        <span className="ak-label">Name (optional)</span>
        <input className="ak-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. MacBook Touch ID, YubiKey" />
      </label>
      <button className="ak-btn ak-btn--sm" disabled={busy}>{busy ? '…' : '🔐 Add passkey'}</button>
      {msg ? <span role="status" className={`ak-small ${msg.ok ? 'ak-muted' : 'ak-error'}`}>{msg.text}</span> : null}
    </form>
  );
}
