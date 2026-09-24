'use client';

import { useState } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api, confirmSheet } from '@arkiv/ui/client';

export function DecideOwnership({ token }: { token: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function decide(confirm: boolean) {
    if (confirm && !(await confirmSheet({ title: 'Transfer ownership now?', body: 'You will become an admin.', confirmLabel: 'Confirm new owner' })).ok) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ next: string; confirmed: boolean }>(`/api/ownership/${token}`, { confirm });
      if (r.confirmed) window.location.assign(r.next);
      else setDone('Declined. Nothing changed; we’ve let Arkiv support know.');
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }
  if (done) return <Banner>{done}</Banner>;
  return (
    <div className="ak-stack">
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <div className="ak-row">
        <Button disabled={busy} onClick={() => decide(true)}>Confirm new owner</Button>
        <Button variant="secondary" disabled={busy} onClick={() => decide(false)}>Decline</Button>
      </div>
    </div>
  );
}
