'use client';

import { useEffect, useState } from 'react';
import { emailSuggestion } from '@arkiv/shared/auth';
import { Banner, Button, Field, Input } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';
import { HumanCheck, challengeOf } from './turnstile';

type Remote = 'pending' | 'consumed' | 'expired' | 'unknown';

/**
 * "Email me a link" (plan 03 P6 / Part C), shared by /login and the save gate:
 *  - a likely typo (jo@gmial.com) is offered as a one-tap fix before anything is sent, and again after sending;
 *  - past the per-IP sign-in limit the human check appears and the send is retried with its token;
 *  - while the link is outstanding this tab polls whether it was used: in this browser (another tab) it moves on
 *    by itself; on another device it says so and offers a link for this device.
 */
export function EmailLinkForm({
  next,
  label = 'Email',
  submitLabel = 'Email me a link',
  ttlMinutes,
  sentNote,
  autoComplete = 'email',
  children,
}: {
  next: string | null;
  label?: string;
  submitLabel?: string;
  ttlMinutes: number;
  sentNote?: string;
  autoComplete?: string;
  children?: React.ReactNode;
}) {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [remote, setRemote] = useState<Remote>('pending');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [siteKey, setSiteKey] = useState<string | null | undefined>(undefined);
  const [human, setHuman] = useState<string | null>(null);
  const typo = emailSuggestion(email);

  async function send(to: string) {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ pendingHandle: string }>('/api/auth/magic', { email: to, next, turnstile: human });
      setEmail(to);
      setSentTo(to);
      setHandle(r.pendingHandle);
      setRemote('pending');
      setSiteKey(undefined);
    } catch (x) {
      const c = challengeOf(x);
      if (c) setSiteKey(c.siteKey);
      setHuman(null);
      setErr((x as Error).message);
    }
    setBusy(false);
  }

  useEffect(() => {
    if (!sentTo || !handle || remote !== 'pending') return;
    const started = Date.now();
    const t = setInterval(async () => {
      if (Date.now() - started > (ttlMinutes + 1) * 60_000) return clearInterval(t);
      try {
        const r = await api<{ status: Remote; signedIn: boolean }>(`/api/auth/magic/status?handle=${encodeURIComponent(handle)}`, undefined, 'GET');
        if (r.status === 'consumed' && r.signedIn) {
          clearInterval(t);
          window.location.assign(next ?? '/app');
        } else if (r.status !== 'pending') {
          clearInterval(t);
          setRemote(r.status);
        }
      } catch {
        /* transient: keep polling */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [sentTo, handle, remote, next, ttlMinutes]);

  if (sentTo) {
    const fix = emailSuggestion(sentTo);
    return (
      <div className="ak-stack" aria-live="polite">
        {remote === 'consumed' ? (
          <>
            <p><strong>You’re signed in on your other device.</strong> Your work is saved to your account there.</p>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void send(sentTo)}>Email me a link for this device</Button>
          </>
        ) : remote === 'expired' ? (
          <>
            <p>That link has expired.</p>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void send(sentTo)}>Send a new link</Button>
          </>
        ) : (
          <p>Check <strong>{sentTo}</strong>. {sentNote ?? `The link works once and expires in ${ttlMinutes} minutes.`}</p>
        )}
        {fix ? (
          <p className="ak-small">
            Did you mean <strong>{fix}</strong>? <button type="button" className="ak-textbtn" disabled={busy} onClick={() => void send(fix)}>Send it to {fix} instead</button>
          </p>
        ) : null}
        {err ? <Banner tone="risk">{err}</Banner> : null}
        <button type="button" className="ak-textbtn" onClick={() => { setSentTo(null); setHandle(null); }}>Use a different email</button>
      </div>
    );
  }
  return (
    <form
      className="ak-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void send(email.trim());
      }}
    >
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <Field label={label}>
        <Input type="email" inputMode="email" autoComplete={autoComplete} required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {typo ? (
        <p className="ak-small" role="status">
          Did you mean <button type="button" className="ak-textbtn" onClick={() => setEmail(typo)}>{typo}</button>?
        </p>
      ) : null}
      {siteKey !== undefined ? <HumanCheck siteKey={siteKey} onToken={setHuman} /> : null}
      <Button type="submit" block disabled={busy || (siteKey !== undefined && !human)}>{busy ? 'Sending…' : submitLabel}</Button>
      {children}
    </form>
  );
}
