'use client';

import { useState } from 'react';

/** The creator's upload-back form on a Creator Pack page (§26): the footage, their name and a rights attestation. */
export function CreatorUpload({ token, brand }: { token: string; brand: string }) {
  const [state, setState] = useState<{ status: 'idle' | 'busy' | 'done' | 'error'; message?: string }>({ status: 'idle' });
  if (state.status === 'done') return <p role="status">Thanks — your footage is with {brand}.</p>;
  return (
    <form
      className="ak-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setState({ status: 'busy' });
        const r = await fetch(`/api/pack/${encodeURIComponent(token)}`, { method: 'POST', body: new FormData(e.currentTarget) });
        const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
        setState(r.ok ? { status: 'done' } : { status: 'error', message: j.error?.message ?? 'The upload didn’t go through. Please try again.' });
      }}
    >
      <label className="ak-stack">
        <span className="ak-label">Video or photo</span>
        <input type="file" name="file" accept="video/mp4,video/quicktime,image/jpeg,image/png,image/webp" required />
      </label>
      <label className="ak-stack">
        <span className="ak-label">Your name</span>
        <input className="ak-input" name="name" maxLength={120} required autoComplete="name" />
      </label>
      <label className="ak-row" style={{ alignItems: 'flex-start', gap: 8 }}>
        <input type="checkbox" name="rights" required />
        <span className="ak-small">I made this footage, everyone in it agreed and is an adult, and I grant {brand} the right to use it in paid and organic ads.</span>
      </label>
      {state.status === 'error' ? <p className="ak-error" role="alert">{state.message}</p> : null}
      <button className="ak-btn" type="submit" disabled={state.status === 'busy'}>{state.status === 'busy' ? 'Uploading…' : 'Send footage'}</button>
    </form>
  );
}
