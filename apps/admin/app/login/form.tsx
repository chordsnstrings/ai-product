'use client';

import { useState } from 'react';

export function LoginForm() {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="ak-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        setErr(null);
        const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(fd)) });
        if (r.ok) window.location.assign('/');
        else {
          setErr((await r.json().catch(() => ({}))).error ?? 'Sign-in failed');
          setBusy(false);
        }
      }}
    >
      <label className="ak-field"><span className="ak-label">Email</span><input className="ak-input" name="email" type="email" autoComplete="username" required /></label>
      <label className="ak-field"><span className="ak-label">Password</span><input className="ak-input" name="password" type="password" autoComplete="current-password" required /></label>
      <label className="ak-field"><span className="ak-label">Authenticator code</span><input className="ak-input" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required /></label>
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
      <button className="ak-btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
