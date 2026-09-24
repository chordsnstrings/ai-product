'use client';

import { useEffect, useRef, useState } from 'react';
import { WebAuthnAbortService, browserSupportsWebAuthnAutofill, startAuthentication } from '@simplewebauthn/browser';
import { Banner, Button, Field, Input } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';
import { EmailLinkForm } from '@/components/email-link';
import { HumanCheck, challengeOf } from '@/components/turnstile';

type PasskeyOptions = { flow: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] };

/**
 * /login (plan 03 Part C): Apple · Google · email magic link · "Use password" (if set) · passkey, with passkeys also
 * offered in the email field's autofill (conditional UI) where the browser supports it.
 */
export function LoginForm({ next, error, challenge, google, apple, ttlMinutes }: { next: string | null; error: string | null; challenge: string | null; google: boolean; apple: boolean; ttlMinutes: number }) {
  const [err, setErr] = useState<string | null>(error);
  const [mode, setMode] = useState<'link' | 'password'>('link');
  const [human, setHuman] = useState<string | null>(null);
  const [siteKey, setSiteKey] = useState<string | null | undefined>(challenge ?? undefined);
  const nextRef = useRef(next);
  const q = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    if (next) p.set('next', next);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  async function finishPasskey(o: PasskeyOptions, response: Awaited<ReturnType<typeof startAuthentication>>) {
    const r = await api<{ next: string }>('/api/auth/passkey/verify', { flow: o.flow, response, next: nextRef.current, turnstile: human });
    window.location.assign(r.next);
  }

  // Conditional UI: passkeys appear in the email field's autofill; picking one signs in (plan 03 Part C).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let o: PasskeyOptions;
      let response: Awaited<ReturnType<typeof startAuthentication>>;
      try {
        if (!(await browserSupportsWebAuthnAutofill())) return;
        o = await api<PasskeyOptions>('/api/auth/passkey/options', {});
        if (cancelled) return;
        response = await startAuthentication({ optionsJSON: o.options, useBrowserAutofill: true });
      } catch {
        return; // no autofill here (unsupported, aborted, or no challenge available): the button still works
      }
      try {
        await finishPasskey(o, response);
      } catch (x) {
        const n = (x as Error).name;
        if (!cancelled && n !== 'AbortError' && n !== 'NotAllowedError') {
          const c = challengeOf(x);
          if (c) setSiteKey(c.siteKey);
          setErr((x as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
      WebAuthnAbortService.cancelCeremony();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function passkey() {
    setErr(null);
    try {
      // Starting a modal ceremony cancels the pending autofill one (simplewebauthn aborts it).
      const o = await api<PasskeyOptions>('/api/auth/passkey/options', {});
      const response = await startAuthentication({ optionsJSON: o.options });
      await finishPasskey(o, response);
    } catch (x) {
      const c = challengeOf(x);
      if (c) setSiteKey(c.siteKey);
      if ((x as Error).name !== 'NotAllowedError' && (x as Error).name !== 'AbortError') setErr((x as Error).message);
    }
  }

  return (
    <div className="ak-stack" style={{ marginTop: 24 }}>
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {siteKey !== undefined ? <HumanCheck siteKey={siteKey} onToken={setHuman} /> : null}
      {mode === 'link' ? (
        <EmailLinkForm next={next} ttlMinutes={ttlMinutes} autoComplete="email webauthn">
          <button type="button" className="ak-textbtn" onClick={() => setMode('password')}>Use password</button>
        </EmailLinkForm>
      ) : (
        <PasswordForm next={next} human={human} onChallenge={(k) => setSiteKey(k)} onBack={() => setMode('link')} />
      )}
      <hr className="ak-rule" />
      {apple ? <a className="ak-btn ak-btn--secondary ak-btn--block" href={`/api/auth/apple/start${q({ turnstile: human })}`}>Continue with Apple</a> : null}
      {google ? <a className="ak-btn ak-btn--secondary ak-btn--block" href={`/api/auth/google/start${q({ turnstile: human })}`}>Continue with Google</a> : null}
      <Button type="button" variant="secondary" block onClick={passkey}>Use a passkey</Button>
    </div>
  );
}

/** "Use password" — only for people who set one in Profile; the emailed link stays one tap away. */
function PasswordForm({ next, human, onChallenge, onBack }: { next: string | null; human: string | null; onChallenge: (siteKey: string | null) => void; onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
          const r = await api<{ next: string }>('/api/auth/password', { email, password, next, turnstile: human });
          window.location.assign(r.next);
          return;
        } catch (x) {
          const c = challengeOf(x);
          if (c) onChallenge(c.siteKey);
          setErr((x as Error).message);
        }
        setBusy(false);
      }}
    >
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <Field label="Email">
        <Input type="email" inputMode="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password">
        <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button type="submit" block disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      <p className="ak-small ak-muted">Forgot it? <button type="button" className="ak-textbtn" onClick={onBack}>Email me a link instead</button> — you can set a new password in Profile.</p>
    </form>
  );
}
