'use client';

import { useState } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

export function AcceptInvite({ token }: { token: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="ak-stack">
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api<{ next: string }>(`/api/invites/${token}`, {});
            window.location.assign(r.next);
          } catch (e) {
            setErr((e as Error).message);
            setBusy(false);
          }
        }}
      >
        Accept invitation
      </Button>
    </div>
  );
}
