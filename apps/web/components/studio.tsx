'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, Ledger } from '@arkiv/ui';
import { api, Sheet, usePoll } from '@arkiv/ui/client';
import type { ProjectView } from '@/lib/views';
import { ActionButton, ActionForm, SheetButton } from './actions';
import { Liveness, ProductionIssue, productionStopped, QueuedBanner } from './flow';

type V = { id: string; code: string; label: string; role: string; projectId: string | null; projectState: string | null; files: { aspect: string; url: string }[] };

export function StudioClient({ slug, experimentId, state, masterProjectId, variants, testsLeft, canApprove }: { slug: string; experimentId: string; state: string; masterProjectId: string | null; variants: V[]; testsLeft: number; canApprove: boolean }) {
  const router = useRouter();
  const producing = state === 'PRODUCING';
  const pre = state === 'APPROVED' || state === 'DRAFT' || state === 'RECOMMENDED';
  const [live, setLive] = useState(true);
  const { data: v, refresh } = usePoll<ProjectView>(`/api/projects/${masterProjectId ?? '00000000-0000-0000-0000-000000000000'}`, 2000, !!masterProjectId && live && (pre || producing));
  const [edit, setEdit] = useState<{ id: string; spokenLine: string; overlayText: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = useCallback(() => { setLive(true); refresh(); }, [refresh]);
  const masterDone = !!v && producing && v.project.state === 'COMPLETE';
  useEffect(() => {
    if (!masterDone) return;
    setLive(false);
    const t = setTimeout(() => router.refresh(), 1500);
    return () => clearTimeout(t);
  }, [masterDone, router]);
  const sb = v?.storyboard;

  async function call(url: string, body: unknown) {
    setErr(null);
    try {
      await api(url, body);
      done();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    }
  }

  return (
    <div className="ak-stack" style={{ marginTop: 32 }}>
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {pre ? (
        <>
          <h2 className="ak-label">Storyboard · master variant</h2>
          {!sb || sb.status === 'generating' ? <Ledger steps={sb?.steps ?? []} /> : null}
          {sb?.scenes.length ? (
            <div className="ak-scroll-row" role="list">
              {sb.scenes.map((s) => (
                <figure key={s.id} className="ak-frame" role="listitem" data-locked={s.locked}>
                  <div className="ak-well ak-well--916">{s.frameUrl ? <img src={s.frameUrl} alt={s.visualPlan} /> : <div className="ak-stone" style={{ height: '100%' }} />}</div>
                  <figcaption className="ak-small">
                    <span className="ak-index">{String(s.position + 1).padStart(2, '0')} · {s.purpose.replace('_', ' ')} · {(s.durationMs / 1000).toFixed(1)}s</span>
                    {s.overlayText ? <p style={{ fontWeight: 600 }}>{s.overlayText}</p> : null}
                    {s.spokenLine ? <p className="ak-muted">“{s.spokenLine}”</p> : null}
                    <div className="ak-row">
                      <button className="ak-textbtn" disabled={s.locked} onClick={() => setEdit({ id: s.id, spokenLine: s.spokenLine ?? '', overlayText: s.overlayText ?? '' })}>Edit words</button>
                      <button className="ak-textbtn" onClick={() => call(`/api/scenes/${s.id}/lock`, { projectId: masterProjectId, locked: !s.locked })}>{s.locked ? 'Unlock' : 'Lock'}</button>
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : null}
          <p className="ak-small ak-muted">Includes the master ad plus {variants.filter((x) => !x.projectId && x.role === 'variant').length} hook variants · 1 Creative Test · {testsLeft} left</p>
          {canApprove && sb?.status === 'ready' ? (
            testsLeft > 0 ? (
              <div><ActionButton slug={slug} action="experiment-approve" body={{ experimentId }} variant="primary">Approve and produce · 1 Creative Test</ActionButton></div>
            ) : (
              <Banner tone="warn">No Creative Tests left this period. <a href={`/w/${slug}/settings/billing`}>Upgrade</a> to produce this test.</Banner>
            )
          ) : null}
        </>
      ) : null}

      {producing ? (
        <>
          <h2 className="ak-label">Producing</h2>
          {v?.project.paused ? <QueuedBanner v={v} /> : null}
          {v && masterProjectId && productionStopped(v) ? (
            <ProductionIssue projectId={masterProjectId} v={v} onChange={done} />
          ) : v?.project.resumable && masterProjectId ? (
            <p>The storyboard is open for your change. <a href={`/storyboard/${masterProjectId}`}>Change the line and finish</a> — no extra Creative Test.</p>
          ) : (
            <>
              <Ledger steps={v?.productionSteps ?? []} />
              {v ? <Liveness live={v.project.liveness} /> : null}
            </>
          )}
        </>
      ) : null}

      {!pre ? (
        <section>
          <h2 className="ak-label">Variants</h2>
          <p className="ak-small ak-muted">Put each code in your ad’s name (e.g. “Serum spring — {variants[0]?.code}”). We’ll match results automatically when your ad account is connected.</p>
          <table className="ak-table">
            <thead><tr><th>Code</th><th>Hook</th><th>Files</th><th /></tr></thead>
            <tbody>
              {variants.map((x) => (
                <tr key={x.id}>
                  <td className="ak-mono">{x.code}</td>
                  <td>{x.label}{x.role === 'control' ? <span className="ak-chip" style={{ marginLeft: 8 }}>control</span> : null}</td>
                  <td>{x.files.length ? x.files.map((f) => <a key={f.aspect} href={f.url} style={{ marginRight: 10 }}>{f.aspect} ↓</a>) : <span className="ak-muted">{x.projectState ? x.projectState.toLowerCase().replace(/_/g, ' ') : 'pending'}</span>}</td>
                  <td>
                    <SheetButton variant="text" label="Link ad" title={`Link an ad to ${x.code}`} description="Only needed if the ad name doesn’t contain the code.">
                      <ActionForm slug={slug} action="link-ad" extra={{ variantId: x.id }} submit="Link" fields={[{ name: 'platform', label: 'Platform', type: 'select', options: [{ value: 'meta', label: 'Meta' }, { value: 'tiktok', label: 'TikTok' }] }, { name: 'adId', label: 'Ad ID', required: true }]} />
                    </SheetButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ak-row" style={{ marginTop: 16 }}>
            {state === 'READY_TO_RUN' ? <ActionButton slug={slug} action="experiment-live" body={{ experimentId }} variant="primary">I’ve launched these ads</ActionButton> : null}
            <a className="ak-btn ak-btn--secondary" href={`/w/${slug}/results/${experimentId}`}>See results</a>
            <ActionButton slug={slug} action="experiment-archive" body={{ experimentId }} variant="text" confirm="Archive this test? Its learnings stay in your archive.">Archive</ActionButton>
          </div>
        </section>
      ) : null}

      <Sheet open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title="Edit this scene’s words" description="Free. Every change is checked against cosmetic claim rules.">
        {edit ? (
          <form className="ak-stack" onSubmit={async (e) => { e.preventDefault(); if (await call(`/api/scenes/${edit.id}/edit`, { projectId: masterProjectId, spokenLine: edit.spokenLine || null, overlayText: edit.overlayText || null })) setEdit(null); }}>
            <label className="ak-field"><span className="ak-label">Spoken line</span><textarea className="ak-textarea" maxLength={160} value={edit.spokenLine} onChange={(e) => setEdit({ ...edit, spokenLine: e.target.value })} /></label>
            <label className="ak-field"><span className="ak-label">On-screen text</span><input className="ak-input" maxLength={70} value={edit.overlayText} onChange={(e) => setEdit({ ...edit, overlayText: e.target.value })} /></label>
            {err ? <p className="ak-error">{err}</p> : null}
            <Button type="submit">Save</Button>
          </form>
        ) : null}
      </Sheet>
    </div>
  );
}
