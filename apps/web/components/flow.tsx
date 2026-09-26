'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, ClaimChip, Field, Input, LinkButton, LockButton, MetadataTable, Rail, SpecimenCard } from '@arkiv/ui';
import { api, LiveLedger, OfferExpiry, ProvenanceChip, Sheet, StickyCta, usePoll } from '@arkiv/ui/client';
import { formatDate, formatTime } from '@arkiv/shared/format';
import { MAGIC_LINK_TTL_MIN } from '@arkiv/shared/auth';
import { EmailLinkForm } from './email-link';
import { registerPasskey } from './profile';
import { projectRoute } from '@/lib/project-route';
import type { ProjectView } from '@/lib/views';
import { awaitingPayment, conceptCost, disputeChoices, tapBox, tensionSourceWords } from '@/lib/flow-helpers';
import type { CreativeGoal } from '@arkiv/shared';

type View = ProjectView & { access: { provisional: boolean; signedIn: boolean; role: string; workspaceSlug: string | null; passkeyPrompt?: boolean } };

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(micros % 1_000_000 === 0 ? 0 : 2)}`;
/** Below this photo-quality confidence the P4 screen offers an extra view (plan 03 P4, "only if fidelity confidence is low"). */
const LOW_FIDELITY = 0.6;
const PRODUCING = ['STORYBOARD_APPROVED', 'RENDER_RESERVED', 'RENDERING', 'QA_RUNNING', 'COMPOSING', 'PLATFORM_VARIANTS', 'FINAL_QA'];

/**
 * The project view, live while `active` says so: server-sent events from /api/projects/:id/stream (plan 06 Phase 1
 * #9), falling back to polling GET /api/projects/:id when the stream can't be used (no EventSource, a proxy that
 * buffers, repeated failures). `refresh` re-reads at once (after the merchant changes something).
 */
function useProject(id: string, active: (v: View | null) => boolean) {
  const [live, setLive] = useState(true);
  const [streaming, setStreaming] = useState(true);
  const [data, setData] = useState<View | null>(null);
  // One read on mount and on refresh(); polls on its own only while the stream is off.
  const poll = usePoll<View>(`/api/projects/${id}`, 1500, live && !streaming);
  useEffect(() => {
    if (poll.data) setData(poll.data);
  }, [poll.data]);
  useEffect(() => {
    if (!live || !streaming) return;
    if (typeof EventSource === 'undefined') {
      setStreaming(false);
      return;
    }
    let failures = 0;
    const es = new EventSource(`/api/projects/${id}/stream`);
    es.addEventListener('project', (e) => {
      failures = 0;
      setData(JSON.parse((e as MessageEvent<string>).data) as View);
    });
    const fallBack = () => {
      es.close();
      setStreaming(false);
    };
    es.addEventListener('failure', fallBack);
    es.addEventListener('gone', fallBack);
    es.onerror = () => {
      // The browser retries on its own; three failures in a row (or a closed stream) and we poll instead.
      if (++failures >= 3 || es.readyState === EventSource.CLOSED) fallBack();
    };
    return () => es.close();
  }, [id, live, streaming]);
  useEffect(() => {
    if (data) setLive(active(data));
  }, [data, active]);
  return { data, error: data ? null : poll.error, refresh: poll.refresh, resume: () => setLive(true) };
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

/**
 * A project view that can't load. When the preview was saved to an account from another device (plan 03 P6), this
 * browser's preview cookie no longer opens it: say so and offer to log in, rather than a bare error.
 */
function PreviewUnavailable({ projectId, error }: { projectId: string; error: string }) {
  const saved = /saved to an account/i.test(error);
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 520 }}>
      {saved ? <h1 className="ak-h1">This preview was saved to an account</h1> : null}
      <Banner tone={saved ? undefined : 'risk'}>{error}</Banner>
      {saved ? <p style={{ marginTop: 16 }}><LinkButton href={`/login?next=${encodeURIComponent(`/concepts/${projectId}`)}`}>Log in to continue</LinkButton></p> : null}
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

/**
 * P3/P4 rows, in the plan's order (name, size, price, category, key ingredients, INCI, texture/format). The key
 * ingredients the ideas are built on and the full INCI list are separate facts; each is shown and correctable
 * (a correction of either reaches the Creative Director, x-contracts-03).
 */
const FACT_LABELS: Record<string, string> = { name: 'Name', brand: 'Brand', size: 'Size', price: 'Price', compare_at_price: 'Compare-at', category: 'Category', key_ingredients: 'Key ingredients', ingredients: 'Ingredients (INCI)', texture: 'Texture', format: 'Format', sku_code: 'SKU', gtin: 'GTIN' };
const EDITABLE = new Set(['name', 'brand', 'size', 'price', 'category', 'texture', 'key_ingredients', 'ingredients']);
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

/** How clearly the photos show the product, in words (the analyst's fidelity confidence, 0–1). */
const photoQuality = (c: number) =>
  c >= 0.8 ? 'Good — we can match your packaging closely.' : c >= LOW_FIDELITY ? 'Fair — clear enough to match your packaging.' : 'Low — the product may look less exact in generated scenes.';

/** Views the analyst may suggest, in customer words. */
const VIEW_WORDS: Record<string, string> = { front: 'the front', side: 'a side view', back: 'the back label', swatch: 'a swatch of the product', closure: 'the cap or pump', in_hand: 'the product in hand' };

/**
 * Add photos to this same product (§13: keep the entered URL, ask for images without a restart; P4 "Add a
 * side/back photo for sharper product accuracy"). Up to 6 at a time; the server decides whether they resume the
 * analysis or become extra reference views.
 */
function PhotoAdder({ projectId, title, why, cta, onAdded }: { projectId: string; title: string; why: string; cta: string; onAdded: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  function pick(list: FileList | null) {
    if (!list) return;
    const imgs = [...list].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (!imgs.length) return setErr('Choose a photo (JPG or PNG).');
    setErr(null);
    setFiles((prev) => [...prev, ...imgs].slice(0, 6));
  }
  async function send() {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('photos', f);
      await api(`/api/projects/${projectId}/photos`, fd);
      setFiles([]);
      setDone(true);
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }
  if (done) return <p className="ak-small ak-muted" role="status">Thanks — we’ve added your photos.</p>;
  return (
    <div className="ak-panel ak-stack">
      <h2 className="ak-label">{title}</h2>
      <p className="ak-small ak-muted" style={{ margin: 0 }}>{why}</p>
      <div className="ak-row" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="ak-btn ak-btn--secondary ak-btn--sm" onClick={() => ref.current?.click()}>Choose photos</button>
        <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" multiple hidden onChange={(e) => pick(e.target.files)} />
        {files.map((f, i) => (
          <span key={i} className="ak-chip">{f.name.slice(0, 18)} <button type="button" className="ak-textbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>
        ))}
      </div>
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
      <div><Button size="sm" disabled={!files.length || busy} onClick={() => void send()}>{busy ? 'Adding…' : cta}</Button></div>
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

/**
 * Plan 03 P2 "Photo shows several products → tap-to-select the hero product": tap the product (a box is placed
 * around the tap) or drag a box around it; the analysis carries on from that crop.
 */
function HeroPicker({ projectId, photoUrl, onPicked }: { projectId: string; photoUrl: string; onPicked: () => void }) {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  async function use() {
    if (!box) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/select-product`, box);
      onPicked();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="ak-panel ak-stack">
      <h2 className="ak-label">Which product is this ad for?</h2>
      <p className="ak-small ak-muted" style={{ margin: 0 }}>Your photo shows more than one product. Tap it, or drag a box around it.</p>
      <div
        style={{ position: 'relative', touchAction: 'none', userSelect: 'none', cursor: 'crosshair' }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = at(e);
          setBox(null);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const p = at(e);
          const s0 = start.current;
          setBox({ x: Math.min(s0.x, p.x), y: Math.min(s0.y, p.y), w: Math.abs(p.x - s0.x), h: Math.abs(p.y - s0.y) });
        }}
        onPointerUp={(e) => {
          const s0 = start.current;
          start.current = null;
          if (!s0) return;
          const p = at(e);
          // A tap (no drag): a box around the tapped point, a third of the photo each way.
          if (Math.abs(p.x - s0.x) < 0.03 && Math.abs(p.y - s0.y) < 0.03) setBox(tapBox(s0));
        }}
      >
        <img src={photoUrl} alt="Your product photo" style={{ display: 'block', width: '100%', height: 'auto' }} draggable={false} />
        {box ? <div aria-hidden style={{ position: 'absolute', left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`, border: '2px solid var(--ink)', boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)' }} /> : null}
      </div>
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
      <div><Button disabled={!box || box.w < 0.05 || box.h < 0.05 || busy} onClick={() => void use()}>{busy ? 'Carrying on…' : 'This one — carry on'}</Button></div>
    </div>
  );
}

/** Plan 03 P2 "URL is a collection page or home page → 'Which product?' picker from parsed products." */
function ProductChooser({ projectId, choices, onChosen }: { projectId: string; choices: { name: string; url: string }[]; onChosen: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function choose(url: string) {
    setBusy(url);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/choose-product`, { url });
      onChosen();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }
  return (
    <div className="ak-panel ak-stack">
      <h2 className="ak-label">Which product?</h2>
      <p className="ak-small ak-muted" style={{ margin: 0 }}>That page lists several products. Choose the one this ad is for — nothing has been charged.</p>
      <ul className="ak-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {choices.map((c) => (
          <li key={c.url} className="ak-between" style={{ gap: 12 }}>
            <span style={{ overflowWrap: 'anywhere' }}>{c.name}</span>
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void choose(c.url)}>{busy === c.url ? 'Reading…' : 'This one'}</Button>
          </li>
        ))}
      </ul>
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
    </div>
  );
}

