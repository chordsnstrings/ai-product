'use client';

import { useState } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

export function ClaimChoice({ token, next, productName, options }: { token: string; next: string | null; productName: string; options: { id: string; name: string }[] }) {
  const [target, setTarget] = useState<string>(options[0]?.id ?? 'new');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ next: string }>('/api/auth/claim', { c: token, target, next });
      window.location.assign(r.next);
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  }
  return (
    <form className="ak-stack" onSubmit={go} style={{ marginTop: 24 }}>
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <fieldset className="ak-stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="ak-label">Save {productName} to</legend>
        {options.map((o) => (
          <label key={o.id} className="ak-row" style={{ gap: 8 }}>
            <input type="radio" name="target" value={o.id} checked={target === o.id} onChange={() => setTarget(o.id)} />
            <span>Add {productName} to <strong>{o.name}</strong></span>
          </label>
        ))}
        <label className="ak-row" style={{ gap: 8 }}>
          <input type="radio" name="target" value="new" checked={target === 'new'} onChange={() => setTarget('new')} />
          <span>Create a new workspace</span>
        </label>
      </fieldset>
      <Button type="submit" block disabled={busy}>{busy ? 'Saving…' : 'Continue'}</Button>
    </form>
  );
}
