'use client';

import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

export function LoginForm({ next, error, google, apple }: { next: string | null; error: string | null; google: boolean; apple: boolean }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(error);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const q = next ? `?next=${encodeURIComponent(next)}` : '';

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ suggestion: string | null }>('/api/auth/magic', { email, next });
      setSuggestion(r.suggestion);
      setSent(true);
    } catch (x) {
      setErr((x as Error).message);
      setSuggestion((x as { details?: { suggestion?: string } }).details?.suggestion ?? null);
    }
    setBusy(false);
  }
  async function passkey() {
    setErr(null);
    try {
      const o = await api<{ flow: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/api/auth/passkey/options', {});
      const response = await startAuthentication({ optionsJSON: o.options });
      const r = await api<{ next: string }>('/api/auth/passkey/verify', { flow: o.flow, response, next });
      window.location.assign(r.next);
    } catch (x) {
      if ((x as Error).name !== 'NotAllowedError') setErr((x as Error).message);
    }
  }

  if (sent)
    return (
      <div className="ak-stack" style={{ marginTop: 24 }}>
        <p>Check <strong>{email}</strong>. The link works once and expires in 20 minutes.</p>
        {suggestion ? <p className="ak-small ak-muted">Did you mean {suggestion}?</p> : null}
        <button className="ak-textbtn" onClick={() => setSent(false)}>Use a different email</button>
      </div>
    );
  return (
    <form className="ak-stack" onSubmit={send} style={{ marginTop: 24 }}>
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <label className="ak-field">
        <span className="ak-label">Email</span>
        <input className="ak-input" type="email" inputMode="email" autoComplete="email webauthn" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {suggestion && err ? <button type="button" className="ak-textbtn" onClick={() => setEmail(suggestion)}>Use {suggestion}</button> : null}
      <Button type="submit" block disabled={busy}>{busy ? 'Sending…' : 'Email me a link'}</Button>
      <hr className="ak-rule" />
      {google ? <a className="ak-btn ak-btn--secondary ak-btn--block" href={`/api/auth/google/start${q}`}>Continue with Google</a> : null}
      {apple ? <a className="ak-btn ak-btn--secondary ak-btn--block" href={`/api/auth/apple/start${q}`}>Continue with Apple</a> : null}
      <Button type="button" variant="secondary" block onClick={passkey}>Use a passkey</Button>
    </form>
  );
}