/** §42 Duplicate import: "This looks like No. 003 — update it or add as new?" */
function DuplicateChoice({ projectId, dup, onKept }: { projectId: string; dup: { catalogueNo: number; name: string; blocking: boolean }; onKept: () => void }) {
  const [busy, setBusy] = useState<'merge' | 'keep' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [merged, setMerged] = useState(false);
  async function decide(choice: 'merge' | 'keep') {
    setBusy(choice);
    setErr(null);
    try {
      const r = await api<{ next?: string | null }>(`/api/projects/${projectId}/duplicate`, { choice });
      if (choice === 'merge') {
        if (r.next) window.location.assign(r.next);
        else setMerged(true);
        return;
      }
      onKept();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
  }
  const no = `No. ${String(dup.catalogueNo).padStart(3, '0')}`;
  if (merged) return <p role="status" className="ak-body">Added to {no} ({dup.name}). Its facts, photos and claims now include what we found here.</p>;
  return (
    <div className="ak-panel ak-stack">
      <h2 className="ak-label">Is this {no}?</h2>
      <p className="ak-small ak-muted" style={{ margin: 0 }}>
        This looks like {no} ({dup.name}), already in your catalogue. Update that product with what we found here, or keep this as a separate product.
      </p>
      <div className="ak-row">
        <Button size="sm" disabled={!!busy} onClick={() => void decide('merge')}>{busy === 'merge' ? 'Updating…' : `Update ${no}`}</Button>
        <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void decide('keep')}>{busy === 'keep' ? 'Saving…' : dup.blocking ? 'Add as new and carry on' : 'Keep as new'}</Button>
      </div>
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
    </div>
  );
}

/** Plan 03 P2: an out-of-scope product gets a waitlist email instead (no generation spend). */
function WaitlistForm({ projectId }: { projectId: string }) {
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [err, setErr] = useState<string | null>(null);
  if (state === 'done') return <p role="status" className="ak-body">Thanks — we’ll email {email} if we start supporting products like this. Nothing else.</p>;
  return (
    <form
      className="ak-panel ak-stack"
      style={{ maxWidth: 480 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setState('busy');
        setErr(null);
        try {
          await api('/api/waitlist', { projectId, email, consent });
          setState('done');
        } catch (x) {
          setErr((x as Error).message);
          setState('idle');
        }
      }}
    >
      <label className="ak-label" htmlFor="waitlist-email">Tell me when you support this</label>
      <input id="waitlist-email" className="ak-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <label className="ak-small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
        <span>Email me once if Arkiv starts making ads for products like this. You can unsubscribe anytime.</span>
      </label>
      {err ? <p className="ak-error" role="alert">{err}</p> : null}
      <div><Button size="sm" type="submit" disabled={state === 'busy' || !email || !consent}>{state === 'busy' ? 'Saving…' : 'Join the waitlist'}</Button></div>
    </form>
  );
}

/**
 * M2: which catalogued facts just arrived. Driven by the real server updates (each stream/poll result), not a
 * timer — the facts already on screen when the page opens are not replayed, and each new batch animates once.
 */
function useNewFactKeys(keys: string[] | null): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const sig = keys ? keys.join('\n') : null;
  useEffect(() => {
    if (sig === null) return;
    const now = sig ? sig.split('\n') : [];
    if (!seen.current) {
      seen.current = new Set(now);
      return;
    }
    const added = now.filter((k) => !seen.current!.has(k));
    if (!added.length) return;
    for (const k of added) seen.current.add(k);
    setFresh(new Set(added));
  }, [sig]);
  // Rows rendered before the effect records them are new already (so they never flash in unanimated).
  if (!keys || !seen.current) return fresh;
  const unseen = keys.filter((k) => !seen.current!.has(k));
  return unseen.length ? new Set([...fresh, ...unseen]) : fresh;
}

