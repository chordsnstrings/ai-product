'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, ClaimChip, Ledger, LinkButton, MetadataTable, ProvenanceChip, Rail } from '@arkiv/ui';
import { api, OfferExpiry, Sheet, StickyCta, usePoll } from '@arkiv/ui/client';
import type { ProjectView } from '@/lib/views';

type View = ProjectView & { access: { provisional: boolean; signedIn: boolean; role: string; workspaceSlug: string | null } };

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(micros % 1_000_000 === 0 ? 0 : 2)}`;
const PRODUCING = ['STORYBOARD_APPROVED', 'RENDER_RESERVED', 'RENDERING', 'QA_RUNNING', 'COMPOSING', 'PLATFORM_VARIANTS', 'FINAL_QA'];

function useProject(id: string, active: (v: View | null) => boolean) {
  const [live, setLive] = useState(true);
  const poll = usePoll<View>(`/api/projects/${id}`, 1500, live);
  useEffect(() => {
    if (poll.data) setLive(active(poll.data));
  }, [poll.data, active]);
  return { ...poll, resume: () => setLive(true) };
}

function Shell({ step, children, title, sub }: { step: 1 | 2 | 3 | 4; children: React.ReactNode; title: string; sub?: React.ReactNode }) {
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 1080 }}>
      <Rail step={step} />
      <h1 className="ak-h1" style={{ marginTop: 32 }}>{title}</h1>
      {sub ? <p className="ak-body-l ak-muted" style={{ maxWidth: 640 }}>{sub}</p> : null}
      <div style={{ marginTop: 32 }}>{children}</div>
    </div>
  );
}

function Loading() {
  return (
    <div className="ak-wrap ak-section">
      <p className="ak-muted ak-small">Loading…</p>
    </div>
  );
}

/* ───────────── P3/P4 · Analysis → confirmation ───────────── */

const FACT_LABELS: Record<string, string> = { name: 'Name', brand: 'Brand', size: 'Size', price: 'Price', compare_at_price: 'Compare-at', category: 'Category', texture: 'Texture', ingredients: 'Key ingredients', sku_code: 'SKU', gtin: 'GTIN' };
const EDITABLE = new Set(['name', 'brand', 'size', 'price', 'category', 'texture', 'ingredients']);
/** Where a disagreeing value came from, in customer words. */
const SOURCE_WORDS: Record<string, string> = { shopify: 'Your Shopify store', product_page: 'Your product page', json_ld: 'Your product page', photo_ocr: 'The label in your photos', import: 'Your import' };

/** Inline inputs for facts we could not find (plan 03 P3 "ask for the missing field"; §42 ingredient source). */
function MissingFacts({ projectId, fields, onSaved }: { projectId: string; fields: { key: string; label: string; hint?: string }[]; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!fields.length) return null;
  async function save(key: string) {
    setErr(null);
    setBusy(key);
    try {
      await api(`/api/projects/${projectId}/fact`, { key, value: values[key] ?? '' });
      setValues((v) => ({ ...v, [key]: '' }));
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
  }
  return (
    <div className="ak-stack">
      {fields.map((f) => (
        <form key={f.key} className="ak-stack" style={{ gap: 4 }} onSubmit={(e) => { e.preventDefault(); void save(f.key); }}>
          <label className="ak-label" htmlFor={`missing-${f.key}`}>{f.label}</label>
          {f.hint ? <span className="ak-small ak-muted">{f.hint}</span> : null}
          <div className="ak-row">
            {f.key === 'ingredients' ? (
              <textarea id={`missing-${f.key}`} className="ak-input" rows={3} maxLength={400} value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : (
              <input id={`missing-${f.key}`} className="ak-input" maxLength={400} value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            )}
            <Button size="sm" type="submit" disabled={!values[f.key]?.trim() || busy === f.key}>Save</Button>
          </div>
        </form>
      ))}
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
    </div>
  );
}

/**
 * §42 "Variants / sizes": which size or shade this ad is for, so it never shows the wrong one. Chosen before an
 * idea is picked (the storyboard is drawn for it); until then no size or price that differs between them is used.
 */
function VariantPicker({ projectId, v, onSaved }: { projectId: string; v: View; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const locked = !['PRODUCT_UPLOADED', 'PRODUCT_ANALYZED', 'BRIEF_READY', 'CONCEPTS_READY', 'NEEDS_USER_ACTION'].includes(v.project.state);
  const chosen = v.sku.variants.find((x) => x.id === v.project.variantId) ?? null;
  async function choose(variantId: string) {
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/variant`, { variantId: variantId || null });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="ak-panel ak-stack">
      <label className="ak-label" htmlFor="variant">Which one is this ad for?</label>
      <select id="variant" className="ak-input" value={v.project.variantId ?? ''} disabled={locked} onChange={(e) => void choose(e.target.value)}>
        <option value="">Not chosen — we won’t mention a size, shade or price that differs</option>
        {v.sku.variants.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}{x.priceMicros != null ? ` · ${usd(x.priceMicros)}` : ''}{x.available === false ? ' · out of stock' : ''}
          </option>
        ))}
      </select>
      {chosen?.available === false ? <Banner tone="warn">{chosen.title} is out of stock on your store. You can still make the ad, but check it before you run it.</Banner> : null}
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
    </div>
  );
}

