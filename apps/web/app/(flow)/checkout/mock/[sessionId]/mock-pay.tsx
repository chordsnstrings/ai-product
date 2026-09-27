'use client';

import { useState } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

export function MockPay({ sessionId, next, status }: { sessionId: string; next: string; status: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (status !== 'open') return <Banner tone="warn">This checkout is {status}.</Banner>;
  return (
    <div className="ak-stack">
      <Button
        block
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/api/checkout/mock/${sessionId}`, {});
            window.location.assign(next);
          } catch (e) {
            setErr((e as Error).message);
            setBusy(false);
          }
        }}
      >
        {busy ? 'Paying…' : 'Pay with test card'}
      </Button>
      {err ? <p className="ak-error">{err}</p> : null}
    </div>
  );
}
