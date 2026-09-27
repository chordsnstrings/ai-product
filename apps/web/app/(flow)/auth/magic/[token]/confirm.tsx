'use client';

import { useState } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';
import { HumanCheck, challengeOf } from '@/components/turnstile';

/**
 * The only thing that consumes a sign-in link is pressing Continue (plan 03 Part C). It never submits on its own:
 * link scanners that run scripts would otherwise burn the single-use token before the person clicks.
 */
export function ConfirmMagic({ token }: { token: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [human, setHuman] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ next: string }>('/api/auth/magic/consume', { token, turnstile: human });
      window.location.replace(r.next);
    } catch (e) {
      const c = challengeOf(e);
      if (c) setSiteKey(c.siteKey);
      setHuman(null);
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="ak-stack">
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {siteKey ? <HumanCheck siteKey={siteKey} onToken={setHuman} /> : null}
      <Button onClick={go} disabled={busy || (!!siteKey && !human)} block autoFocus>{busy ? 'Signing in…' : 'Continue'}</Button>
    </div>
  );
}