export function AnalysisFlow({ projectId }: { projectId: string }) {
  const active = useCallback((v: View | null) => !v || v.sku.status === 'analyzing' || (v.sku.status === 'active' && v.concepts.length === 0 && v.project.state !== 'NEEDS_USER_ACTION'), []);
  const { data: v, error, refresh, resume } = useProject(projectId, active);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!v) return error ? <div className="ak-wrap ak-section"><Banner tone="risk">{error}</Banner></div> : <Loading />;

  if (v.sku.status === 'rejected') {
    return (
      <Shell step={1} title="We can’t make an ad for this product" sub={v.sku.rejectReason ?? 'This product is outside what Arkiv supports.'}>
        <p className="ak-muted">Arkiv is built for cosmetic skincare only — cleansers, serums, moisturisers and similar, not sunscreen/SPF or acne and other OTC treatments. You haven’t been charged anything.</p>
        <LinkButton href="/#upload" variant="secondary">Try a different product</LinkButton>
      </Shell>
    );
  }

  const analyzing = v.sku.status === 'analyzing';
  // The analysis ended without finishing (plan 03 P3): show what we have, ask for what's missing, offer a retry.
  const failed = v.sku.status === 'needs_input';
  const ready = v.concepts.length > 0;
  async function retryAnalysis() {
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/retry-analysis`, {});
      resume();
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function save(key: string) {
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/fact`, { key, value: draft });
      setEditing(null);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  const disputed = v.facts.filter((f) => f.disputed);
  // Keep the merchant's correction (a fresh decision acknowledges the newer source value) or take the source's.
  async function resolveSource(key: string, keep: { value: string } | { factId: string }) {
    setErr(null);
    try {
      if ('factId' in keep) await api(`/api/projects/${projectId}/fact-accept-source`, { factId: keep.factId });
      else await api(`/api/projects/${projectId}/fact`, { key, value: keep.value });
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <Shell
      step={1}
      title={analyzing ? 'Cataloguing your product' : failed ? 'We couldn’t finish reading this product' : v.sku.name}
      sub={analyzing ? 'This is real work, happening now — usually under a minute. You can leave this tab; we’ll keep going.' : failed ? 'Here’s what we found. Add anything that’s missing and try again — nothing has been charged.' : `No. ${String(v.sku.catalogueNo).padStart(3, '0')} · Check the details below. Anything you correct is used exactly as you write it.`}
    >
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <div className="ak-specimen" data-ready={!!v.sku.cutoutUrl}>
          {v.sku.cutoutUrl ? <img src={v.sku.cutoutUrl} alt={`${v.sku.name} product photo`} className="ak-draw" /> : <div className="ak-stone" style={{ aspectRatio: '4/5' }} aria-hidden />}
          <p className="ak-specimen-caption ak-index">No. {String(v.sku.catalogueNo).padStart(3, '0')}{v.sku.packaging?.type ? ` · ${String(v.sku.packaging.type)}` : ''}</p>
        </div>
        <div className="ak-stack">
          <Ledger steps={v.steps} />
          {!analyzing ? (
            <>
              {disputed.length ? <Banner tone="warn">Your page and photos disagree on {disputed.map((d) => FACT_LABELS[d.key] ?? d.key).join(', ')}. Tell us which is right.</Banner> : null}
              {v.facts.some((f) => f.sourceConflict?.newer) ? <Banner tone="warn">Your store changed {v.facts.filter((f) => f.sourceConflict?.newer).map((d) => FACT_LABELS[d.key] ?? d.key).join(', ')} since you corrected it. Keep yours, or use the store’s value.</Banner> : null}
              <MetadataTable
                animate
                rows={v.facts
                  .filter((f) => FACT_LABELS[f.key])
                  .map((f) => ({
                    key: f.key,
                    label: FACT_LABELS[f.key]!,
                    value:
                      editing === f.key ? (
                        <form onSubmit={(e) => { e.preventDefault(); void save(f.key); }} className="ak-row">
                          <input className="ak-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={FACT_LABELS[f.key]} />
                          <Button size="sm" type="submit">Save</Button>
                          <button type="button" className="ak-textbtn" onClick={() => setEditing(null)}>Cancel</button>
                        </form>
                      ) : (
                        <span>
                          {f.key === 'ingredients' && f.value.length > 120 ? `${f.value.slice(0, 120)}…` : f.value}
                          {EDITABLE.has(f.key) ? <button className="ak-textbtn" style={{ marginLeft: 8 }} onClick={() => { setEditing(f.key); setDraft(f.value); }}>Fix</button> : null}
                          {f.sourceConflict ? (
                            <span className="ak-small ak-muted" style={{ display: 'block' }}>
                              {SOURCE_WORDS[f.sourceConflict.source] ?? 'Another source'} {f.sourceConflict.newer ? 'now says' : 'says'} “{f.sourceConflict.value}”
                              {f.sourceConflict.newer ? ` (since ${new Date(f.sourceConflict.observedAt).toLocaleDateString()})` : ''}.
                              {f.sourceConflict.newer && EDITABLE.has(f.key) ? (
                                <>
                                  {' '}<button className="ak-textbtn" onClick={() => void resolveSource(f.key, { value: f.value })}>Keep yours</button>
                                  {' · '}<button className="ak-textbtn" onClick={() => void resolveSource(f.key, { factId: f.sourceConflict!.factId })}>Use store value</button>
                                </>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                      ),
                    chip: <ProvenanceChip state={f.state as 'OBSERVED' | 'INFERRED' | 'DECIDED'} source={f.source} />,
                  }))}
              />
              {err ? <p className="ak-error" role="alert">{err}</p> : null}
              {failed ? (
                <div className="ak-stack">
                  <Banner tone="warn">{v.project.failureReason ?? 'We couldn’t finish reading this product.'}</Banner>
                  <MissingFacts projectId={projectId} fields={v.sku.missingFacts} onSaved={refresh} />
                  <div><Button onClick={() => void retryAnalysis()}>Try again</Button></div>
                </div>
              ) : !v.sku.ingredientsVerified ? (
                <div className="ak-panel ak-stack">
                  <h2 className="ak-label">Add your ingredient list to unlock ingredient tests</h2>
                  <p className="ak-small ak-muted" style={{ margin: 0 }}>We didn’t find an ingredient list on your page or label, so we won’t suggest ingredient-led ads or guess ingredients from the category.</p>
                  <MissingFacts projectId={projectId} fields={[{ key: 'ingredients', label: 'Key ingredients', hint: 'As printed on the pack, e.g. “Niacinamide, Zinc PCA”.' }]} onSaved={refresh} />
                </div>
              ) : null}
              {!failed && v.sku.variants.length > 1 ? <VariantPicker projectId={projectId} v={v} onSaved={refresh} /> : null}
              {!failed && v.sku.missingEvidence.length ? (
                <div>
                  <h2 className="ak-label">What would make these ads stronger</h2>
                  <ul className="ak-small" style={{ margin: 0 }}>{v.sku.missingEvidence.map((m) => <li key={m}>{m}</li>)}</ul>
                </div>
              ) : null}
              {v.claims.length ? (
                <div>
                  <h2 className="ak-label">Claims we found</h2>
                  <ul className="ak-stack" style={{ listStyle: 'none', padding: 0 }}>
                    {v.claims.map((c) => (
                      <li key={c.id} className="ak-between ak-small" style={{ gap: 12 }}>
                        <span>“{c.wording}”{c.reason ? <span className="ak-muted"> — {c.reason}</span> : null}</span>
                        <ClaimChip status={c.status} />
                      </li>
                    ))}
                  </ul>
                  <p className="ak-small ak-muted">Blocked claims never appear in your ads. Cosmetic products can’t claim to treat or change the skin’s structure (FDA).</p>
                </div>
              ) : null}
              {failed ? null : ready ? (
                <LinkButton href={`/concepts/${projectId}`} block id="cta">Looks right — show me 3 ad ideas</LinkButton>
              ) : v.project.state === 'NEEDS_USER_ACTION' ? (
                <Banner tone="warn">{v.project.failureReason ?? 'We need a clearer photo of the product. Add one to continue.'}</Banner>
              ) : (
                <p className="ak-muted ak-small">Drafting three test ideas…</p>
              )}
            </>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}

/* ───────────── P5/P6 · Concepts + save gate ───────────── */

const RISK: Record<string, string> = { lower_risk: 'Safer bet', adjacent: 'Adjacent', exploratory: 'Exploratory' };

export function ConceptsFlow({ projectId }: { projectId: string }) {
  const active = useCallback(
    (v: View | null) => !v || v.concepts.length === 0 || v.project.state === 'CONCEPT_SELECTED' || v.conceptRequest?.status === 'pending' || v.conceptRequest?.status === 'active',
    [],
  );
  const { data: v, error, refresh, resume } = useProject(projectId, active);
  const [gate, setGate] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!v) return error ? <div className="ak-wrap ak-section"><Banner tone="risk">{error}</Banner></div> : <Loading />;

  async function choose(conceptId: string) {
    if (v!.access.provisional) return setGate(conceptId);
    setBusy(conceptId);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/select`, { conceptId });
      window.location.assign(`/storyboard/${projectId}`);
    } catch (e) {
      setBusy(null);
      setErr((e as Error).message);
    }
  }
  async function more() {
    setBusy('more');
    setErr(null);
    try {
      // Queued server-side (202); polling picks up the new batch or the request's failure.
      await api(`/api/projects/${projectId}/concepts`, {});
      resume();
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
  }
  const drafting = v.conceptRequest?.status === 'pending' || v.conceptRequest?.status === 'active';

  return (
    <Shell step={2} title="Three ways to test this product" sub={<>Each idea is a different bet on why a customer would stop scrolling. We marked the one we’d test first — pick any.</>}>
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {v.conceptRequest?.status === 'failed' && v.conceptRequest.batch > (v.concepts[0]?.batch ?? 0) ? <Banner tone="warn">{v.conceptRequest.detail ?? 'We couldn’t draft more ideas just now. Please try again.'}</Banner> : null}
      {v.concepts.length === 0 ? (
        <p className="ak-muted">Drafting ideas…</p>
      ) : (
        <div className="ak-grid-3">
          {v.concepts.map((c) => {
            const hooks = c.hookOptions ?? [];
            return (
              <article key={c.id} className={`ak-card${c.isPick ? ' ak-card--pick' : ''}`}>
                <div className="ak-between">
                  <span className="ak-index">{c.idx}</span>
                  {c.isPick ? <span className="ak-chip ak-chip--dec">Our pick</span> : <span className="ak-chip">{RISK[c.riskProfile] ?? ''}</span>}
                </div>
                <h2 className="ak-h2 ak-serif" style={{ marginTop: 16 }}>“{hooks[0]}”</h2>
                <p className="ak-small">{c.hypothesis}</p>
                <dl className="ak-meta ak-small">
                  <dt>Tests</dt><dd>{String(c.primaryVariable)}</dd>
                  <dt>Angle</dt><dd>{String(c.angle).replace(/_/g, ' ')}</dd>
                  <dt>Proof</dt><dd>{String(c.proofMechanism).replace(/_/g, ' ')}</dd>
                  <dt>You’ll learn</dt><dd>{c.expectedLearning}</dd>
                </dl>
                {c.isPick && c.pickReason ? <p className="ak-small ak-muted">Why: {c.pickReason}</p> : null}
                <Button block variant={c.isPick ? 'primary' : 'secondary'} disabled={!!busy} onClick={() => choose(c.id)} id={c.isPick ? 'cta' : undefined}>
                  {busy === c.id ? 'Building storyboard…' : 'Build this storyboard'}
                </Button>
              </article>
            );
          })}
        </div>
      )}
      {v.concepts.length ? (
        <p style={{ marginTop: 24 }}>
          <button className="ak-textbtn" disabled={!!busy || drafting} onClick={more} aria-live="polite">{busy === 'more' || drafting ? 'Drafting three more ideas…' : 'None of these — try 3 more'}</button>
        </p>
      ) : null}
      <SaveGate open={!!gate} onOpenChange={(o) => !o && setGate(null)} next={`/concepts/${projectId}`} productName={v.sku.name} />
    </Shell>
  );
}

/** P6 save gate: value first, then a light ask — email link or one-tap Google/Apple. Preview is preserved either way. */
export function SaveGate({ open, onOpenChange, next, productName }: { open: boolean; onOpenChange: (o: boolean) => void; next: string; productName: string }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const r = await api<{ suggestion: string | null }>('/api/auth/magic', { email, next });
      setSuggestion(r.suggestion);
      setSent(true);
    } catch (x) {
      setErr((x as Error).message);
      setSuggestion(((x as { details?: { suggestion?: string } }).details?.suggestion) ?? null);
    }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Save your work to continue" description={`Your ${productName} catalogue and ideas are kept. No card needed.`}>
      {sent ? (
        <div className="ak-stack">
          <p>Check <strong>{email}</strong> — we sent a sign-in link. It opens right back here.</p>
          {suggestion ? <p className="ak-small ak-muted">Did you mean {suggestion}?</p> : null}
          <button className="ak-textbtn" onClick={() => setSent(false)}>Use a different email</button>
        </div>
      ) : (
        <form onSubmit={send} className="ak-stack">
          <label className="ak-field">
            <span className="ak-label">Work email</span>
            <input className="ak-input" type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {err ? <p className="ak-error" role="alert">{err}{suggestion ? <> — did you mean <button type="button" className="ak-textbtn" onClick={() => setEmail(suggestion)}>{suggestion}</button>?</> : null}</p> : null}
          <Button type="submit" block>Email me a sign-in link</Button>
          <div className="ak-row" style={{ justifyContent: 'center' }}>
            <a className="ak-btn ak-btn--secondary" href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}>Continue with Google</a>
            <a className="ak-btn ak-btn--secondary" href={`/api/auth/apple/start?next=${encodeURIComponent(next)}`}>Continue with Apple</a>
          </div>
          <p className="ak-small ak-muted">By continuing you agree to the <a href="/legal/terms">Terms</a> and <a href="/legal/privacy">Privacy Policy</a>.</p>
        </form>
      )}
    </Sheet>
  );
}

/* ───────────── P7 · Storyboard + offer ───────────── */

const PURPOSE: Record<string, string> = { hook: 'Hook', problem: 'Problem', product_reveal: 'Reveal', demonstration: 'Demo', proof: 'Proof', benefit: 'Benefit', routine: 'Routine', cta: 'Call to action' };

export function StoryboardFlow({ projectId }: { projectId: string }) {
  const active = useCallback(
    (v: View | null) => !v || !v.storyboard || v.storyboard.status === 'generating' || v.storyboard.scenes.some((s) => s.regeneration?.status === 'pending' || s.regeneration?.status === 'active'),
    [],
  );
  const { data: v, error, refresh, resume } = useProject(projectId, active);
  const [edit, setEdit] = useState<{ id: string; spokenLine: string; overlayText: string } | null>(null);
  const [regen, setRegen] = useState<{ id: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  if (!v) return error ? <div className="ak-wrap ak-section"><Banner tone="risk">{error}</Banner></div> : <Loading />;
  if (PRODUCING.includes(v.project.state) || v.project.state === 'COMPLETE') {
    if (typeof window !== 'undefined') window.location.replace(v.project.state === 'COMPLETE' ? `/deliver/${projectId}` : `/produce/${projectId}`);
    return <Loading />;
  }
  const sb = v.storyboard;
  const q = v.quote;
  const taste = q.kind === 'taste' && q.status === 'active' && !expired;
  // Reopened after the claims check blocked a line: already paid for, so finishing needs no checkout (surf-35).
  const resumable = v.project.resumable;

  async function call(url: string, body: unknown) {
    setErr(null);
    setBusy(true);
    try {
      await api(url, body);
      refresh();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell step={3} title={sb?.hook ? `“${sb.hook}”` : 'Building your storyboard'} sub={sb?.status === 'generating' ? 'Drawing each scene with your real product. About a minute.' : '15 seconds, scene by scene. Edit any line for free — every change is checked against cosmetic claim rules.'}>
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {resumable && v.project.blockedLines.length ? (
        <Banner tone="warn">
          Change {v.project.blockedLines.length === 1 ? 'this line' : 'these lines'}, then finish your ad:{' '}
          {v.project.blockedLines.map((l, i) => (
            <span key={l.line}>{i ? '; ' : ''}“{l.line}”{l.scene ? ` (scene ${l.scene})` : ''}{l.alternative ? ` — try “${l.alternative}”` : ''}</span>
          ))}
        </Banner>
      ) : null}
      {!sb || sb.status === 'generating' ? <Ledger steps={sb?.steps ?? []} /> : null}
      {sb && sb.scenes.length ? (
        <div className="ak-scroll-row" role="list">
          {sb.scenes.map((s) => (
            <figure key={s.id} className="ak-frame" role="listitem" data-locked={s.locked}>
              <div className="ak-well ak-well--916">{s.frameUrl ? <img src={s.frameUrl} alt={`Scene ${s.position + 1}: ${s.visualPlan}`} /> : <div className="ak-stone" style={{ height: '100%' }} aria-hidden />}</div>
              <figcaption className="ak-small">
                <div className="ak-between"><span className="ak-index">{String(s.position + 1).padStart(2, '0')} · {PURPOSE[s.purpose] ?? s.purpose}</span><span className="ak-index">{(s.durationMs / 1000).toFixed(1)}s</span></div>
                {s.overlayText ? <p style={{ fontWeight: 600 }}>{s.overlayText}</p> : null}
                {s.spokenLine ? <p className="ak-muted">“{s.spokenLine}”</p> : null}
                {s.regeneration?.status === 'pending' || s.regeneration?.status === 'active' ? <p className="ak-small ak-muted" role="status">Redrawing this frame…</p> : null}
                {s.regeneration?.status === 'failed' ? <p className="ak-small ak-error" role="status">{s.regeneration.detail ?? 'We couldn’t redraw this frame.'}</p> : null}
                <div className="ak-row">
                  <button className="ak-textbtn" disabled={s.locked} onClick={() => setEdit({ id: s.id, spokenLine: s.spokenLine ?? '', overlayText: s.overlayText ?? '' })}>Edit words</button>
                  <button className="ak-textbtn" disabled={s.locked || s.regeneration?.status === 'pending' || s.regeneration?.status === 'active'} onClick={() => setRegen({ id: s.id, text: '' })}>Change picture</button>
                  <button className="ak-textbtn" onClick={() => call(`/api/scenes/${s.id}/lock`, { projectId, locked: !s.locked })}>{s.locked ? 'Unlock' : 'Lock'}</button>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {sb && sb.status !== 'generating' && resumable ? (
        <section className="ak-panel" style={{ marginTop: 40 }} id="finish">
          <h2 className="ak-label">Finish your ad</h2>
          <p className="ak-small ak-muted">You’ve already paid for this ad, so there’s nothing more to pay. We check your changes, then produce it — scenes that were already made are reused.</p>
          <Button block disabled={busy} onClick={async () => { if (await call(`/api/projects/${projectId}/finish`, {})) window.location.assign(`/produce/${projectId}`); }}>Finish my ad</Button>
          <div style={{ marginTop: 12 }}><CancelProduction projectId={projectId} v={v} onChange={() => window.location.assign(`/produce/${projectId}`)} /></div>
        </section>
      ) : null}
      {sb && sb.status !== 'generating' && !resumable ? (
        <section className="ak-panel" style={{ marginTop: 40 }} id="offer">
          <div className="ak-between" style={{ alignItems: 'start', flexWrap: 'wrap', gap: 24 }}>
            <div>
              <h2 className="ak-label">Make this ad</h2>
              <p className="ak-price">
                {usd(q.priceMicros)}
                {taste && q.referencePriceMicros ? <span className="ak-strike ak-muted" style={{ marginLeft: 12, fontSize: '0.5em' }}>{usd(q.referencePriceMicros)}</span> : null}
              </p>
              <p className="ak-small ak-muted">{taste ? 'Intro price for your first ad. One-time — no subscription.' : 'One-time — no subscription.'}</p>
              {taste && q.expiresAt ? <OfferExpiry expiresAt={q.expiresAt} serverNow={v.serverNow} onExpire={() => { setExpired(true); refresh(); }} /> : null}
            </div>
            <ul className="ak-small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>One finished 15-second ad with voiceover and captions</li>
              <li>Exports for TikTok, Reels (9:16), Feed (4:5) and Square</li>
              <li>Your real packaging, checked scene by scene</li>
              <li>Every claim checked against FDA cosmetic rules</li>
              <li>If we can’t deliver an ad that passes our quality checks, you’re refunded automatically</li>
            </ul>
          </div>
          <div style={{ marginTop: 24 }}>
            <LinkButton href={`/checkout/${projectId}`} block id="cta">Make my ad · {usd(q.priceMicros)}</LinkButton>
            <p className="ak-small ak-muted" style={{ textAlign: 'center' }}>Ready in about 10 minutes. Secure checkout by Stripe.</p>
          </div>
        </section>
      ) : null}
      {sb && sb.status !== 'generating' && !resumable ? (
        <StickyCta watchId="cta" mobileOnly>
          <LinkButton href={`/checkout/${projectId}`} block>Make my ad · {usd(q.priceMicros)}</LinkButton>
        </StickyCta>
      ) : null}

      <Sheet open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title="Edit this scene’s words" description="Free. We’ll flag anything a cosmetic can’t claim and suggest a compliant alternative.">
        {edit ? (
          <form className="ak-stack" onSubmit={async (e) => { e.preventDefault(); if (await call(`/api/scenes/${edit.id}/edit`, { projectId, spokenLine: edit.spokenLine || null, overlayText: edit.overlayText || null })) setEdit(null); }}>
            <label className="ak-field"><span className="ak-label">Spoken line</span><textarea className="ak-textarea" maxLength={160} value={edit.spokenLine} onChange={(e) => setEdit({ ...edit, spokenLine: e.target.value })} /></label>
            <label className="ak-field"><span className="ak-label">On-screen text</span><input className="ak-input" maxLength={70} value={edit.overlayText} onChange={(e) => setEdit({ ...edit, overlayText: e.target.value })} /></label>
            {err ? <p className="ak-error" role="alert">{err}</p> : null}
            <Button type="submit" disabled={busy}>Save</Button>
          </form>
        ) : null}
      </Sheet>
      <Sheet open={!!regen} onOpenChange={(o) => !o && setRegen(null)} title="Change this picture" description="Describe what to change. Your product stays exactly as it is.">
        {regen ? (
          <form className="ak-stack" onSubmit={async (e) => { e.preventDefault(); if (await call(`/api/scenes/${regen.id}/regenerate`, { projectId, instruction: regen.text })) { setRegen(null); resume(); } }}>
            <label className="ak-field">
              <span className="ak-label">What to change</span>
              <textarea className="ak-textarea" maxLength={200} placeholder="e.g. warmer morning light, marble counter" value={regen.text} onChange={(e) => setRegen({ ...regen, text: e.target.value })} />
            </label>
            {err ? <p className="ak-error" role="alert">{err}</p> : null}
            <Button type="submit" disabled={busy || !regen.text.trim()}>{busy ? 'Sending…' : 'Redraw'}</Button>
          </form>
        ) : null}
      </Sheet>
    </Shell>
  );
}

/* ───────────── P8 · Checkout ───────────── */

export function CheckoutFlow({ projectId, publishableKey }: { projectId: string; publishableKey: string | null }) {
  const [state, setState] = useState<{ clientSecret: string | null; url: string | null; quote: { priceMicros: number } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [Embedded, setEmbedded] = useState<React.ComponentType<{ clientSecret: string; pk: string }> | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ clientSecret: string | null; url: string | null; quote: { priceMicros: number } }>(`/api/projects/${projectId}/checkout`, {})
      .then(async (r) => {
        if (!alive) return;
        if (!publishableKey || !r.clientSecret || r.clientSecret.startsWith('mock_')) {
          if (r.url) window.location.assign(r.url);
          return;
        }
        const mod = await import('./stripe-embedded');
        setEmbedded(() => mod.StripeEmbedded);
        setState(r);
      })
      .catch((e) => {
        if ((e as { details?: { needsAccount?: boolean } }).details?.needsAccount) window.location.assign(`/login?next=${encodeURIComponent(`/checkout/${projectId}`)}`);
        else if ((e as { status?: number }).status === 409 && /already/i.test((e as Error).message)) window.location.assign(`/produce/${projectId}`);
        else setErr((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [projectId, publishableKey]);
  return (
    <Shell step={4} title="Checkout" sub="One-time payment. No subscription is created.">
      {err ? (
        <>
          <Banner tone="risk">{err}</Banner>
          <LinkButton variant="secondary" href={`/storyboard/${projectId}`}>Back to storyboard</LinkButton>
        </>
      ) : Embedded && state?.clientSecret && publishableKey ? (
        <Embedded clientSecret={state.clientSecret} pk={publishableKey} />
      ) : (
        <p className="ak-muted">Opening secure checkout…</p>
      )}
    </Shell>
  );
}

/* ───────────── P9 · Production ───────────── */

export function ProduceFlow({ projectId }: { projectId: string }) {
  // A production paused by a provider outage resumes by itself, so keep polling it.
  const active = useCallback((v: View | null) => !v || v.project.paused || (v.project.state !== 'COMPLETE' && !STOPPED.includes(v.project.state)), []);
  const { data: v, error, resume } = useProject(projectId, active);
  useEffect(() => {
    if (v?.project.state === 'COMPLETE') window.location.replace(`/deliver/${projectId}`);
  }, [v?.project.state, projectId]);
  if (!v) return error ? <div className="ak-wrap ak-section"><Banner tone="risk">{error}</Banner></div> : <Loading />;
  const waitingPayment = v.project.state === 'STORYBOARD_READY' && !v.project.resumable;
  const paused = v.project.paused;
  const stopped = !paused && STOPPED.includes(v.project.state);
  const title = v.project.state === 'BLOCKED_COMPLIANCE' ? 'One line needs changing' : v.project.state === 'CANCELLED' ? 'This ad was cancelled' : stopped ? 'We couldn’t finish this ad' : paused ? 'Your ad is queued' : waitingPayment ? 'Confirming your payment' : 'Making your ad';
  return (
    <Shell step={4} title={title} sub={stopped ? undefined : 'Usually about 10 minutes. We’ll email you when it’s ready — you can close this tab.'}>
      {waitingPayment ? <p className="ak-muted">Waiting for confirmation from Stripe… this usually takes a few seconds.</p> : null}
      {v.project.resumable ? (
        <div className="ak-stack">
          <p>Your storyboard is open for the change. You won’t be charged again.</p>
          <LinkButton href={`/storyboard/${projectId}`}>Back to the storyboard</LinkButton>
        </div>
      ) : null}
      {paused ? <QueuedBanner v={v} /> : null}
      {stopped ? (
        <ProductionIssue projectId={projectId} v={v} onChange={resume} />
      ) : v.project.resumable || waitingPayment ? null : (
        <>
          <Ledger steps={v.productionSteps} />
          <Liveness live={v.project.liveness} />
        </>
      )}
      <div style={{ marginTop: 24 }}><CancelProduction projectId={projectId} v={v} onChange={resume} /></div>
    </Shell>
  );
}

/**
 * Cancel a production (standard §38 "cancel semantics depend on dispatch state"): the sheet says what happens to
 * the Creative Test or payment right now — before dispatch it all comes back — before the customer confirms.
 */
export function CancelProduction({ projectId, v, onChange }: { projectId: string; v: Pick<ProjectView, 'project'>; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (v.project.cancelling) return <p className="ak-small ak-muted" role="status">Cancelling — we’ll stop at the next step.</p>;
  const c = v.project.cancel;
  if (!c) return null;
  return (
    <>
      <button className="ak-textbtn" onClick={() => setOpen(true)}>Cancel this ad</button>
      <Sheet open={open} onOpenChange={setOpen} title="Cancel this ad?" description={c.message}>
        <form
          className="ak-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            setBusy(true);
            try {
              await api(`/api/projects/${projectId}/cancel`, { reason: reason.trim() || undefined });
              setOpen(false);
              onChange();
            } catch (x) {
              setErr((x as Error).message);
            }
            setBusy(false);
          }}
        >
          <label className="ak-field">
            <span className="ak-label">Why are you cancelling? (optional)</span>
            <textarea className="ak-textarea" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {err ? <p className="ak-error" role="alert">{err}</p> : null}
          <Button type="submit" variant="secondary" disabled={busy}>{busy ? 'Cancelling…' : 'Cancel the ad'}</Button>
        </form>
      </Sheet>
    </>
  );
}

/** Project states in which production has stopped and waits for the customer (or has ended). */
const STOPPED = ['PROVIDER_FAILED', 'REFUNDED', 'BLOCKED_COMPLIANCE', 'NEEDS_USER_ACTION', 'CANCELLED'];
/** Has this production stopped (not merely queued behind a busy partner)? */
export const productionStopped = (v: Pick<ProjectView, 'project'>) => !v.project.paused && STOPPED.includes(v.project.state);

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Plan 03 P9: "Queued: our video partner is busy. Your place is held." plus an ETA if known. */
export function QueuedBanner({ v }: { v: Pick<ProjectView, 'project'> }) {
  const q = v.project.queue;
  const eta = q?.etaAt ? (q.etaKind === 'reopen' ? `Expected back around ${clock(q.etaAt)}.` : `We’ll try again around ${clock(q.etaAt)}.`) : null;
  return (
    <Banner tone="warn">
      {v.project.failureReason ?? 'Queued: a production partner is busy. Your place is held.'}
      {eta ? <> {eta}</> : null} You won’t be charged twice.
    </Banner>
  );
}

/**
 * Why production stopped, and the way forward (plan 03 P9 "reassure"; standard §14): fix a blocked line in the
 * storyboard (no new payment), try again, or — for money — what happens to it. Copy is honest about the credit:
 * a paid one-off is never charged again; a returned Creative Test is back on the balance.
 */
export function ProductionIssue({ projectId, v, onChange }: { projectId: string; v: Pick<ProjectView, 'project' | 'purchase'>; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const st = v.project.state;
  const paid = v.purchase?.status === 'paid';
  const subscriber = v.project.kind === 'creative_test';
  async function act(action: 'reopen' | 'retry') {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ next?: string }>(`/api/projects/${projectId}/${action}`, {});
      if (r?.next) window.location.assign(r.next);
      else onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }
  if (st === 'BLOCKED_COMPLIANCE') {
    return (
      <div className="ak-stack">
        <Banner tone="warn">{v.project.failureReason ?? 'A line needs changing before we can finish your ad.'}</Banner>
        {v.project.blockedLines.length ? (
          <ul className="ak-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {v.project.blockedLines.map((l) => (
              <li key={l.line} className="ak-panel ak-stack" style={{ gap: 4 }}>
                <p style={{ margin: 0 }}><strong>“{l.line}”</strong>{l.scene ? <span className="ak-index"> · scene {l.scene}</span> : null}</p>
                <p className="ak-small ak-muted" style={{ margin: 0 }}>{l.reason}{l.platforms.length ? ` (${l.platforms.join(', ')})` : ''}</p>
                {l.alternative ? <p className="ak-small" style={{ margin: 0 }}>Try instead: “{l.alternative}”</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <p>{paid ? 'You won’t be charged again — fix the line and we’ll finish it.' : subscriber ? 'Your Creative Test is back on your balance until you finish — fix the line and we’ll finish it.' : 'Fix the line and we’ll finish it.'}</p>
        <div><Button disabled={busy} onClick={() => void act('reopen')}>Edit the line</Button></div>
        {err ? <p className="ak-error" role="alert">{err}</p> : null}
      </div>
    );
  }
  const canRetry = (st === 'PROVIDER_FAILED' && !paid) || st === 'NEEDS_USER_ACTION';
  return (
    <div className="ak-stack">
      <Banner tone="risk">{v.project.failureReason ?? (st === 'CANCELLED' ? 'This ad was cancelled.' : 'Something went wrong while producing your ad.')}</Banner>
      {st === 'REFUNDED' ? (
        <p>Your payment has been refunded in full. It can take 5–10 days to appear on your statement.</p>
      ) : paid && st === 'PROVIDER_FAILED' ? (
        <p>Your payment is being refunded automatically.</p>
      ) : st === 'NEEDS_USER_ACTION' ? null : st === 'CANCELLED' ? (
        <p>{subscriber ? 'Any Creative Test that wasn’t used is back on your balance.' : 'Nothing more will be charged for this ad.'}</p>
      ) : (
        <p>{subscriber ? 'You haven’t lost anything — your Creative Test was returned.' : 'You haven’t been charged for this attempt.'}</p>
      )}
      {canRetry ? <div><Button disabled={busy} onClick={() => void act('retry')}>Try again</Button></div> : null}
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
    </div>
  );
}

/** "Still working" vs "stalled", from the production run's heartbeat (standard §39). */
export function Liveness({ live }: { live: View['project']['liveness'] }) {
  if (live.state === 'stalled') {
    return <Banner tone="warn">This is taking longer than it should. We’re checking on it — nothing is lost, and you won’t be charged twice.</Banner>;
  }
  if (live.state === 'working' && live.heartbeatAgeMs != null) {
    const s = Math.round(live.heartbeatAgeMs / 1000);
    return <p className="ak-small ak-muted" aria-live="off">Still working · last update {s < 5 ? 'just now' : `${s}s ago`}</p>;
  }
  return null;
}

/* ───────────── P10 · Delivery ───────────── */

/**
 * Standard §40: AI-generated talent and synthetic media follow each platform's disclosure rules. Shown with the
 * downloads, so the label goes on when the ad is posted — and generated people are never passed off as customers.
 */
export function AiDisclosureSteps({ disclosure }: { disclosure: ProjectView['disclosure'] }) {
  if (!disclosure?.aiGenerated) return null;
  const what = [disclosure.syntheticPeople ? 'people' : null, 'scenes', disclosure.syntheticVoice ? 'voice-over' : null].filter(Boolean).join(', ');
  return (
    <section className="ak-panel ak-stack" style={{ gap: 6 }} aria-labelledby="ai-disclosure">
      <h2 className="ak-label" id="ai-disclosure">Before you post: label it as AI-generated</h2>
      <p className="ak-small" style={{ margin: 0 }}>This ad includes AI-generated {what}. The files say so in their metadata; the platforms also ask you to disclose it.</p>
      <ul className="ak-small" style={{ margin: 0, paddingLeft: 18 }}>
        <li><strong>TikTok:</strong> turn on the “AI-generated content” setting when you post, and use the AI-generated content disclosure when you set the ad up in TikTok Ads Manager.</li>
        <li><strong>Instagram and Facebook:</strong> keep the “AI info” label if Meta adds one, and answer the AI disclosure question in Meta Ads Manager when it’s asked.</li>
        {disclosure.syntheticPeople ? <li>The people in this ad are AI-generated. Don’t present them as real customers or say they used the product.</li> : null}
      </ul>
    </section>
  );
}

/** P10 "Watch" (standard §7): the finished ad counts as watched once it has played for 3 seconds or to the end. */
function WatchedVideo({ projectId, assetId, src }: { projectId: string; assetId: string; src: string }) {
  const sent = useRef(false);
  const report = (seconds: number) => {
    if (sent.current) return;
    sent.current = true;
    fetch(`/api/projects/${projectId}/watched`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId, seconds: Number.isFinite(seconds) ? Math.round(seconds) : 0 }) }).catch(() => {});
  };
  return (
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      onTimeUpdate={(e) => {
        if (e.currentTarget.currentTime >= 3) report(e.currentTarget.currentTime);
      }}
      onEnded={(e) => report(e.currentTarget.duration || e.currentTarget.currentTime)}
    />
  );
}

const ASPECT: Record<string, string> = { '9x16': 'TikTok · Reels · Stories (9:16)', '4x5': 'Feed (4:5)', '1x1': 'Square (1:1)' };

export function DeliverFlow({ projectId }: { projectId: string }) {
  const { data: v, error } = useProject(projectId, useCallback(() => false, []));
  if (!v) return error ? <div className="ak-wrap ak-section"><Banner tone="risk">{error}</Banner></div> : <Loading />;
  if (v.project.state !== 'COMPLETE') {
    if (typeof window !== 'undefined') window.location.replace(`/produce/${projectId}`);
    return <Loading />;
  }
  const primary = v.exports[0];
  const slug = v.access.workspaceSlug;
  const qa = v.project.qa;
  return (
    <Shell step={4} title="Your ad is ready" sub={`${v.sku.name} · 15 seconds · checked for product accuracy and claims.`}>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <div className="ak-well ak-well--916">{primary ? <WatchedVideo projectId={projectId} assetId={primary.assetId} src={primary.url} /> : null}</div>
        <div className="ak-stack">
          <h2 className="ak-label">Download</h2>
          {v.exports.map((e) => (
            <a key={e.assetId} className="ak-index-row" href={e.download} download>
              <span>{ASPECT[e.aspect] ?? e.aspect}</span>
              <span className="ak-index">MP4 ↓</span>
            </a>
          ))}
          {qa.length ? (
            <details>
              <summary className="ak-small">What we checked</summary>
              <ul className="ak-small">{qa.map((c) => <li key={c.label}>{c.label} {c.ok ? '✓' : '•'}</li>)}</ul>
            </details>
          ) : null}
          <AiDisclosureSteps disclosure={v.disclosure} />
          <hr className="ak-rule" />
          <h2 className="ak-label">What to do next</h2>
          <ol className="ak-small">
            <li>Upload the 9:16 file to TikTok or Reels as a new ad.</li>
            <li>Run it for 5–7 days alongside your current best ad.</li>
            <li>Connect your ad account and we’ll tell you what it taught you.</li>
          </ol>
          {slug ? <LinkButton href={`/w/${slug}/this-week`} variant="secondary">Go to your archive</LinkButton> : null}
          <LinkButton href="/app/plan">Test 3 ideas a month · see plans</LinkButton>
        </div>
      </div>
    </Shell>
  );
}
