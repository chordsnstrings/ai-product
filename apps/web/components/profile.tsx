'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Button, splitConfirm } from '@arkiv/ui';
import { api, confirmSheet } from '@arkiv/ui/client';

export function MeButton({ action, body, children, confirm }: { action: string; body?: unknown; children: ReactNode; confirm?: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span>
      <button
        className="ak-textbtn"
        onClick={async () => {
          if (confirm && !(await confirmSheet({ ...splitConfirm(confirm), danger: true, confirmLabel: typeof children === 'string' ? children : 'Confirm' })).ok) return;
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
    <form className="ak-row" style={{ alignItems: 'end' }} onSubmit={async (e) => { e.preventDefault(); await api('/api/me/name', { name }); setSaved(true); router.refresh(); }}>
      <label className="ak-field">
        <span className="ak-label">Your name</span>
        <input className="ak-input" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={80} autoComplete="name" />
      </label>
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

/** Standard §40: delete your own account (type your email; needs a recent sign-in). */
export function DeleteAccount({ email }: { email: string }) {
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="ak-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        setBusy(true);
        try {
          const r = await api<{ next?: string | null }>('/api/me/delete-account', { confirm });
          window.location.assign(r.next ?? '/');
        } catch (x) {
          setErr((x as Error).message);
        }
        setBusy(false);
      }}
    >
      <label className="ak-field">
        <span className="ak-label">Type {email} to confirm</span>
        <input className="ak-input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </label>
      {err ? <p className="ak-error ak-small" role="alert">{err}</p> : null}
      <div><Button type="submit" variant="danger" size="sm" disabled={busy || confirm.trim().toLowerCase() !== email.toLowerCase()}>Delete my account</Button></div>
    </form>
  );
}
