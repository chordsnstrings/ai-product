'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, LockButton, VideoThumb } from '@arkiv/ui';
import { api, LiveLedger, Sheet, usePoll } from '@arkiv/ui/client';
import type { ProjectView } from '@/lib/views';
import { ActionButton, ActionForm, AlternativeHint, SheetButton } from './actions';
import { blockedAlternative, fieldForAlternative, type BlockedAlternative } from '@/lib/claim-alternative';
import { AiDisclosureSteps, CancelProduction, Liveness, ProductionIssue, productionStopped, QueuedBanner } from './flow';

type V = { id: string; code: string; label: string; role: string; projectId: string | null; projectState: string | null; files: { aspect: string; label: string; url: string }[]; preview?: string | null; caption?: string };

export function StudioClient({ slug, experimentId, state, masterProjectId, variants, testsLeft, canApprove, disclosure = null }: { slug: string; experimentId: string; state: string; masterProjectId: string | null; variants: V[]; testsLeft: number; canApprove: boolean; disclosure?: ProjectView['disclosure'] }) {
  const router = useRouter();
  const producing = state === 'PRODUCING';
  const pre = state === 'APPROVED' || state === 'DRAFT' || state === 'RECOMMENDED';
  const [live, setLive] = useState(true);
  const { data: v, refresh } = usePoll<ProjectView>(`/api/projects/${masterProjectId ?? '00000000-0000-0000-0000-000000000000'}`, 2000, !!masterProjectId && live && (pre || producing));
  const [edit, setEdit] = useState<{ id: string; spokenLine: string; overlayText: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [alt, setAlt] = useState<BlockedAlternative | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
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
    setAlt(null);
    try {
      const r = (await api(url, body)) as { applied?: boolean; warning?: string } | undefined;
      // Plan 03 A3: an edit to what a controlled test keeps the same is confirmed first ("This makes it exploratory").
      if (r && r.applied === false && r.warning) {
        setWarning(r.warning);
        return false;
      }
      done();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      setAlt(blockedAlternative(e));
      return false;
    }
  }
  const saveEdit = async (acceptExploratory = false) => {
    if (!edit) return;
    if (await call(`/api/scenes/${edit.id}/edit`, { projectId: masterProjectId, spokenLine: edit.spokenLine || null, overlayText: edit.overlayText || null, ...(acceptExploratory ? { acceptExploratory: true } : {}) })) {
      setEdit(null);
      setWarning(null);
      if (acceptExploratory) router.refresh();
    }
  };

  return (
    <div className="ak-stack" style={{ marginTop: 32 }}>
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {pre ? (
        <>
          <h2 className="ak-label">Storyboard · master variant</h2>
          {!sb || sb.status === 'generating' ? <LiveLedger steps={sb?.steps ?? []} /> : null}
          {sb?.scenes.length ? (
            <div className="ak-scroll-row" role="list">
              {sb.scenes.map((s) => (
                <figure key={s.id} className="ak-frame" role="listitem" data-locked={s.locked}>
                  <div className="ak-well ak-well--916">{s.frameUrl ? <img src={s.frameUrl} alt={s.visualPlan} /> : <span className="ak-index" aria-hidden>{String(s.position + 1).padStart(2, '0')}</span>}</div>
                  <figcaption className="ak-small">
                    <span className="ak-index">{String(s.position + 1).padStart(2, '0')} · {s.purpose.replace('_', ' ')} · {(s.durationMs / 1000).toFixed(1)}s</span>
                    {s.overlayText ? <p style={{ fontWeight: 500 }}>{s.overlayText}</p> : null}
                    {s.spokenLine ? <p className="ak-muted">“{s.spokenLine}”</p> : null}
                    <div className="ak-row">
                      <button className="ak-textbtn" disabled={s.locked} onClick={() => setEdit({ id: s.id, spokenLine: s.spokenLine ?? '', overlayText: s.overlayText ?? '' })}>Edit words</button>
                      <LockButton locked={s.locked} scene={String(s.position + 1)} onClick={() => void call(`/api/scenes/${s.id}/lock`, { projectId: masterProjectId, locked: !s.locked })} />
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : null}
          <p className="ak-small ak-muted">Includes the master ad plus {variants.filter((x) => !x.projectId && x.role === 'variant').length} hook variants · 1 Creative Test · {testsLeft} left</p>
          {canApprove && sb?.status === 'ready' ? (
            testsLeft > 0 ? (
              <ApproveWithEstimate slug={slug} experimentId={experimentId} storyboardKey={JSON.stringify(sb.scenes.map((x) => [x.id, x.spokenLine, x.overlayText, x.locked]))} />
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
              <LiveLedger steps={v?.productionSteps ?? []} />
              {v ? <Liveness live={v.project.liveness} /> : null}
            </>
          )}
          {v && masterProjectId ? <CancelProduction projectId={masterProjectId} v={v} onChange={done} /> : null}
        </>
      ) : null}

      {!pre ? (
        <section>
          <h2 className="ak-label">Variants</h2>
          <p className="ak-small ak-muted">Put each code in your ad’s name (e.g. “Serum spring — {variants[0]?.code}”). We’ll match results automatically when your ad account is connected.</p>
          {variants.some((x) => x.preview) ? (
            <div className="ak-scroll-row" role="list" style={{ margin: '16px 0' }}>
              {variants.filter((x) => x.preview).map((x) => (
                <div key={x.id} role="listitem"><VideoThumb src={x.preview} caption={x.caption ?? x.code} label={`Variant ${x.code}: ${x.label}`} /></div>
              ))}
            </div>
          ) : null}
          <table className="ak-table">
            <thead><tr><th>Code</th><th>Hook</th><th>Files</th><th /></tr></thead>
            <tbody>
              {variants.map((x) => (
                <tr key={x.id}>
                  <td className="ak-mono">{x.code}</td>
                  <td>{x.label}{x.role === 'control' ? <span className="ak-chip" style={{ marginLeft: 8 }}>control</span> : null}</td>
                  <td>{x.files.length ? x.files.map((f) => <a key={f.label} href={f.url} style={{ marginRight: 10 }}>{f.label} ↓</a>) : <span className="ak-muted">{x.projectState ? x.projectState.toLowerCase().replace(/_/g, ' ') : 'pending'}</span>}</td>
                  <td>
                    <SheetButton variant="text" label="Link ad" title={`Link an ad to ${x.code}`} description="Only needed if the ad name doesn’t contain the code.">
                      <ActionForm slug={slug} action="link-ad" extra={{ variantId: x.id }} submit="Link" fields={[{ name: 'platform', label: 'Platform', type: 'select', options: [{ value: 'meta', label: 'Meta' }, { value: 'tiktok', label: 'TikTok' }] }, { name: 'adId', label: 'Ad ID', required: true }]} />
                    </SheetButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AiDisclosureSteps disclosure={disclosure} />
          <div className="ak-row" style={{ marginTop: 16 }}>
            {state === 'READY_TO_RUN' ? <ActionButton slug={slug} action="experiment-live" body={{ experimentId }} variant="primary">I’ve launched these ads</ActionButton> : null}
            <a className="ak-btn ak-btn--secondary" href={`/w/${slug}/results/${experimentId}`}>See results</a>
            <ActionButton slug={slug} action="experiment-archive" body={{ experimentId }} variant="text" confirm="Archive this test? Its learnings stay in your archive; an ad still being made is cancelled.">Archive</ActionButton>
          </div>
        </section>
      ) : null}

      <Sheet open={!!edit} onOpenChange={(o) => { if (!o) { setEdit(null); setWarning(null); } }} title="Edit this scene’s words" description="Free. Every change is checked against cosmetic claim rules.">
        {edit ? (
          <form className="ak-stack" onSubmit={async (e) => { e.preventDefault(); await saveEdit(); }}>
            <label className="ak-field"><span className="ak-label">Spoken line</span><textarea className="ak-textarea" maxLength={160} value={edit.spokenLine} onChange={(e) => { setWarning(null); setEdit({ ...edit, spokenLine: e.target.value }); }} /></label>
            <label className="ak-field"><span className="ak-label">On-screen text</span><input className="ak-input" maxLength={70} value={edit.overlayText} onChange={(e) => { setWarning(null); setEdit({ ...edit, overlayText: e.target.value }); }} /></label>
            {err ? <p className="ak-error" role="alert">{err}</p> : null}
            {err && alt ? <AlternativeHint alt={alt} onUse={(w) => { setEdit({ ...edit, [fieldForAlternative(edit, alt)]: w }); setErr(null); setAlt(null); }} /> : null}
            {warning ? (
              <Banner tone="warn">
                {warning}: this test keeps that part the same as your current ad so the result can be explained. After this change, a winner is still real but its cause isn’t isolated.
              </Banner>
            ) : null}
            {warning ? (
              <div className="ak-row">
                <Button type="button" onClick={() => void saveEdit(true)}>Save and make it exploratory</Button>
                <Button type="button" variant="secondary" onClick={() => setWarning(null)}>Keep it controlled</Button>
              </div>
            ) : (
              <Button type="submit">Save</Button>
            )}
          </form>
        ) : null}
      </Sheet>
    </div>
  );
}

type Quote = { quoteId: string; estimateMicros: number; ceilingMicros: number; withinCeiling: boolean; entitlementAvailable: boolean; blockedReason: string | null; expiresAt: string };
const dollars = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;

/**
 * §38 Production: the merchant sees what producing costs and whether it can be authorised before approving; the
 * approval carries that quote and an idempotency key, and the Cost Governor reserves in the same request.
 */
function ApproveWithEstimate({ slug, experimentId, storyboardKey }: { slug: string; experimentId: string; storyboardKey: string }) {
  const router = useRouter();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    try {
      setQuote(await api<Quote>(`/api/w/${slug}/render-estimate`, { experimentId }));
      setKey(crypto.randomUUID());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [slug, experimentId]);
  // A new estimate whenever the storyboard's words or locks change.
  useEffect(() => {
    void load();
  }, [load, storyboardKey]);
  async function approve() {
    if (!quote || !key) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/w/${slug}/experiment-approve`, { experimentId, quoteId: quote.quoteId, idempotencyKey: key });
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      // An expired estimate, a changed storyboard or new prices: show the fresh estimate to approve instead.
      if (/estimate|changed/i.test((e as Error).message)) await load();
    }
    setBusy(false);
  }
  if (!quote) return err ? <Banner tone="warn">{err}</Banner> : <p className="ak-small ak-muted">Estimating production cost…</p>;
  const ok = !quote.blockedReason;
  return (
    <div className="ak-panel ak-stack" style={{ maxWidth: 520 }}>
      <p className="ak-small" style={{ margin: 0 }}>
        Production estimate <strong>{dollars(quote.estimateMicros)}</strong> of the {dollars(quote.ceilingMicros)} a Creative Test covers ·{' '}
        {quote.entitlementAvailable ? 'uses 1 Creative Test' : 'no Creative Test available'}
      </p>
      {quote.blockedReason ? <Banner tone="warn">{quote.blockedReason}</Banner> : null}
      {err ? <p className="ak-error ak-small" role="alert">{err}</p> : null}
      <div><Button variant="primary" onClick={() => void approve()} disabled={busy || !ok}>{busy ? '…' : 'Approve and produce · 1 Creative Test'}</Button></div>
    </div>
  );
}
