'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { LandingBlocks, LandingExperiment, LandingVariantContent } from '@arkiv/shared';
import { act } from './act';

type Variant = { key: string; weight: number; content: LandingVariantContent };
type Option = { id: string; label: string };

const ARCHETYPES = ['texture_demo', 'serum_launch', 'ugc', 'creative_fatigue', 'founder', 'general'];

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="ak-field">
      <span className="ak-label">{label}</span>
      {children}
      {hint ? <span className="ak-small ak-muted">{hint}</span> : null}
    </label>
  );
}

function Block({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <fieldset className="ak-panel" style={{ border: '1px solid var(--rule)', padding: 12, display: 'grid', gap: 10 }}>
      <legend className="ak-label" style={{ padding: '0 4px' }}>{title}</legend>
      {right ? <div>{right}</div> : null}
      {children}
    </fieldset>
  );
}

const small = { padding: '4px 10px', minHeight: 28, fontSize: 12 } as const;

/**
 * Landing page block editor (plan 05 §5): structured blocks only — hero, proof strip, how it works, example gallery,
 * FAQ, CTA — plus A/B/n variant overrides and the pre-registered primary metric. Saves a versioned draft; nothing
 * reaches visitors until it is published from the page header.
 */
export function LandingEditor(props: {
  slug: string;
  archetype: string;
  content: LandingBlocks;
  variants: Variant[];
  utmMatch: string[];
  experiment: LandingExperiment;
  /** The metric is pre-registered while a live page runs variants. */
  experimentLocked: boolean;
  testimonials: Option[];
  examples: Option[];
}) {
  const router = useRouter();
  const [b, setB] = useState<LandingBlocks>(props.content);
  const [variants, setVariants] = useState<Variant[]>(props.variants);
  const [archetype, setArchetype] = useState(props.archetype);
  const [utm, setUtm] = useState(props.utmMatch.join(', '));
  const [exp, setExp] = useState<LandingExperiment>(props.experiment);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const set = <K extends keyof LandingBlocks>(k: K, v: LandingBlocks[K]) => setB((x) => ({ ...x, [k]: v }));
  const exampleSelect = (value: string | null | undefined, onChange: (v: string | null) => void, allowNone = true) => (
    <select className="ak-input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone ? <option value="">— none —</option> : null}
      {value && !props.examples.some((o) => o.id === value) ? <option value={value}>{value.slice(0, 8)} (not an eligible example)</option> : null}
      {props.examples.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await act('lp.save', {
        slug: props.slug,
        archetype,
        content: b,
        variants,
        utmMatch: utm,
        ...(props.experimentLocked ? {} : { primaryMetric: exp.primaryMetric, minSample: exp.minSample }),
      });
      setMsg({ ok: true, text: String(r.message ?? 'Saved.') });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(false);
  }

  return (
    <div className="ak-stack" style={{ ['--stack' as string]: '12px' }}>
      <Block title="Page">
        <div className="ak-grid-2">
          <Field label="Archetype">
            <select className="ak-input" value={archetype} onChange={(e) => setArchetype(e.target.value)}>
              {[...new Set([archetype, ...ARCHETYPES])].map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
            </select>
          </Field>
          <Field label="UTM content prefixes" hint="utm_content=texture* routes to this page (comma separated)">
            <input className="ak-input" value={utm} onChange={(e) => setUtm(e.target.value)} />
          </Field>
        </div>
      </Block>

      <Block title="Hero">
        <Field label="Label"><input className="ak-input" maxLength={60} value={b.hero.label} onChange={(e) => set('hero', { ...b.hero, label: e.target.value })} /></Field>
        <Field label="Headline (echo the ad)"><input className="ak-input" maxLength={120} value={b.hero.headline} onChange={(e) => set('hero', { ...b.hero, headline: e.target.value })} /></Field>
        <Field label="Sub (one sentence, grade 6–7)"><textarea className="ak-textarea" rows={2} maxLength={240} value={b.hero.sub} onChange={(e) => set('hero', { ...b.hero, sub: e.target.value })} /></Field>
        <div className="ak-grid-2">
          <Field label="Product-archetype visual (example)">{exampleSelect(b.hero.visualAssetId, (v) => set('hero', { ...b.hero, visualAssetId: v }))}</Field>
          <Field label="Visual caption"><input className="ak-input" maxLength={60} value={b.hero.visualCaption ?? ''} onChange={(e) => set('hero', { ...b.hero, visualCaption: e.target.value })} /></Field>
        </div>
      </Block>

      <Block title="Proof strip">
        <Field label="Process proof" hint="Real and specific only: no invented numbers, logos or results."><input className="ak-input" maxLength={120} value={b.proof.text} onChange={(e) => set('proof', { ...b.proof, text: e.target.value })} /></Field>
        <label className="ak-row" style={{ gap: 6 }}>
          <input type="checkbox" checked={b.proof.liveCounter !== false} onChange={(e) => set('proof', { ...b.proof, liveCounter: e.target.checked })} />
          <span className="ak-small">Show the live “claims checked this week” counter (only above its minimum)</span>
        </label>
        <Field label="Testimonials (need a stored consent record)">
          <div className="ak-stack" style={{ ['--stack' as string]: '4px' }}>
            {props.testimonials.length ? props.testimonials.map((t) => (
              <label key={t.id} className="ak-row" style={{ gap: 6 }}>
                <input type="checkbox" checked={(b.proof.testimonialIds ?? []).includes(t.id)} onChange={(e) => {
                  const cur = b.proof.testimonialIds ?? [];
                  set('proof', { ...b.proof, testimonialIds: e.target.checked ? [...cur, t.id].slice(0, 3) : cur.filter((x) => x !== t.id) });
                }} />
                <span className="ak-small">{t.label}</span>
              </label>
            )) : <span className="ak-small ak-muted">No consented testimonials yet (add them under Offers).</span>}
          </div>
        </Field>
      </Block>

      <Block title="How it works (3–4 steps)" right={b.howItWorks.length < 4 ? <button type="button" className="ak-btn ak-btn--secondary" style={small} onClick={() => set('howItWorks', [...b.howItWorks, { title: '', body: '' }])}>Add step</button> : null}>
        {b.howItWorks.map((s, n) => (
          <div key={n} className="ak-grid-2" style={{ gridTemplateColumns: '1fr 2fr auto', alignItems: 'end' }}>
            <Field label={`Step ${n + 1}`}><input className="ak-input" maxLength={60} value={s.title} onChange={(e) => set('howItWorks', b.howItWorks.map((x, i) => (i === n ? { ...x, title: e.target.value } : x)))} /></Field>
            <Field label="Body"><input className="ak-input" maxLength={240} value={s.body} onChange={(e) => set('howItWorks', b.howItWorks.map((x, i) => (i === n ? { ...x, body: e.target.value } : x)))} /></Field>
            {b.howItWorks.length > 3 ? <button type="button" className="ak-btn ak-btn--secondary" style={small} onClick={() => set('howItWorks', b.howItWorks.filter((_, i) => i !== n))}>Remove</button> : <span />}
          </div>
        ))}
      </Block>

      <Block title="Example gallery (3–6 skincare examples, or none)" right={b.gallery.items.length < 6 && props.examples.length ? <button type="button" className="ak-btn ak-btn--secondary" style={small} onClick={() => set('gallery', { items: [...b.gallery.items, { assetId: props.examples[0]!.id, caption: 'Example, made for a demo product' }] })}>Add example</button> : null}>
        {!props.examples.length ? <p className="ak-small ak-muted" style={{ margin: 0 }}>No eligible examples: produce ads for a demo skincare product in an internal (test) workspace first.</p> : null}
        {b.gallery.items.map((g, n) => (
          <div key={n} className="ak-grid-2" style={{ gridTemplateColumns: '2fr 2fr auto', alignItems: 'end' }}>
            <Field label={`Example ${n + 1}`}>{exampleSelect(g.assetId, (v) => v && set('gallery', { items: b.gallery.items.map((x, i) => (i === n ? { ...x, assetId: v } : x)) }), false)}</Field>
            <Field label="Caption"><input className="ak-input" maxLength={60} value={g.caption} onChange={(e) => set('gallery', { items: b.gallery.items.map((x, i) => (i === n ? { ...x, caption: e.target.value } : x)) })} /></Field>
            <button type="button" className="ak-btn ak-btn--secondary" style={small} onClick={() => set('gallery', { items: b.gallery.items.filter((_, i) => i !== n) })}>Remove</button>
          </div>
        ))}
      </Block>

      <Block title="FAQ" right={b.faq.length < 8 ? <button type="button" className="ak-btn ak-btn--secondary" style={small} onClick={() => set('faq', [...b.faq, { q: '', a: '' }])}>Add question</button> : null}>
        {b.faq.map((f, n) => (
          <div key={n} className="ak-stack" style={{ ['--stack' as string]: '4px', borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
            <Field label={`Question ${n + 1}`}><input className="ak-input" maxLength={120} value={f.q} onChange={(e) => set('faq', b.faq.map((x, i) => (i === n ? { ...x, q: e.target.value } : x)))} /></Field>
            <Field label="Answer"><textarea className="ak-textarea" rows={2} maxLength={600} value={f.a} onChange={(e) => set('faq', b.faq.map((x, i) => (i === n ? { ...x, a: e.target.value } : x)))} /></Field>
            {b.faq.length > 1 ? <div><button type="button" className="ak-btn ak-btn--secondary" style={small} onClick={() => set('faq', b.faq.filter((_, i) => i !== n))}>Remove</button></div> : null}
          </div>
        ))}
      </Block>

      <Block title="CTA">
        <div className="ak-grid-2">
          <Field label="Sticky button label"><input className="ak-input" maxLength={40} value={b.cta.label} onChange={(e) => set('cta', { ...b.cta, label: e.target.value })} /></Field>
          <Field label="Micro-assurance under the upload"><input className="ak-input" maxLength={80} value={b.cta.assurance} onChange={(e) => set('cta', { ...b.cta, assurance: e.target.value })} /></Field>
        </div>
      </Block>

      <Block title="Variants (A/B/n overrides; visitors are assigned stickily by weight)" right={variants.length < 5 ? <button type="button" className="ak-btn ak-btn--secondary" style={small} onClick={() => setVariants([...variants, { key: `v${variants.length + 1}`, weight: 1, content: {} }])}>Add variant</button> : null}>
        {!variants.length ? <p className="ak-small ak-muted" style={{ margin: 0 }}>No variants: every visitor sees the blocks above (“control”).</p> : null}
        {variants.map((v, n) => {
          const upd = (c: LandingVariantContent) => setVariants(variants.map((x, i) => (i === n ? { ...x, content: c } : x)));
          const hero = v.content.hero ?? {};
          const heroField = (k: 'label' | 'headline' | 'sub', value: string) => {
            const next: Record<string, unknown> = { ...hero, [k]: value };
            if (!value) delete next[k]; // an empty override means "use the page's own"
            upd({ ...v.content, hero: next as LandingVariantContent['hero'] });
          };
          return (
            <div key={n} className="ak-stack" style={{ ['--stack' as string]: '6px', borderBottom: '1px solid var(--rule)', paddingBottom: 8 }}>
              <div className="ak-grid-2" style={{ gridTemplateColumns: '1fr 1fr auto', alignItems: 'end' }}>
                <Field label="Key"><input className="ak-input" value={v.key} onChange={(e) => setVariants(variants.map((x, i) => (i === n ? { ...x, key: e.target.value.toLowerCase() } : x)))} /></Field>
                <Field label="Weight"><input className="ak-input" type="number" min={0.01} step="any" value={v.weight} onChange={(e) => setVariants(variants.map((x, i) => (i === n ? { ...x, weight: Number(e.target.value) } : x)))} /></Field>
                <button type="button" className="ak-btn ak-btn--secondary" style={small} onClick={() => setVariants(variants.filter((_, i) => i !== n))}>Remove</button>
              </div>
              <Field label="Headline override"><input className="ak-input" maxLength={120} value={hero.headline ?? ''} onChange={(e) => heroField('headline', e.target.value)} /></Field>
              <div className="ak-grid-2">
                <Field label="Sub override"><input className="ak-input" maxLength={240} value={hero.sub ?? ''} onChange={(e) => heroField('sub', e.target.value)} /></Field>
                <Field label="Label override"><input className="ak-input" maxLength={60} value={hero.label ?? ''} onChange={(e) => heroField('label', e.target.value)} /></Field>
              </div>
              <Field label="CTA label override"><input className="ak-input" maxLength={40} value={v.content.cta?.label ?? ''} onChange={(e) => { const { label: _old, ...rest } = v.content.cta ?? {}; upd({ ...v.content, cta: e.target.value ? { ...rest, label: e.target.value } : rest }); }} /></Field>
            </div>
          );
        })}
      </Block>

      <Block title="Pre-registered primary metric">
        <div className="ak-grid-2">
          <Field label="Primary metric">
            <select className="ak-input" disabled={props.experimentLocked} value={exp.primaryMetric} onChange={(e) => setExp({ ...exp, primaryMetric: e.target.value as LandingExperiment['primaryMetric'] })}>
              <option value="upload_start">Upload-start %</option>
              <option value="taste_cvr">Taste CVR</option>
            </select>
          </Field>
          <Field label="Minimum sample per variant (visitors)">
            <input className="ak-input" type="number" min={100} step={50} disabled={props.experimentLocked} value={exp.minSample} onChange={(e) => setExp({ ...exp, minSample: Number(e.target.value) })} />
          </Field>
        </div>
        {props.experimentLocked ? <p className="ak-small ak-muted" style={{ margin: 0 }}>Locked while live variants run: the metric was registered before the test started.</p> : null}
      </Block>

      <div>
        <button type="button" className="ak-btn ak-btn--sm" disabled={busy} onClick={save}>{busy ? '…' : 'Save draft (versioned)'}</button>
        {msg ? <span role="status" className={`ak-small ${msg.ok ? 'ak-muted' : 'ak-error'}`} style={{ marginLeft: 8 }}>{msg.text}</span> : null}
      </div>
    </div>
  );
}
