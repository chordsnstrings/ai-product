'use client';

import { useEffect, useRef, useState } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

export function ConfirmMagic({ token }: { token: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fired = useRef(false);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ next: string }>('/api/auth/magic/consume', { token });
      window.location.replace(r.next);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="ak-stack">
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <Button onClick={go} disabled={busy} block>{busy ? 'Signing in…' : 'Continue'}</Button>
    </div>
  );
}
