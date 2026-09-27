'use client';

import { useState } from 'react';
import { Banner, Button, LinkButton } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';
import { HumanCheck, challengeOf } from '@/components/turnstile';

/** One tap sends a fresh link to the same address (plan 03 P6 "Link expired → a one-tap resend"). */
export function ResendMagic({ token, to, ttlMinutes }: { token: string; to: string; ttlMinutes: number }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [siteKey, setSiteKey] = useState<string | null | undefined>(undefined);
  const [human, setHuman] = useState<string | null>(null);
  async function send() {
    setState('busy');
    setErr(null);
    try {
      await api('/api/auth/magic/resend', { token, turnstile: human });
      setState('sent');
    } catch (e) {
      const c = challengeOf(e);
      if (c) setSiteKey(c.siteKey);
      setHuman(null);
      setErr((e as Error).message);
      setState('idle');
    }
  }
  if (state === 'sent') {
    return (
      <p role="status" className="ak-body">
        A new link is on its way to <strong>{to}</strong>. It works once, for {ttlMinutes} minutes.
      </p>
    );
  }
  return (
    <div className="ak-stack">
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {siteKey !== undefined ? <HumanCheck siteKey={siteKey} onToken={setHuman} /> : null}
      <Button onClick={() => void send()} disabled={state === 'busy' || (siteKey !== undefined && !human)} block>{state === 'busy' ? 'Sending…' : `Send a new link to ${to}`}</Button>
      <LinkButton href="/login" variant="secondary" block>Use a different email</LinkButton>
    </div>
  );
}
