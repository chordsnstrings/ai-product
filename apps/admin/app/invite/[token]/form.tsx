'use client';

import { useState } from 'react';

/** Password (twice) + the current authenticator code; on success the invitee signs in normally. */
export function AcceptInviteForm({ token }: { token: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <p className="ak-small" role="status">
        Your account is ready. <a href="/login">Sign in</a> — your roles apply once a second administrator approves them. Add a passkey under Account after signing in.
      </p>
    );
  }
  return (
    <form
      className="ak-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        if (fd.get('password') !== fd.get('confirm')) {
          setErr('The passwords don’t match.');
          return;
        }
        setBusy(true);
        setErr(null);
        const r = await fetch('/api/invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: fd.get('password'), code: fd.get('code') }) });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (r.ok) setDone(true);
        else setErr(j.error ?? 'Couldn’t accept the invite.');
        setBusy(false);
      }}
    >
      <label className="ak-field"><span className="ak-label">Password (at least 14 characters)</span><input className="ak-input" name="password" type="password" autoComplete="new-password" minLength={14} required /></label>
      <label className="ak-field"><span className="ak-label">Repeat password</span><input className="ak-input" name="confirm" type="password" autoComplete="new-password" minLength={14} required /></label>
      <label className="ak-field"><span className="ak-label">Code from your authenticator</span><input className="ak-input" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required /></label>
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
      <button className="ak-btn" disabled={busy}>{busy ? 'Saving…' : 'Accept invite'}</button>
    </form>
  );
}
