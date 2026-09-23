'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

export function MeButton({ action, body, children, confirm }: { action: string; body?: unknown; children: ReactNode; confirm?: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span>
      <button
        className="ak-textbtn"
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          try {
            const r = await api<{ next?: string | null }>(`/api/me/${action}`, body ?? {});
            if (r.next) window.location.assign(r.next);
            else router.refresh();
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        {children}
      </button>
      {err ? <span className="ak-error ak-small"> {err}</span> : null}
    </span>
  );
}

export function NameForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [name, setName] = useState(initial);
  const [saved, setSaved] = useState(false);
  return (
    <form className="ak-row" onSubmit={async (e) => { e.preventDefault(); await api('/api/me/name', { name }); setSaved(true); router.refresh(); }}>
      <input className="ak-input" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} placeholder="Your name" aria-label="Your name" maxLength={80} />
      <Button type="submit" variant="secondary" size="sm">{saved ? 'Saved' : 'Save'}</Button>
    </form>
  );
}

export function PasskeyRegister() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div style={{ marginTop: 12 }}>
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          setErr(null);
          try {
            const opts = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('/api/auth/passkey/register', { step: 'options' });
            const response = await startRegistration({ optionsJSON: opts });
            await api('/api/auth/passkey/register', { step: 'verify', response, name: navigator.platform || 'Passkey' });
            router.refresh();
          } catch (e) {
            if ((e as Error).name !== 'NotAllowedError') setErr((e as Error).message);
          }
        }}
      >
        Add a passkey
      </Button>
      {err ? <p className="ak-error ak-small">{err}</p> : null}
    </div>
  );
}
