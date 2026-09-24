'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

type Pack = { id: string; expiresAt: string; revokedAt: string | null; views: number; uploads: number; createdAt: string };

/**
 * Creator Packs for an experiment (standard §26): make a brief a human creator can shoot from, share its private
 * 14-day link (shown once), see views and footage sent back, and turn a link off.
 */
export function CreatorPacks({ slug, experimentId, packs, canEdit }: { slug: string; experimentId: string; packs: Pack[]; canEdit: boolean }) {
  const router = useRouter();
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (action: string, body: unknown) => {
    setErr(null);
    setBusy(true);
    try {
      const r = (await api(`/api/w/${slug}/${action}`, body)) as { url?: string };
      if (r.url) setLink(r.url);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const live = packs.filter((p) => !p.revokedAt && new Date(p.expiresAt) > new Date());
  return (
    <section className="ak-panel ak-stack" style={{ marginTop: 32 }} aria-labelledby="creator-packs">
      <h2 className="ak-label" id="creator-packs">Creator Pack</h2>
      <p className="ak-small ak-muted">Brief a creator to shoot this test: hooks, shots, the claims they can and can’t make, framing. They send the footage back through the same link.</p>
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {link ? (
        <Banner>
          Share this link with your creator (it’s shown once and works for 14 days): <input className="ak-input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Creator Pack link" />
        </Banner>
      ) : null}
      {canEdit ? <Button disabled={busy} onClick={() => act('creator-pack', { experimentId })}>{live.length ? 'Make a new link' : 'Make a Creator Pack'}</Button> : null}
      {packs.length ? (
        <table className="ak-table ak-small">
          <thead><tr><th>Made</th><th>Status</th><th>Views</th><th>Footage</th><th /></tr></thead>
          <tbody>
            {packs.map((p) => {
              const expired = new Date(p.expiresAt) <= new Date();
              return (
                <tr key={p.id}>
                  <td>{new Date(p.createdAt).toLocaleDateString()}</td>
                  <td>{p.revokedAt ? 'Turned off' : expired ? 'Expired' : `Live until ${new Date(p.expiresAt).toLocaleDateString()}`}</td>
                  <td className="ak-mono">{p.views}</td>
                  <td className="ak-mono">{p.uploads}</td>
                  <td>{canEdit && !p.revokedAt && !expired ? <button className="ak-textbtn" disabled={busy} onClick={() => act('creator-pack-revoke', { id: p.id })}>Turn off link</button> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
