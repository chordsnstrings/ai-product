'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Button, splitConfirm } from '@arkiv/ui';
import { api, confirmSheet } from '@arkiv/ui/client';

const needsStepUp = (e: unknown) => !!(e as { details?: { stepUp?: boolean } } | null)?.details?.stepUp;

/**
 * "Confirm it's you" (plan 02 M14 step-up): sensitive changes need a sign-in from the last 10 minutes. One tap
 * emails a link that signs you in afresh and brings you back here.
 */
export function StepUp({ message }: { message?: string }) {
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (sent) return <p className="ak-small" role="status">Check <strong>{sent}</strong> — open the link, then try again here.</p>;
  return (
    <p className="ak-small" role="status">
      {message ?? 'For your security, confirm it’s you first.'}{' '}
      <button
        type="button"
        className="ak-textbtn"
        onClick={async () => {
          try {
            const r = await api<{ sentTo: string }>('/api/me/step-up', { next: window.location.pathname });
            setSent(r.sentTo);
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        Email me a confirmation link
      </button>
      {err ? <span className="ak-error"> {err}</span> : null}
    </p>
  );
}

export function MeButton({ action, body, children, confirm }: { action: string; body?: unknown; children: ReactNode; confirm?: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
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
            setStepUp(needsStepUp(e));
            setErr((e as Error).message);
          }
        }}
      >
        {children}
      </button>
      {stepUp ? <StepUp /> : err ? <span className="ak-error ak-small"> {err}</span> : null}
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

/** Register a passkey on this device. Shared by Profile and the post-purchase prompt; resolves true when added. */
export async function registerPasskey(source: 'profile' | 'prompt'): Promise<boolean> {
  const opts = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('/api/auth/passkey/register', { step: 'options' });
  try {
    const response = await startRegistration({ optionsJSON: opts });
    await api('/api/auth/passkey/register', { step: 'verify', response, name: navigator.platform || 'Passkey', source });
    return true;
  } catch (e) {
    if ((e as Error).name === 'NotAllowedError') return false;
    throw e;
  }
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
            if (await registerPasskey('profile')) router.refresh();
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        Add a passkey
      </Button>
      {err ? <p className="ak-error ak-small">{err}</p> : null}
    </div>
  );
}

/** Optional password (standard §34): set, change or remove. Needs a recent sign-in; other sessions are signed out. */
export function PasswordSettings({ hasPassword, minLength }: { hasPassword: boolean; minLength: number }) {
  const router = useRouter();
  const [pw, setPw] = useState('');
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const run = async (action: 'password-set' | 'password-remove', payload: unknown, ok: string) => {
    setErr(null);
    setStepUp(false);
    try {
      await api(`/api/me/${action}`, payload);
      setDone(ok);
      setPw('');
      setOpen(false);
      router.refresh();
    } catch (e) {
      setStepUp(needsStepUp(e));
      setErr((e as Error).message);
    }
  };
  return (
    <div className="ak-stack">
      {done ? <p className="ak-small" role="status">{done} Other devices were signed out.</p> : null}
      {open ? (
        <form className="ak-row" style={{ alignItems: 'end' }} onSubmit={(e) => { e.preventDefault(); void run('password-set', { password: pw }, hasPassword ? 'Password changed.' : 'Password added.'); }}>
          <label className="ak-field">
            <span className="ak-label">{hasPassword ? 'New password' : 'Password'} (at least {minLength} characters)</span>
            <input className="ak-input" type="password" autoComplete="new-password" minLength={minLength} maxLength={200} required value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <Button type="submit" variant="secondary" size="sm">Save</Button>
        </form>
      ) : (
        <div className="ak-row">
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>{hasPassword ? 'Change password' : 'Add a password'}</Button>
          {hasPassword ? <button type="button" className="ak-textbtn" onClick={() => void run('password-remove', {}, 'Password removed.')}>Remove password</button> : null}
        </div>
      )}
      {stepUp ? <StepUp /> : err ? <p className="ak-error ak-small" role="alert">{err}</p> : null}
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