export function AnalysisFlow({ projectId }: { projectId: string }) {
  const active = useCallback((v: View | null) => !v || v.sku.status === 'analyzing' || (v.sku.status === 'active' && v.concepts.length === 0 && v.project.state !== 'NEEDS_USER_ACTION'), []);
  const { data: v, error, refresh, resume } = useProject(projectId, active);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const newKeys = useNewFactKeys(v ? v.facts.filter((f) => FACT_LABELS[f.key]).map((f) => f.key) : null);
  const [cutoutShown, setCutoutShown] = useState(false);
  if (!v) return error ? <div className="ak-wrap ak-section"><Banner tone="risk">{error}</Banner></div> : <Loading />;

  if (v.sku.status === 'rejected') {
    return (
      <Shell step={1} title="We can’t make an ad for this product" sub={v.sku.rejectReason ?? 'This product is outside what Arkiv supports.'}>
        <p className="ak-muted">Arkiv is built for cosmetic skincare only — cleansers, serums, moisturisers and similar, not sunscreen/SPF or acne and other OTC treatments. You haven’t been charged anything.</p>
        <WaitlistForm projectId={projectId} />
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
  const conceptsDrafting = !ready && !failed && v.project.state !== 'NEEDS_USER_ACTION' && (v.steps.some((st) => st.key === 'concepts' && st.status === 'active') || (!analyzing && v.sku.status === 'active'));
  // "Looks right" confirms what the merchant was shown (§13, §16 merchant_confirmed), then moves on. A failed
  // confirmation never blocks the ideas: the facts stay as observed.
  async function confirmAndGo() {
    const shown = v!.facts.filter((f) => FACT_LABELS[f.key] && !f.disputed && !f.confirmed).map((f) => f.id);
    if (shown.length) await api(`/api/projects/${projectId}/confirm`, { factIds: shown }).catch(() => {});
    window.location.assign(`/concepts/${projectId}`);
  }
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
        {/* M3: the cut-out is placed onto the paper well with a clip reveal from the bottom, once it has loaded. */}
        <SpecimenCard
          index={`No. ${String(v.sku.catalogueNo).padStart(3, '0')}`}
          title={analyzing ? undefined : v.sku.name}
          meta={v.sku.packaging?.type ? [['Packaging', String(v.sku.packaging.type)]] : []}
          image={v.sku.cutoutUrl ? { src: v.sku.cutoutUrl, alt: `${v.sku.name} product photo` } : null}
          imageClassName={cutoutShown ? 'ak-reveal-up' : 'ak-reveal-wait'}
          onImageLoad={() => setCutoutShown(true)}
        />
        <div className="ak-stack">
          <LiveLedger steps={v.steps} />
          {!analyzing && disputed.length ? <Banner tone="warn">Your page and photos disagree on {disputed.map((d) => FACT_LABELS[d.key] ?? d.key).join(', ')}. Tell us which is right.</Banner> : null}
          {!analyzing && v.facts.some((f) => f.sourceConflict?.newer) ? <Banner tone="warn">Your store changed {v.facts.filter((f) => f.sourceConflict?.newer).map((d) => FACT_LABELS[d.key] ?? d.key).join(', ')} since you corrected it. Keep yours, or use the store’s value.</Banner> : null}
          {/* M2: facts appear as each one is extracted (real server updates), numbered, while the analysis runs. */}
          <MetadataTable
            indexed
            newKeys={newKeys}
            rows={v.facts
              .filter((f) => FACT_LABELS[f.key])
              .map((f) => ({
                key: f.key,
                label: FACT_LABELS[f.key]!,
                value:
                  editing === f.key ? (
                    <form onSubmit={(e) => { e.preventDefault(); void save(f.key); }} className="ak-row">
                      <input className="ak-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={FACT_LABELS[f.key]} aria-invalid={err ? true : undefined} aria-describedby={err ? 'fact-error' : undefined} />
                      <Button size="sm" type="submit">Save</Button>
                      <button type="button" className="ak-textbtn" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <span>
                      {(f.key === 'ingredients' || f.key === 'key_ingredients') && f.value.length > 120 ? `${f.value.slice(0, 120)}…` : f.value}
                      {EDITABLE.has(f.key) && !analyzing && !f.disputed ? <button className="ak-textbtn" style={{ marginLeft: 8 }} onClick={() => { setEditing(f.key); setDraft(f.value); }}>Fix</button> : null}
                      {f.disputed && EDITABLE.has(f.key) && !analyzing ? (
                        <span className="ak-row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }} role="group" aria-label={`Which ${FACT_LABELS[f.key]} is right?`}>
                          {disputeChoices(f.key, f.candidates).map((c) => (
                            <button key={c.value} type="button" className="ak-btn ak-btn--secondary ak-btn--sm" onClick={() => void resolveSource(f.key, { value: c.value })}>
                              {c.label}
                            </button>
                          ))}
                          <button type="button" className="ak-textbtn" onClick={() => { setEditing(f.key); setDraft(''); }}>Something else</button>
                        </span>
                      ) : null}
                      {f.sourceConflict && !analyzing ? (
                        <span className="ak-small ak-muted" style={{ display: 'block' }}>
                          {SOURCE_WORDS[f.sourceConflict.source] ?? 'Another source'} {f.sourceConflict.newer ? 'now says' : 'says'} “{f.sourceConflict.value}”
                          {f.sourceConflict.newer ? ` (since ${formatDate(f.sourceConflict.observedAt)})` : ''}.
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
                chip: (
                  <span className="ak-row" style={{ gap: 6 }}>
                    <ProvenanceChip state={f.state as 'OBSERVED' | 'INFERRED' | 'DECIDED'} source={f.source} at={f.observedAt} />
                    {f.confirmed && f.state !== 'DECIDED' ? <span className="ak-small ak-muted" title="You confirmed this">✓ confirmed</span> : null}
                  </span>
                ),
              }))}
          />
          {/* Claims appear as they are found (M2), each with its chip. */}
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
          {conceptsDrafting ? (
            <ul className="ak-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-live="polite" aria-label="Test ideas being drafted">
              {['A', 'B', 'C'].map((x) => (
                <li key={x} className="ak-between ak-small ak-muted"><span className="ak-index">Test idea {x}</span><span>drafting…</span></li>
              ))}
            </ul>
          ) : null}
          {!analyzing ? (
            <>
              {err ? <p className="ak-error" role="alert" id="fact-error">{err}</p> : null}
              {failed ? (
                <div className="ak-stack">
                  <Banner tone="warn">{v.project.failureReason ?? 'We couldn’t finish reading this product.'}</Banner>
                  {v.sku.selectProduct ? <HeroPicker projectId={projectId} photoUrl={v.sku.selectProduct.photoUrl} onPicked={() => { resume(); refresh(); }} /> : null}
                  {v.sku.productChoices ? <ProductChooser projectId={projectId} choices={v.sku.productChoices} onChosen={() => { resume(); refresh(); }} /> : null}
                  {v.sku.duplicate?.blocking ? <DuplicateChoice projectId={projectId} dup={v.sku.duplicate} onKept={() => { resume(); refresh(); }} /> : null}
                  {v.sku.sourceUrl ? <p className="ak-small ak-muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>Your link is saved: {v.sku.sourceUrl}</p> : null}
                  <PhotoAdder
                    projectId={projectId}
                    title={v.sku.usablePhotos ? 'Add a plain photo of the product' : 'Add 1–3 photos of your product'}
                    why="We use them to match your packaging exactly in the ad and to read the label (name, size, claims). The front, plus the back label if you have it."
                    cta="Add photos and continue"
                    onAdded={() => { resume(); refresh(); }}
                  />
                  {v.sku.usablePhotos && !v.sku.selectProduct && !v.sku.productChoices && !v.sku.duplicate?.blocking ? (
                    <>
                      <MissingFacts projectId={projectId} fields={v.sku.missingFacts} onSaved={refresh} />
                      <div><Button variant="secondary" onClick={() => void retryAnalysis()}>Try again</Button></div>
                    </>
                  ) : null}
                </div>
              ) : !v.sku.ingredientsVerified ? (
                <div className="ak-panel ak-stack">
                  <h2 className="ak-label">Add your ingredient list to unlock ingredient tests</h2>
                  <p className="ak-small ak-muted" style={{ margin: 0 }}>We didn’t find an ingredient list on your page or label, so we won’t suggest ingredient-led ads or guess ingredients from the category.</p>
                  <MissingFacts projectId={projectId} fields={[{ key: 'ingredients', label: 'Ingredient list', hint: 'As printed on the pack, e.g. “Niacinamide, Zinc PCA”.' }]} onSaved={refresh} />
                </div>
              ) : null}
              {!failed && v.sku.fidelityConfidence != null ? (
                // Standard §8 Product Brain confirmation: asset-quality confidence, and whether more views would help.
                <p className="ak-small" style={{ margin: 0 }}>
                  <span className="ak-label">Photo quality</span>{' '}
                  {photoQuality(v.sku.fidelityConfidence)}
                  {v.sku.fidelityConfidence < LOW_FIDELITY && v.sku.suggestedViews.length && v.sku.addedViews === 0
                    ? ` — ${v.sku.suggestedViews.map((x) => VIEW_WORDS[x] ?? x).join(', ')} would make the product sharper in your ad.`
                    : ''}
                </p>
              ) : null}
              {!failed && ready && v.sku.addedViews === 0 && v.sku.suggestedViews.length > 0 && (v.sku.fidelityConfidence ?? 1) < LOW_FIDELITY ? (
                <PhotoAdder
                  projectId={projectId}
                  title="Add a side/back photo for sharper product accuracy"
                  why={`Optional — ${v.sku.suggestedViews.map((x) => VIEW_WORDS[x] ?? x).join(', ')} would help us keep your packaging exact in every scene.`}
                  cta="Add photos"
                  onAdded={refresh}
                />
              ) : null}
              {!failed && v.sku.duplicate && !v.sku.duplicate.blocking && v.access.signedIn ? <DuplicateChoice projectId={projectId} dup={v.sku.duplicate} onKept={refresh} /> : null}
              {!failed && v.sku.variants.length > 1 ? <VariantPicker projectId={projectId} v={v} onSaved={refresh} /> : null}
              {!failed && v.sku.missingEvidence.length ? (
                <div>
                  <h2 className="ak-label">What would make these ads stronger</h2>
                  <ul className="ak-small" style={{ margin: 0 }}>{v.sku.missingEvidence.map((m) => <li key={m}>{m}</li>)}</ul>
                </div>
              ) : null}
              {failed ? null : ready ? (
                <>
                  <LinkButton href={`/concepts/${projectId}`} block id="cta" onClick={(e) => { e.preventDefault(); void confirmAndGo(); }}>Looks right — show me 3 ad ideas</LinkButton>
                  {/* Plan 04 L19: the next step stays in reach on a phone once the button scrolls away. */}
                  <StickyCta watchId="cta" mobileOnly>
                    <LinkButton href={`/concepts/${projectId}`} block onClick={(e) => { e.preventDefault(); void confirmAndGo(); }}>Looks right — show me 3 ad ideas</LinkButton>
                  </StickyCta>
                </>
              ) : v.project.state === 'NEEDS_USER_ACTION' ? (
                <Banner tone="warn">{v.project.failureReason ?? 'We need a clearer photo of the product. Add one to continue.'}</Banner>
              ) : conceptsDrafting ? null : (
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

/** §8 goals, in customer words; the default is performance ("sell the product"). */
const GOALS: { value: CreativeGoal; label: string }[] = [
  { value: 'performance', label: 'Sell the product' },
  { value: 'ugc_review', label: 'UGC-style review' },
  { value: 'explainer', label: 'Explain the product' },
  { value: 'premium', label: 'Premium look' },
];

type ConceptCard = View['concepts'][number];

/** P5 "Why this?" (M6, standard §13): the evidence and the gap behind a recommended idea, one click away. */
export function WhyThis({ c, pickReason }: { c: Pick<ConceptCard, 'whyNow' | 'customerTension' | 'customerTensionSource' | 'primaryVariable' | 'angle' | 'ifTestFails'>; pickReason?: string | null }) {
  return (
    <details className="ak-small">
      <summary>Why this?</summary>
      <dl className="ak-meta" style={{ marginTop: 8 }}>
        <dt>Why now</dt><dd>{c.whyNow}</dd>
        <dt>Evidence</dt><dd>{tensionSourceWords(c.customerTensionSource)}: {c.customerTension}</dd>
        <dt>The gap</dt><dd>It changes only the {String(c.primaryVariable).replace(/_/g, ' ')} to test the {String(c.angle).replace(/_/g, ' ').toLowerCase()} angle.</dd>
        {pickReason ? <><dt>Why we’d test it first</dt><dd>{pickReason}</dd></> : null}
        <dt>If it loses</dt><dd>{c.ifTestFails}</dd>
      </dl>
    </details>
  );
}

export function ConceptsFlow({ projectId, providers }: { projectId: string; providers: { google: boolean; apple: boolean } }) {
  const active = useCallback(
    (v: View | null) => !v || v.concepts.length === 0 || v.project.state === 'CONCEPT_SELECTED' || v.conceptRequest?.status === 'pending' || v.conceptRequest?.status === 'active',
    [],
  );
  const { data: v, error, refresh, resume } = useProject(projectId, active);
  const [gate, setGate] = useState<string | null>(null);
  const [gateDismissed, setGateDismissed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The idea chosen before the save gate (plan 03 P6) comes back as ?select=<concept> after sign-in: it is picked
  // for the merchant, once, instead of asking them to choose again.
  const carried = useRef(false);
  useEffect(() => {
    if (!v || v.access.provisional || carried.current) return;
    const sel = new URLSearchParams(window.location.search).get('select');
    if (!sel) return;
    carried.current = true;
    window.history.replaceState(null, '', `/concepts/${projectId}`);
    if (!v.concepts.some((c) => c.id === sel)) return;
    setBusy(sel);
    api(`/api/projects/${projectId}/select`, { conceptId: sel })
      .then(() => window.location.assign(`/storyboard/${projectId}`))
      .catch((e) => {
        setBusy(null);
        setErr((e as Error).message);
      });
  }, [v, projectId]);
  if (!v) return error ? <PreviewUnavailable projectId={projectId} error={error} /> : <Loading />;

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
  async function more(goal?: CreativeGoal) {
    setBusy(goal ? `goal:${goal}` : 'more');
    setErr(null);
    try {
      // Queued server-side (202); polling picks up the new batch or the request's failure.
      await api(`/api/projects/${projectId}/concepts`, goal ? { goal } : {});
      resume();
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
  }
  const drafting = v.conceptRequest?.status === 'pending' || v.conceptRequest?.status === 'active';
  const pick = v.concepts.find((c) => c.isPick) ?? v.concepts[0];
  const cost = conceptCost(v.project.kind, v.quote);

  return (
    // While the save gate is open, steps 1–2 are done (plan 04 L4: we ask for the account after the value).
    <Shell
      step={gate ? 3 : 2}
      title={v.concepts.length > 0 && v.concepts.length < 3 ? `${v.concepts.length === 1 ? 'One way' : 'Two ways'} to test this product` : 'Three ways to test this product'}
      sub={<>Each idea is a different bet on why a customer would stop scrolling. We marked the one we’d test first — pick any.{v.access.provisional ? null : ' Your concepts are saved in your archive.'}</>}
    >
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {gateDismissed && v.access.provisional ? <Banner>Your ideas are kept in this browser for {v.previewDays} days. Save your work to keep them in your archive.</Banner> : null}
      {v.conceptRequest?.status === 'failed' && v.conceptRequest.batch > (v.concepts[0]?.batch ?? 0) ? <Banner tone="warn">{v.conceptRequest.detail ?? 'We couldn’t draft more ideas just now. Please try again.'}</Banner> : null}
      {v.concepts.length ? (
        <fieldset className="ak-row" style={{ flexWrap: 'wrap', gap: 8, border: 0, padding: 0, margin: '0 0 24px' }} disabled={!!busy || drafting}>
          <legend className="ak-label" style={{ marginBottom: 8 }}>What should this ad do?</legend>
          {GOALS.map((g) => (
            <label key={g.value} className={`ak-chip${v.project.goal === g.value ? ' ak-chip--dec' : ''}`} style={{ cursor: 'pointer' }}>
              <input type="radio" name="goal" value={g.value} className="ak-sr" checked={v.project.goal === g.value} onChange={() => void more(g.value)} />
              {g.label}
            </label>
          ))}
        </fieldset>
      ) : null}
      {v.concepts.length > 0 && v.concepts.length < 3 && !drafting ? (
        // Plan 03 P5: after a retry, fewer than three passed our claims and diversity checks — say so, never pad.
        <Banner>
          We found {v.concepts.length === 1 ? 'one strong direction' : 'two strong directions'} for this product, not three — the others didn’t pass our claims checks, and we don’t fill the gap with weaker ideas.
        </Banner>
      ) : null}
      {v.concepts.length === 0 ? (
        <p className="ak-muted">Drafting ideas…</p>
      ) : (
        <div className="ak-carousel" role="list" aria-label="Ad ideas">
          {v.concepts.map((c) => {
            const hooks = c.hookOptions ?? [];
            return (
              <article key={c.id} role="listitem" className={`ak-card${c.isPick ? ' ak-card--pick' : ''}`}>
                <div className="ak-between">
                  <span className="ak-index">{c.idx}</span>
                  {c.isPick ? <span className="ak-chip ak-chip--dec">Our pick</span> : <span className="ak-chip">{RISK[c.riskProfile] ?? ''}</span>}
                </div>
                <h2 className="ak-h2 ak-serif" style={{ marginTop: 16 }}>“{hooks[0]}”</h2>
                <p className="ak-small">{c.hypothesis}</p>
                <dl className="ak-meta ak-small">
                  <dt>Customer tension</dt>
                  <dd>{c.customerTension} <span className="ak-chip" style={{ marginLeft: 4 }}>{tensionSourceWords(c.customerTensionSource)}</span></dd>
                  <dt>Tests</dt><dd>{String(c.primaryVariable)}</dd>
                  <dt>Angle</dt><dd>{String(c.angle).replace(/_/g, ' ')}</dd>
                  <dt>Proof</dt><dd>{String(c.proofMechanism).replace(/_/g, ' ')}</dd>
                  <dt>Production style</dt><dd className="ak-mono">{String(c.treatment).replace(/_/g, ' ').toLowerCase()}</dd>
                  <dt>You’ll learn</dt><dd>{c.expectedLearning}</dd>
                  <dt>Cost</dt><dd>{cost}{c.estimatedGenerationClass === 'premium' ? <span className="ak-chip" style={{ marginLeft: 4 }}>Premium production</span> : null}</dd>
                </dl>
                <WhyThis c={c} pickReason={c.isPick ? c.pickReason : null} />
                {c.needsEvidence ? (
                  <p className="ak-small" style={{ margin: 0 }}>
                    <span className="ak-chip ak-chip--warn" title={c.droppedClaims.map((w) => `“${w}”`).join(', ')}>A claim needs your evidence</span>{' '}
                    <span className="ak-muted">We’ll use a compliant line in the storyboard. Add evidence in Claims to use it later.</span>
                  </p>
                ) : null}
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
          <button className="ak-textbtn" disabled={!!busy || drafting} onClick={() => void more()} aria-live="polite">{busy === 'more' || busy?.startsWith('goal:') || drafting ? 'Drafting three more ideas…' : 'None of these — try 3 more'}</button>
        </p>
      ) : null}
      {pick ? (
        <StickyCta watchId="cta" mobileOnly>
          <Button block disabled={!!busy} onClick={() => choose(pick.id)}>Build the storyboard for idea {pick.idx}</Button>
        </StickyCta>
      ) : null}
      <SaveGate
        open={!!gate}
        onOpenChange={(o) => {
          if (!o) {
            setGate(null);
            setGateDismissed(true);
          }
        }}
        next={gate ? `/concepts/${projectId}?select=${gate}` : `/concepts/${projectId}`}
        productName={v.sku.name}
        providers={providers}
      />
    </Shell>
  );
}

/**
 * P6 save gate: value first, then a light ask — email link or one-tap Google/Apple (each shown only when it can be
 * used). The preview is preserved either way; accepting the Terms is logged with the account (no checkbox).
 */
export function SaveGate({ open, onOpenChange, next, productName, providers }: { open: boolean; onOpenChange: (o: boolean) => void; next: string; productName: string; providers: { google: boolean; apple: boolean } }) {
  const n = encodeURIComponent(next);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`Save ${productName} and see its storyboard`} description={`Your ${productName} catalogue and ideas are kept, and we’ll draw the idea you picked as soon as you’re in. No card needed.`}>
      <EmailLinkForm next={next} label="Work email" submitLabel="Email me a sign-in link" ttlMinutes={MAGIC_LINK_TTL_MIN} sentNote="We sent a sign-in link. It opens right back here — or keep this tab open and it will follow along.">
        {providers.apple || providers.google ? (
          <div className="ak-row" style={{ justifyContent: 'center' }}>
            {providers.apple ? <a className="ak-btn ak-btn--secondary" href={`/api/auth/apple/start?next=${n}`}>Continue with Apple</a> : null}
            {providers.google ? <a className="ak-btn ak-btn--secondary" href={`/api/auth/google/start?next=${n}`}>Continue with Google</a> : null}
          </div>
        ) : null}
        <p className="ak-small ak-muted">By continuing you agree to the <a href="/legal/terms">Terms</a> and <a href="/legal/privacy">Privacy Policy</a>.</p>
      </EmailLinkForm>
    </Sheet>
  );
}

/* ───────────── P7 · Storyboard + offer ───────────── */

const PURPOSE: Record<string, string> = { hook: 'Hook', problem: 'Problem', product_reveal: 'Reveal', demonstration: 'Demo', proof: 'Proof', benefit: 'Benefit', routine: 'Routine', cta: 'Call to action' };
/** The Production Planner's medium, in customer words (§23). */
const MODE_LABEL: Record<string, string> = { STRICT_COMPOSITE: 'Exact product', GENERATIVE_INTERACTION: 'Generated motion', HYBRID: 'Generated setting + exact product', REAL_ASSET_REMIX: 'Your footage', CREATOR_PACK: 'Creator shot' };

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
  // A subscriber with Creative Tests left makes this ad with one of them; the one-off price is for an ad outside the
  // plan (standard §5), shown only once none are left.
  const testsLeft = v.plan.creativeTestsLeft;
  const withTest = testsLeft > 0;
  const ready = !!sb && sb.status !== 'generating' && sb.status !== 'failed';
  const freeLeft = sb?.freeRegenerationsLeft ?? 0;

  if (sb?.status === 'failed') {
    return <StoryboardFailed projectId={projectId} detail={sb.steps.find((s) => s.status === 'failed')?.detail ?? null} onRetry={() => { resume(); refresh(); }} />;
  }

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
      {!sb || sb.status === 'generating' ? <LiveLedger steps={sb?.steps ?? []} /> : null}
      {ready && sb!.scenes.length > 0 && !resumable ? (
        <p className="ak-small ak-muted" id="free-changes">
          {freeLeft > 0 ? `Picture changes: free · ${freeLeft} of ${sb!.freeRegenerationsTotal} left.` : 'Free picture changes used — words are still free to edit; pictures can be adjusted after production.'}
        </p>
      ) : null}
      {sb && sb.scenes.length ? (
        <div className="ak-scroll-row" role="list">
          {sb.scenes.map((s) => (
            <figure key={s.id} className="ak-frame" role="listitem" data-locked={s.locked}>
              <div className="ak-well ak-well--916">{s.frameUrl ? <img src={s.frameUrl} alt={`Scene ${s.position + 1}: ${s.visualPlan}`} /> : <span className="ak-index" aria-hidden>{String(s.position + 1).padStart(2, '0')}</span>}</div>
              <figcaption className="ak-small">
                <div className="ak-between"><span className="ak-index">{String(s.position + 1).padStart(2, '0')} · {PURPOSE[s.purpose] ?? s.purpose}</span><span className="ak-index">{(s.durationMs / 1000).toFixed(1)}s</span></div>
                {s.overlayText ? <p style={{ fontWeight: 500 }}>{s.overlayText}</p> : null}
                {s.spokenLine ? <p className="ak-muted">“{s.spokenLine}”</p> : null}
                {s.plannerReason ? <p className="ak-small ak-muted">{MODE_LABEL[s.productionMode] ?? 'Scene'} · {s.plannerReason}</p> : null}
                {s.regeneration?.status === 'pending' || s.regeneration?.status === 'active' ? <p className="ak-small ak-muted" role="status">Redrawing this frame…</p> : null}
                {s.regeneration?.status === 'failed' ? <p className="ak-small ak-error" role="status">{s.regeneration.detail ?? 'We couldn’t redraw this frame.'}</p> : null}
                <div className="ak-row">
                  <button className="ak-textbtn" disabled={s.locked} onClick={() => setEdit({ id: s.id, spokenLine: s.spokenLine ?? '', overlayText: s.overlayText ?? '' })}>Edit words</button>
                  <button className="ak-textbtn" disabled={s.locked || s.regeneration?.status === 'pending' || s.regeneration?.status === 'active'} onClick={() => setRegen({ id: s.id, text: '' })}>Change picture</button>
                  <LockButton locked={s.locked} scene={String(s.position + 1)} onClick={() => void call(`/api/scenes/${s.id}/lock`, { projectId, locked: !s.locked })} />
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {ready && v.project.revisionFree && !resumable ? (
        <section className="ak-panel" style={{ marginTop: 40 }} id="finish">
          <h2 className="ak-label">Make it again — free</h2>
          <p className="ak-small ak-muted">This re-plan is on us, because your first ad didn’t show your product accurately. Check the scenes, then we’ll make it — nothing to pay.</p>
          <Button block id="cta" disabled={busy} onClick={async () => { if (await call(`/api/projects/${projectId}/produce-free`, {})) window.location.assign(`/produce/${projectId}`); }}>Make my ad</Button>
        </section>
      ) : null}
      {ready && resumable ? (
        <section className="ak-panel" style={{ marginTop: 40 }} id="finish">
          <h2 className="ak-label">Finish your ad</h2>
          <p className="ak-small ak-muted">You’ve already paid for this ad, so there’s nothing more to pay. We check your changes, then produce it — scenes that were already made are reused.</p>
          <Button block disabled={busy} onClick={async () => { if (await call(`/api/projects/${projectId}/finish`, {})) window.location.assign(`/produce/${projectId}`); }}>Finish my ad</Button>
          <div style={{ marginTop: 12 }}><CancelProduction projectId={projectId} v={v} onChange={() => window.location.assign(`/produce/${projectId}`)} /></div>
        </section>
      ) : null}
      {ready && !resumable && !v.project.revisionFree && withTest ? (
        <section className="ak-panel" style={{ marginTop: 40 }} id="offer">
          <div className="ak-between" style={{ alignItems: 'start', flexWrap: 'wrap', gap: 24 }}>
            <div>
              <h2 className="ak-label">Make this ad</h2>
              <p className="ak-h2" style={{ margin: 0 }}>1 Creative Test</p>
              <p className="ak-small ak-muted">Included in your plan · {testsLeft} left this period. Nothing more to pay.</p>
            </div>
            <ul className="ak-small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>One finished 15-second ad with voiceover and captions</li>
              <li>Hook variants to test, and exports for TikTok, Reels, Feed and Square</li>
              <li>Your real packaging, checked scene by scene</li>
              <li>Every claim checked against FDA cosmetic rules</li>
              <li>If we can’t deliver an ad that passes our checks, the Creative Test comes back to you</li>
            </ul>
          </div>
          <div style={{ marginTop: 24 }}>
            <Button block id="cta" disabled={busy} onClick={async () => { if (await call(`/api/projects/${projectId}/produce-with-test`, {})) window.location.assign(`/produce/${projectId}`); }}>
              {busy ? 'Starting…' : `Produce with 1 of ${testsLeft} Creative Test${testsLeft === 1 ? '' : 's'}`}
            </Button>
            <p className="ak-small ak-muted" style={{ textAlign: 'center' }}>Ready in about 10 minutes.</p>
          </div>
        </section>
      ) : null}
      {ready && !resumable && !v.project.revisionFree && !withTest ? (
        <section className="ak-panel" style={{ marginTop: 40 }} id="offer">
          <div className="ak-between" style={{ alignItems: 'start', flexWrap: 'wrap', gap: 24 }}>
            <div>
              <h2 className="ak-label">{v.plan.subscribed ? 'Make this ad outside your plan' : 'Make this ad'}</h2>
              <p className="ak-price">
                {usd(q.priceMicros)}
                {taste && q.referencePriceMicros ? <span className="ak-strike ak-muted" style={{ marginLeft: 12, fontSize: '0.5em' }}>{usd(q.referencePriceMicros)}</span> : null}
              </p>
              <p className="ak-small ak-muted">
                {v.plan.subscribed
                  ? 'You’ve used this period’s Creative Tests. A one-time payment for this ad — your plan doesn’t change.'
                  : taste ? 'Intro price for your first ad. One-time — no subscription.' : 'One-time — no subscription.'}
              </p>
              {taste && v.bonus.offered ? <p className="ak-small" style={{ margin: 0 }}>+ An alternate opening hook, free with this price</p> : null}
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
      {ready && !resumable && !v.project.revisionFree ? (
        <StickyCta watchId="cta" mobileOnly>
          {withTest ? (
            <Button block disabled={busy} onClick={async () => { if (await call(`/api/projects/${projectId}/produce-with-test`, {})) window.location.assign(`/produce/${projectId}`); }}>Produce with 1 Creative Test</Button>
          ) : (
            <LinkButton href={`/checkout/${projectId}`} block>Make my ad · {usd(q.priceMicros)}</LinkButton>
          )}
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
      <Sheet
        open={!!regen}
        onOpenChange={(o) => !o && setRegen(null)}
        title="Change this picture"
        description={
          freeLeft > 0
            ? `Free · ${freeLeft} of ${sb?.freeRegenerationsTotal ?? 3} changes left. Describe what to change — your product stays exactly as it is.`
            : 'You’ve used the free picture changes for this storyboard.'
        }
      >
        {regen && freeLeft > 0 ? (
          <form className="ak-stack" onSubmit={async (e) => { e.preventDefault(); if (await call(`/api/scenes/${regen.id}/regenerate`, { projectId, instruction: regen.text })) { setRegen(null); resume(); } }}>
            <label className="ak-field">
              <span className="ak-label">What to change</span>
              <textarea className="ak-textarea" maxLength={200} placeholder="e.g. warmer morning light, marble counter" value={regen.text} onChange={(e) => setRegen({ ...regen, text: e.target.value })} />
            </label>
            {err ? <p className="ak-error" role="alert">{err}</p> : null}
            <Button type="submit" disabled={busy || !regen.text.trim()}>{busy ? 'Sending…' : 'Redraw · free'}</Button>
          </form>
        ) : regen ? (
          <div className="ak-stack">
            <p className="ak-small" style={{ margin: 0 }}>The words are still free to edit — use “Edit words” on any scene. The picture can be adjusted after production.</p>
            <Button variant="secondary" onClick={() => setRegen(null)}>OK</Button>
          </div>
        ) : null}
      </Sheet>
    </Shell>
  );
}

/**
 * We failed to draw the storyboard (plan 03 P7 edge; standard §14 honesty): no offer and no checkout — the offer's
 * clock starts only at STORYBOARD_READY (§5). The customer can try again or pick another idea; nothing was charged.
 */
function StoryboardFailed({ projectId, detail, onRetry }: { projectId: string; detail: string | null; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; pickAnother: boolean } | null>(null);
  async function retry() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/storyboard-retry`, {});
      onRetry();
    } catch (e) {
      setErr({ message: (e as Error).message, pickAnother: !!(e as { details?: { pickAnother?: boolean } }).details?.pickAnother });
    }
    setBusy(false);
  }
  return (
    <Shell step={3} title="We couldn’t finish this storyboard" sub="Nothing was charged. Try again, or pick another idea for this product.">
      <div className="ak-stack" style={{ maxWidth: 560 }}>
        {detail && !/nothing was charged/i.test(detail) ? <Banner tone="warn">{detail}</Banner> : null}
        {err ? <Banner tone="risk">{err.message}</Banner> : null}
        <div className="ak-row" style={{ flexWrap: 'wrap' }}>
          {err?.pickAnother ? null : <Button disabled={busy} onClick={() => void retry()} id="cta">{busy ? 'Starting again…' : 'Try again'}</Button>}
          <LinkButton href={`/concepts/${projectId}`} variant="secondary">Pick another idea</LinkButton>
        </div>
      </div>
    </Shell>
  );
}

/* ───────────── P8 · Checkout ───────────── */

/**
 * P8 order summary (plan 03 P8, plan 04 L11/L12, standard §8): personalised to the SKU and the chosen idea — what
 * will be produced, the storyboard, the price and when the offer ends — beside a sealed payment panel.
 */
function OrderSummary({ v, priceMicros }: { v: View; priceMicros: number }) {
  const sb = v.storyboard;
  const frames = (sb?.scenes ?? []).filter((s) => s.frameUrl);
  const taste = v.quote.kind === 'taste' && v.quote.status === 'active';
  return (
    <section className="ak-panel ak-stack" aria-labelledby="order-summary" style={{ gap: 12 }}>
      <h2 className="ak-label" id="order-summary">Your order</h2>
      <div className="ak-row" style={{ alignItems: 'start', gap: 16 }}>
        {frames[0] ? <div className="ak-well ak-well--916" style={{ width: 72, flex: 'none' }}><img src={frames[0].frameUrl!} alt={`First scene of your storyboard for ${v.sku.name}`} /></div> : null}
        <div className="ak-stack" style={{ gap: 4 }}>
          <p style={{ margin: 0 }}><strong>{v.sku.name}</strong> <span className="ak-index">No. {String(v.sku.catalogueNo).padStart(3, '0')}</span></p>
          {sb?.hook ? <p className="ak-small ak-serif" style={{ margin: 0 }}>“{sb.hook}”</p> : null}
          <p className="ak-small ak-muted" style={{ margin: 0 }}>15-second ad · one-time {usd(priceMicros)}</p>
        </div>
      </div>
      {frames.length > 1 ? (
        <div className="ak-row" style={{ gap: 6, overflowX: 'auto' }} aria-label="Your storyboard">
          {frames.map((s) => (
            <div key={s.id} className="ak-well ak-well--916" style={{ width: 40, flex: 'none' }}><img src={s.frameUrl!} alt="" /></div>
          ))}
        </div>
      ) : null}
      <ul className="ak-small" style={{ margin: 0, paddingLeft: 18 }}>
        <li>One finished 15-second ad with voiceover and captions</li>
        <li>Exports for TikTok, Reels (9:16), Feed (4:5) and Square</li>
        {taste && v.bonus.offered ? <li>+ An alternate opening hook, free with this price</li> : null}
      </ul>
      <dl className="ak-meta ak-small" style={{ margin: 0 }}>
        <dt>Ad</dt>
        <dd>
          {usd(priceMicros)}
          {taste && v.quote.referencePriceMicros ? <span className="ak-strike ak-muted" style={{ marginLeft: 8 }}>{usd(v.quote.referencePriceMicros)}</span> : null}
        </dd>
        <dt>Tax</dt><dd>Calculated by Stripe from your address, before you pay</dd>
        <dt>Total</dt><dd>{usd(priceMicros)} + any tax · one-time, no subscription</dd>
      </dl>
      {taste && v.quote.expiresAt ? <OfferExpiry expiresAt={v.quote.expiresAt} serverNow={v.serverNow} /> : null}
    </section>
  );
}

export function CheckoutFlow({ projectId, publishableKey, supportEmail }: { projectId: string; publishableKey: string | null; supportEmail?: string | null }) {
  const [state, setState] = useState<{ clientSecret: string | null; url: string | null; quote: { priceMicros: number } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [Embedded, setEmbedded] = useState<React.ComponentType<{ clientSecret: string; pk: string }> | null>(null);
  // The storyboard and the SKU stay in view while paying (plan 04 L11): one read of the project view.
  const view = usePoll<View>(`/api/projects/${projectId}`, 60_000, false);
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
        // A plan with Creative Tests left makes this ad with one of them (§5): back to the storyboard's test button.
        else if ((e as { details?: { useCreativeTest?: boolean } }).details?.useCreativeTest) window.location.assign(`/storyboard/${projectId}#offer`);
        else if ((e as { status?: number }).status === 409 && /already/i.test((e as Error).message)) window.location.assign(`/produce/${projectId}`);
        else setErr((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [projectId, publishableKey]);
  const v = view.data;
  return (
    <Shell step={4} title="Make your ad" sub="Step 4 of 4: we’ve done the strategy; this produces it. One-time payment — no subscription is created.">
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <div className="ak-stack">
          {v ? <OrderSummary v={v} priceMicros={state?.quote.priceMicros ?? v.quote.priceMicros} /> : null}
          {/* Closing checkout keeps the offer: back to the storyboard, where it is still live (plan 03 P8). */}
          <p className="ak-small" style={{ margin: 0 }}><a href={`/storyboard/${projectId}`}>← Back to storyboard</a></p>
        </div>
        <div className="ak-sealed ak-stack" style={{ gap: 12 }}>
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
          <p className="ak-small ak-muted" style={{ margin: 0 }}>
            Payments by Stripe · we never see your card.{supportEmail ? <> Questions? <a href={`mailto:${supportEmail}`}>{supportEmail}</a></> : null}
          </p>
        </div>
      </div>
    </Shell>
  );
}

/* ───────────── P9 · Production ───────────── */

export function ProduceFlow({ projectId }: { projectId: string }) {
  // A production paused by a provider outage resumes by itself, so keep polling it.
  const active = useCallback((v: View | null) => !v || v.project.paused || (v.project.state !== 'COMPLETE' && !STOPPED.includes(v.project.state)), []);
  const { data: v, error, resume } = useProject(projectId, active);
  // "Payment confirmed, starting production" once the wait for Stripe ends (plan 03 P8).
  const [confirmed, setConfirmed] = useState(false);
  const wasWaiting = useRef(false);
  const wait = v ? awaitingPayment(v) : null;
  // Not in production yet (the storyboard is still being drawn, or is ready and nothing was paid or started): the
  // storyboard page shows that, not an empty production ledger (A1 active jobs link here by state).
  const prePayment = !!v && (['PRODUCT_UPLOADED', 'PRODUCT_ANALYZED', 'BRIEF_READY', 'CONCEPTS_READY', 'CONCEPT_SELECTED'].includes(v.project.state) || wait === 'unpaid');
  useEffect(() => {
    if (!v) return;
    if (v.project.state === 'COMPLETE') window.location.replace(`/deliver/${projectId}`);
    else if (prePayment) window.location.replace(projectRoute(v.project.state, projectId));
  }, [v, prePayment, projectId]);
  useEffect(() => {
    if (wait === 'confirming') wasWaiting.current = true;
    else if (wasWaiting.current && v && PRODUCING.includes(v.project.state)) {
      wasWaiting.current = false;
      setConfirmed(true);
    }
  }, [wait, v]);
  if (!v || prePayment) return error ? <div className="ak-wrap ak-section"><Banner tone="risk">{error}</Banner></div> : <Loading />;
  const waitingPayment = wait === 'confirming';
  const paused = v.project.paused;
  const stopped = !paused && STOPPED.includes(v.project.state);
  const title = v.project.state === 'BLOCKED_COMPLIANCE' ? 'One line needs changing' : v.project.state === 'CANCELLED' ? 'This ad was cancelled' : stopped ? 'We couldn’t finish this ad' : paused ? 'Your ad is queued' : waitingPayment ? 'Confirming your payment' : 'Making your ad';
  return (
    <Shell step={4} title={title} sub={stopped ? undefined : 'Usually about 10 minutes. We’ll email you when it’s ready — you can close this tab.'}>
      {waitingPayment ? <p className="ak-muted" role="status">Waiting for confirmation from Stripe… this usually takes a few seconds.</p> : null}
      {confirmed && !waitingPayment ? <Banner>Payment confirmed, starting production.</Banner> : null}
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
          <LiveLedger steps={v.productionSteps} />
          <Liveness live={v.project.liveness} />
        </>
      )}
      {!stopped && !waitingPayment ? <div style={{ marginTop: 24 }}><PasskeyPrompt v={v} /></div> : null}
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

const clock = (iso: string) => formatTime(iso);

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
function WatchedVideo({ projectId, assetId, src, onPlaying, onBlocked, onProgress }: { projectId: string; assetId: string; src: string; onPlaying?: () => void; onBlocked?: () => void; onProgress?: (seconds: number, ended: boolean) => void }) {
  const sent = useRef(false);
  const el = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  // M12: plays inline at once, muted (captions are burned in). A browser that refuses autoplay gets the controls.
  useEffect(() => {
    const p = el.current?.play();
    if (p) p.catch(() => onBlocked?.());
  }, [src, onBlocked]);
  const report = (seconds: number) => {
    if (sent.current) return;
    sent.current = true;
    fetch(`/api/projects/${projectId}/watched`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId, seconds: Number.isFinite(seconds) ? Math.round(seconds) : 0 }) }).catch(() => {});
  };
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
    <video
      ref={el}
      src={src}
      autoPlay
      muted
      controls
      playsInline
      preload="auto"
      onPlaying={onPlaying}
      onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      onTimeUpdate={(e) => {
        if (e.currentTarget.currentTime >= 3) report(e.currentTarget.currentTime);
        onProgress?.(e.currentTarget.currentTime, false);
      }}
      onEnded={(e) => {
        report(e.currentTarget.duration || e.currentTarget.currentTime);
        onProgress?.(e.currentTarget.duration || e.currentTarget.currentTime, true);
      }}
    />
    {/* P10: plays muted with captions burned in; one tap turns the sound on. */}
    {muted ? (
      <button
        type="button"
        className="ak-btn ak-btn--secondary ak-btn--sm"
        style={{ position: 'absolute', top: 12, left: 12 }}
        onClick={() => {
          if (!el.current) return;
          el.current.muted = false;
          void el.current.play().catch(() => {});
        }}
      >
        Tap for sound
      </button>
    ) : null}
    </div>
  );
}

/** iOS Safari saves videos through the share sheet ("Save Video"), not the download link (plan 03 P10 edge case). */
const isIos = () => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * A tracked download that, on iOS with file sharing, opens the share sheet with the video instead; anything that
 * can't share (or fails to) falls back to the normal download.
 */
function DownloadLink({ href, filename, className, id, onDownload, children }: { href: string; filename: string; className: string; id?: string; onDownload?: () => void; children: React.ReactNode }) {
  return (
    <a
      id={id}
      className={className}
      href={href}
      download
      onClick={async (e) => {
        onDownload?.();
        if (!isIos() || typeof navigator.canShare !== 'function') return;
        e.preventDefault();
        try {
          const blob = await (await fetch(href)).blob();
          const file = new File([blob], filename, { type: blob.type || 'video/mp4' });
          if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
          else window.location.assign(href);
        } catch (err) {
          if ((err as Error).name !== 'AbortError') window.location.assign(href);
        }
      }}
    >
      {children}
    </a>
  );
}

const fileName = (href: string) => new URL(href, 'https://x').searchParams.get('name') ?? 'arkiv-ad.mp4';

const ASPECT: Record<string, string> = { '9x16': 'TikTok · Reels · Stories (9:16)', '4x5': 'Feed (4:5)', '1x1': 'Square (1:1)' };

/**
 * Standard §42: the product's price or size changed after the ad was made. Updating it is free — new on-screen text
 * over the same footage and voice — and the new files replace the downloads when ready.
 */
function FactUpdate({ projectId, update }: { projectId: string; update: { shown: string | null; current: string | null } | null }) {
  const [state, setState] = useState<'idle' | 'busy' | 'queued' | 'error'>('idle');
  if (!update) return null;
  return (
    <Banner tone="warn">
      Price changed — update your ad.{update.shown && update.current ? ` It shows ${update.shown}; your product is now ${update.current}.` : ''}{' '}
      {state === 'queued' ? (
        <span role="status">Updating — the new files replace these in a minute. No charge.</span>
      ) : (
        <button
          className="ak-textbtn"
          disabled={state === 'busy'}
          onClick={async () => {
            setState('busy');
            const r = await fetch(`/api/projects/${projectId}/recompose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            setState(r.ok ? 'queued' : 'error');
          }}
        >
          {state === 'error' ? 'Try again' : 'Update my ad (free)'}
        </button>
      )}
    </Banner>
  );
}


/**
 * "Sign in faster next time — add a passkey" (plan 06 Phase 3 #8 "Passkeys (offered after first purchase)"; plan 04
 * L5). Shown after a paid purchase to a signed-in user with no passkey, on a device that supports them; dismissing
 * it hides it for good.
 */
function PasskeyPrompt({ v }: { v: View }) {
  const [state, setState] = useState<'idle' | 'busy' | 'added' | 'hidden'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const supported = typeof window !== 'undefined' && 'PublicKeyCredential' in window;
  const show = supported && !!v.access.passkeyPrompt && v.purchase?.status === 'paid' && state !== 'hidden';
  const seen = useRef(false);
  useEffect(() => {
    if (!show || seen.current) return;
    seen.current = true;
    void api('/api/me/passkey-prompt', { event: 'shown' }).catch(() => {});
  }, [show]);
  if (!show) return null;
  if (state === 'added') return <p className="ak-small" role="status">Passkey added. Next time, sign in with your face, fingerprint or device PIN.</p>;
  return (
    <aside className="ak-panel ak-stack" aria-label="Add a passkey">
      <p style={{ margin: 0 }}><strong>Sign in faster next time — add a passkey.</strong></p>
      <p className="ak-small ak-muted" style={{ margin: 0 }}>Use your face, fingerprint or device PIN instead of waiting for an email.</p>
      {err ? <p className="ak-error ak-small" role="alert">{err}</p> : null}
      <div className="ak-row">
        <Button
          size="sm"
          variant="secondary"
          disabled={state === 'busy'}
          onClick={async () => {
            setState('busy');
            setErr(null);
            try {
              setState((await registerPasskey('prompt')) ? 'added' : 'idle');
            } catch (e) {
              setErr((e as Error).message);
              setState('idle');
            }
          }}
        >
          Add a passkey
        </Button>
        <button
          type="button"
          className="ak-textbtn"
          onClick={() => {
            setState('hidden');
            void api('/api/me/passkey-prompt', { event: 'dismissed' }).catch(() => {});
          }}
        >
          Not now
        </button>
      </div>
    </aside>
  );
}

/** M12: the export CTA fades in 1.2s after playback starts (at once under reduced motion; 4s at most). */
function useShowAfterPlay() {
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reveal = useCallback(() => setShow(true), []);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return reveal();
    const fallback = setTimeout(reveal, 4000);
    return () => {
      clearTimeout(fallback);
      clearTimeout(timer.current);
    };
  }, [reveal]);
  const onPlaying = useCallback(() => {
    if (timer.current === undefined) timer.current = setTimeout(reveal, 1200);
  }, [reveal]);
  return { show, onPlaying, reveal };
}

/**
 * "Not right?" (plan 03 P10, standard §48): the merchant says what missed — the strategy, the product's accuracy or
 * the style — and gets a re-plan: free once when the product wasn't shown accurately (our QA should have caught
 * it), otherwise at the one-off price. The delivered ad is kept either way.
 */
function NotRight({ projectId, v }: { projectId: string; v: View }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<'strategy' | 'accuracy' | 'style' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (v.project.kind !== 'taste' && v.project.kind !== 'standalone') return null;
  const price = usd(v.quote.priceMicros);
  const outcome = (r: typeof reason) =>
    r === 'accuracy' && v.project.freeReplanAvailable ? 'We’ll re-plan the same idea and make it again, free.' : r === 'strategy' ? `Pick another direction for ${v.sku.name}; making it is ${price}.` : r ? `We’ll re-plan the same idea with a new storyboard; making it is ${price}.` : null;
  return (
    <>
      <button type="button" className="ak-textbtn" onClick={() => setOpen(true)}>Not right?</button>
      <Sheet open={open} onOpenChange={setOpen} title="What isn’t right?" description="Your ad stays in your archive either way.">
        <form
          className="ak-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!reason) return;
            setBusy(true);
            setErr(null);
            try {
              const r = await api<{ next: string }>(`/api/projects/${projectId}/not-right`, { reason, note: note.trim() || undefined });
              window.location.assign(r.next);
            } catch (x) {
              setErr((x as Error).message);
              setBusy(false);
            }
          }}
        >
          <fieldset className="ak-stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
            <legend className="ak-sr">What isn’t right?</legend>
            {([
              ['strategy', 'The idea — it’s the wrong angle for my customers'],
              ['accuracy', 'My product — it doesn’t look like my real product'],
              ['style', 'The look and feel — the idea is right, the execution isn’t'],
            ] as const).map(([value, label]) => (
              <label key={value} className="ak-row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input type="radio" name="not-right" value={value} checked={reason === value} onChange={() => setReason(value)} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label className="ak-field">
            <span className="ak-label">Anything specific? (optional)</span>
            <textarea className="ak-textarea" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {reason ? <p className="ak-small" role="status" style={{ margin: 0 }}>{outcome(reason)}</p> : null}
          {err ? <p className="ak-error" role="alert">{err}</p> : null}
          <Button type="submit" disabled={!reason || busy}>{busy ? 'Starting…' : 'Continue'}</Button>
        </form>
      </Sheet>
    </>
  );
}

/**
 * Plan 03 P10 #4 / plan 04 L17 / standard §8: the continuation card appears only once the finished ad has been
 * watched (10 seconds, or to the end) or exported — never before. It names the two strategic directions that are
 * still untested, and for a one-off buyer leads to the plans.
 */
function Continuation({ v }: { v: View }) {
  const selected = v.project.selectedConceptId;
  const rest = v.concepts.filter((c) => c.id !== selected).slice(0, 2);
  const subscriber = v.project.kind === 'creative_test';
  const slug = v.access.workspaceSlug;
  if (!rest.length) return subscriber ? null : <LinkButton href="/app/plan">See plans</LinkButton>;
  return (
    <section className="ak-panel ak-stack" aria-labelledby="continuation" style={{ gap: 12 }}>
      <h2 className="ak-label" id="continuation">
        {rest.length === 1 ? 'One more direction' : `${rest.length} more directions`} for {v.sku.name} {rest.length === 1 ? 'is' : 'are'} ready to test
      </h2>
      <ul className="ak-stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
        {rest.map((c) => (
          <li key={c.id} className="ak-row" style={{ alignItems: 'baseline', gap: 12 }}>
            <span className="ak-index">{c.idx}</span>
            <span>
              <span className="ak-serif">“{(c.hookOptions ?? [])[0] ?? c.hypothesis}”</span>
              <span className="ak-small ak-muted" style={{ display: 'block' }}>Tests {String(c.primaryVariable)} · {String(c.angle).replace(/_/g, ' ').toLowerCase()}</span>
            </span>
          </li>
        ))}
      </ul>
      {subscriber ? (
        slug ? <LinkButton href={`/w/${slug}/this-week`} variant="secondary">Test the next one</LinkButton> : null
      ) : (
        <>
          <p className="ak-small ak-muted" style={{ margin: 0 }}>This ad tests one of three bets. A plan tests the others, every month — {v.upsell.growthTestsPerMonth} tests a month on {v.upsell.growthName}.</p>
          <LinkButton href="/app/plan?plan=GROWTH">See plans</LinkButton>
        </>
      )}
    </section>
  );
}

/** Watched for 10 seconds (or to the end) or exported: the moment the continuation may be shown (plan 03 P10 #4). */
const CONTINUE_AFTER_S = 10;

export function DeliverFlow({ projectId }: { projectId: string }) {
  // Kept live only while the offer's bonus hook is still being made.
  const { data: v, error } = useProject(projectId, useCallback((x: View | null) => !!x?.bonus.pending, []));
  const after = useShowAfterPlay();
  const [earned, setEarned] = useState(false);
  const earn = useCallback(() => {
    setEarned(true);
    try {
      localStorage.setItem(`ak-watched-${projectId}`, '1');
    } catch {
      /* storage blocked: shown again after the next watch */
    }
  }, [projectId]);
  // Already watched on an earlier visit (this browser): no need to watch again.
  useEffect(() => {
    try {
      if (localStorage.getItem(`ak-watched-${projectId}`)) setEarned(true);
    } catch {
      /* ignore */
    }
  }, [projectId]);
  const onProgress = useCallback((sec: number, ended: boolean) => {
    if (ended || sec >= CONTINUE_AFTER_S) earn();
  }, [earn]);
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
        <div className="ak-well ak-well--916">{primary ? <WatchedVideo projectId={projectId} assetId={primary.assetId} src={primary.url} onPlaying={after.onPlaying} onBlocked={after.reveal} onProgress={onProgress} /> : null}</div>
        <div className="ak-stack">
          <FactUpdate projectId={projectId} update={v.project.factUpdate} />
          <div className="ak-stack ak-after-play" data-show={after.show || !primary}>
            <h2 className="ak-label">Download</h2>
            {v.exports.map((e, i) => (
              <DownloadLink key={e.assetId} id={i === 0 ? 'cta' : undefined} className="ak-index-row" href={e.download} filename={fileName(e.download)} onDownload={earn}>
                <span>{ASPECT[e.aspect] ?? e.aspect}</span>
                <span className="ak-index">MP4 ↓</span>
              </DownloadLink>
            ))}
            {v.exports.length > 1 ? (
              <a className="ak-index-row" href={`/api/projects/${projectId}/download-all`} download onClick={earn}>
                <span>Download all{v.bonus.exports.length ? ' (with the bonus hook)' : ''}</span>
                <span className="ak-index">ZIP ↓</span>
              </a>
            ) : null}
            {v.bonus.exports.length || v.bonus.pending || v.bonus.failed ? (
              <>
                <h2 className="ak-label">Bonus · alternate opening hook</h2>
                {v.bonus.exports.length ? (
                  v.bonus.exports.map((e) => (
                    <DownloadLink key={e.assetId} className="ak-index-row" href={e.download} filename={fileName(e.download)} onDownload={earn}>
                      <span>{ASPECT[e.aspect] ?? e.aspect} · new first line</span>
                      <span className="ak-index">MP4 ↓</span>
                    </DownloadLink>
                  ))
                ) : v.bonus.failed ? (
                  <p className="ak-small ak-muted">We couldn’t make this one automatically. Our team has been told and will send it to you.</p>
                ) : (
                  <p className="ak-small ak-muted">Being made now: the same ad with a different opening line. It appears here in a few minutes.</p>
                )}
              </>
            ) : null}
            {qa.length ? (
              <p className="ak-small" style={{ margin: 0 }}>
                {qa.slice(0, 2).map((c, i) => (
                  <span key={c.label}>{i ? ' · ' : ''}{c.label} <span aria-hidden>{c.ok ? '✓' : '•'}</span><span className="ak-sr">{c.ok ? ' passed' : ' flagged and reviewed'}</span></span>
                ))}
              </p>
            ) : null}
            {qa.length ? (
              <details>
                <summary className="ak-small">What we checked</summary>
                <ul className="ak-small">
                  {qa.map((c) => (
                    <li key={c.label}>
                      {/* The state is said in words, not only by the mark (a flagged check was reviewed before delivery). */}
                      {c.label} <span aria-hidden>{c.ok ? '✓' : '•'}</span> <span className={c.ok ? 'ak-sr' : 'ak-muted'}>{c.ok ? 'Passed' : 'Flagged and reviewed'}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <AiDisclosureSteps disclosure={v.disclosure} />
            <hr className="ak-rule" />
            <h2 className="ak-label">What to do next</h2>
            <ol className="ak-small">
              <li>Upload the 9:16 file to TikTok or Reels as a new ad.</li>
              <li>Run it for 5–7 days alongside your current best ad.</li>
              <li>{slug ? <a href={`/w/${slug}/settings/integrations`}>Connect your ad account</a> : 'Connect your ad account'} and we’ll tell you what it taught you.</li>
            </ol>
            {slug ? <LinkButton href={`/w/${slug}/this-week`} variant="secondary">Go to your archive</LinkButton> : null}
            <NotRight projectId={projectId} v={v} />
            {earned || !primary ? <Continuation v={v} /> : null}
            {primary ? (
              <StickyCta watchId="cta" mobileOnly>
                <DownloadLink className="ak-btn ak-btn--block" href={primary.download} filename={fileName(primary.download)} onDownload={earn}>Download · {ASPECT[primary.aspect] ?? primary.aspect}</DownloadLink>
              </StickyCta>
            ) : null}
            <PasskeyPrompt v={v} />
          </div>
        </div>
      </div>
    </Shell>
  );
}
