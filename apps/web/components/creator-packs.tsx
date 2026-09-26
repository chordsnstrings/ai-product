'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';
import { formatDate } from '@arkiv/shared/format';

type Pack = { id: string; expiresAt: string; revokedAt: string | null; views: number; uploads: number; createdAt: string };
type Footage = { id: string; createdAt: string; creator: string | null; filename: string | null; inReview: boolean; creativeId: string | null };

/**
 * Creator Packs for an experiment (standard §26): make a brief a human creator can shoot from, share its private
 * 14-day link (shown once), see views and footage sent back, and turn a link off.
 */
export function CreatorPacks({ slug, experimentId, packs, footage = [], canEdit, canAccept = false }: { slug: string; experimentId: string; packs: Pack[]; footage?: Footage[]; canEdit: boolean; canAccept?: boolean }) {
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
                  <td>{formatDate(p.createdAt)}</td>
                  <td>{p.revokedAt ? 'Turned off' : expired ? 'Expired' : `Live until ${formatDate(p.expiresAt)}`}</td>
                  <td className="ak-mono">{p.views}</td>
                  <td className="ak-mono">{p.uploads}</td>
                  <td>{canEdit && !p.revokedAt && !expired ? <button className="ak-textbtn" disabled={busy} onClick={() => act('creator-pack-revoke', { id: p.id })}>Turn off link</button> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {footage.length ? (
        <div className="ak-stack" style={{ gap: 8 }}>
          <h3 className="ak-label">Footage sent back</h3>
          <p className="ak-small ak-muted" style={{ margin: 0 }}>Using a take adds it to this test as its own variant and to your Creative Genome. By using it you confirm you have the rights to run it in ads.</p>
          <ul className="ak-stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 6 }}>
            {footage.map((f) => (
              <li key={f.id} className="ak-between ak-small" style={{ gap: 12 }}>
                <span>{f.filename ?? 'Footage'}{f.creator ? ` · ${f.creator}` : ''} · {formatDate(f.createdAt)}</span>
                {f.creativeId ? (
                  <span className="ak-chip ak-chip--ok">In this test</span>
                ) : f.inReview ? (
                  <span className="ak-muted">Being checked by our team</span>
                ) : canAccept ? (
                  <button className="ak-textbtn" disabled={busy} onClick={() => act('creator-footage-accept', { assetId: f.id })}>Use in this test</button>
                ) : (
                  <span className="ak-muted">An owner or admin can add it</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
