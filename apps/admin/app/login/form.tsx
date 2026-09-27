'use client';

import { useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? 'Sign-in failed');
  return j as Record<string, unknown>;
}

/** Password plus a second factor: an authenticator code, or a passkey (plan 05 §0.1). */
export function LoginForm() {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const withPasskey = async () => {
    const fd = new FormData(form.current!);
    const email = String(fd.get('email') ?? '').trim();
    const password = String(fd.get('password') ?? '');
    if (!email || !password) {
      setErr('Enter your email and password, then use your passkey.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const { flow, options } = await postJson('/api/login/passkey', { step: 'options', email, password });
      const response = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
      await postJson('/api/login/passkey', { step: 'verify', flow, response });
      window.location.assign('/');
    } catch (e) {
      setErr((e as Error).name === 'NotAllowedError' ? 'Passkey cancelled.' : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      ref={form}
      className="ak-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        setErr(null);
        try {
          await postJson('/api/login', { email: fd.get('email'), password: fd.get('password'), code: fd.get('code') });
          window.location.assign('/');
        } catch (x) {
          setErr((x as Error).message);
          setBusy(false);
        }
      }}
    >
      <label className="ak-field"><span className="ak-label">Email</span><input className="ak-input" name="email" type="email" autoComplete="username webauthn" required /></label>
      <label className="ak-field"><span className="ak-label">Password</span><input className="ak-input" name="password" type="password" autoComplete="current-password" required /></label>
      <label className="ak-field"><span className="ak-label">Authenticator code</span><input className="ak-input" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required /></label>
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
      <button className="ak-btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="ak-small ak-muted" style={{ margin: 0 }}>Or use a passkey instead of the code:</p>
      <button type="button" className="ak-btn ak-btn--secondary" disabled={busy} onClick={withPasskey}>Sign in with passkey</button>
    </form>
  );
}
