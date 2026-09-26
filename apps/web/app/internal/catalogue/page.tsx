import type { ReactNode } from 'react';
import { Banner, Button, catalogueNo, ClaimChip, CLAIM_CHIP, Empty, ExampleAsset, Field, IndexRow, Input, LinkButton, MetadataTable, Rail, Select, SignalChip, SpecimenCard, Stamp, Textarea, VideoThumb } from '@arkiv/ui';
import { catalogueTheme } from '@/lib/catalogue';
import { CatalogueFrame, LedgerDemo, LockDemo, OfferDemo, ProvenanceDemo, SheetDemo, StickyDemo, ToastDemo } from './demos';

/** A drawn stand-in product (no network, no merchant imagery): a serum bottle on transparent ground. */
const BOTTLE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 200"><rect x="66" y="18" width="28" height="30" rx="3" fill="#2b2926"/><rect x="58" y="46" width="44" height="12" rx="2" fill="#6b6761"/><rect x="48" y="56" width="64" height="126" rx="8" fill="#d9cbb8"/><rect x="58" y="96" width="44" height="40" fill="#f5f2ec"/><text x="80" y="121" font-family="monospace" font-size="9" text-anchor="middle" fill="#1a1917">No. 003</text></svg>',
)}`;
const FRAME = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 160"><rect width="90" height="160" fill="#c9b9a3"/><rect x="0" y="110" width="90" height="50" fill="#e9e2d6"/><rect x="36" y="62" width="18" height="52" rx="3" fill="#d9cbb8"/><rect x="40" y="52" width="10" height="12" fill="#2b2926"/></svg>',
)}`;

const TOKENS = ['paper', 'paper-raised', 'paper-sunk', 'ink', 'ink-2', 'stone', 'stone-text', 'rule', 'rule-strong', 'rule-input', 'accent', 'accent-ink', 'signal-gathering', 'signal-directional', 'signal-actionable', 'risk', 'risk-soft'];

function Section({ no, id, title, children }: { no: number; id: string; title: string; children: ReactNode }) {
  return (
    <section className="ak-section" style={{ paddingTop: 32, paddingBottom: 32 }} data-catalogue-section={id} aria-labelledby={`cat-${id}`}>
      <div className="ak-index-row" style={{ marginBottom: 20 }}>
        <span className="ak-index">{catalogueNo(no)}</span>
        <h2 className="ak-h2" id={`cat-${id}`}>{title}</h2>
        <span className="ak-index">{id}</span>
      </div>
      {children}
    </section>
  );
}

/**
 * Design-system catalogue (design §3): every component of packages/ui in each state, laid out as an arkiv
 * index. `?theme=light|dark` pins the theme (the visual regression suite screenshots each section per theme).
 */
export default async function Catalogue({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  const theme = catalogueTheme((await searchParams).theme);
  let n = 0;
  const no = () => ++n;
  return (
    <CatalogueFrame initial={theme}>
      <main className="ak-wrap">
        <header className="ak-section" style={{ paddingBottom: 16 }}>
          <p className="ak-index">Arkiv · design system</p>
          <h1 className="ak-display">The catalogue</h1>
          <p className="ak-muted" style={{ maxWidth: 640 }}>
            Every component in <span className="ak-mono">packages/ui</span>, in every state. Motion follows the reduced-motion setting: translations,
            scales and clip reveals become 120ms fades and the Gathering pulse stops.
          </p>
          <div id="catalogue-top" />
        </header>

        <Section no={no()} id="tokens" title="Colour tokens">
          <div className="ak-grid-12">
            {TOKENS.map((t) => (
              <div key={t} className="ak-span-3" style={{ display: 'grid', gap: 6 }}>
                <span style={{ display: 'block', height: 40, background: `var(--${t})`, border: '1px solid var(--rule)' }} aria-hidden />
                <span className="ak-index">--{t}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section no={no()} id="type" title="Type scale">
          <div className="ak-stack">
            <p className="ak-display-xl">Your product, catalogued.</p>
            <p className="ak-display">Three ideas, one archive.</p>
            <p className="ak-h1">Heading one · Sans 500</p>
            <p className="ak-h2">Heading two · Sans 500</p>
            <p className="ak-body-l" style={{ margin: 0 }}>Body large — marketing copy at 17px.</p>
            <p style={{ margin: 0 }}>Body — app copy at 15px, with <strong>strong at 500</strong>.</p>
            <p className="ak-small" style={{ margin: 0 }}>Small — 13px notes and captions.</p>
            <p className="ak-label">Label · mono 11 uppercase</p>
            <p className="ak-index">No. 014 · index mono 11</p>
            <p className="ak-price">$19</p>
          </div>
        </Section>

        <Section no={no()} id="buttons" title="Buttons">
          <div className="ak-row" style={{ flexWrap: 'wrap' }}>
            <Button>Primary</Button>
            <Button variant="accent">Accent (marketing CTA)</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="danger">Delete</Button>
            <Button size="sm">Small</Button>
            <Button disabled>Disabled</Button>
            <LinkButton href="#buttons" variant="secondary">Link button</LinkButton>
            <button type="button" className="ak-textbtn">Text button</button>
            <LockDemo />
          </div>
          <div style={{ marginTop: 16, maxWidth: 360 }}><Button block>Block</Button></div>
        </Section>

        <Section no={no()} id="inputs" title="Inputs">
          <div className="ak-grid-2">
            <div className="ak-stack">
              <Field label="Work email" hint="We send a sign-in link."><Input type="email" defaultValue="maya@serum.example" /></Field>
              <Field label="Size" error="Tell us the size as printed, e.g. 30 ml."><Input defaultValue="" /></Field>
            </div>
            <div className="ak-stack">
              <Field label="Category"><Select defaultValue="serum"><option value="serum">Serum</option><option value="cleanser">Cleanser</option></Select></Field>
              <Field label="Spoken line"><Textarea defaultValue="Skin feels soft and looks dewy." /></Field>
              <label className="ak-check"><input type="checkbox" defaultChecked /> Email me once when it’s ready.</label>
            </div>
          </div>
        </Section>

        <Section no={no()} id="index-rows" title="Index rows">
          <IndexRow index="No. 001" title="Barrier Serum" meta="30 ml · 3 tests" href="#index-rows" />
          <IndexRow index="No. 002" title="Gel Cleanser" meta="150 ml · 1 test" />
        </Section>

        <Section no={no()} id="specimens" title="Specimen card · video thumbnail">
          <div className="ak-grid-12">
            <div className="ak-span-4"><SpecimenCard index="No. 003" title="Barrier Serum" meta={[['Size', '30 ml'], ['Texture', 'Gel'], ['Tests', '3']]} image={{ src: BOTTLE, alt: 'Barrier Serum' }} href="#specimens" /></div>
            <div className="ak-span-4"><SpecimenCard index="No. 004" title="Awaiting a photo" meta={[['Status', 'Analysing']]} /></div>
            <div className="ak-span-3"><VideoThumb poster={FRAME} caption="No. 014 · Texture-first · 15s · 9:16" /></div>
          </div>
        </Section>

        <Section no={no()} id="metadata" title="Metadata table">
          <div className="ak-grid-2">
            <MetadataTable indexed rows={[{ label: 'Name', value: 'Barrier Serum' }, { label: 'Size', value: '30 ml', key: 'size' }, { label: 'Price', value: '$38.00' }]} newKeys={new Set(['size'])} />
            <dl className="ak-meta">
              <dt>Tests</dt><dd>Hook</dd>
              <dt>Angle</dt><dd>Texture first</dd>
              <dt>You’ll learn</dt><dd>Whether texture beats a routine demo.</dd>
            </dl>
          </div>
        </Section>

        <Section no={no()} id="chips" title="Provenance, signal and claim chips">
          <div className="ak-stack">
            <ProvenanceDemo />
            <div className="ak-row" style={{ flexWrap: 'wrap' }}>
              {['GATHERING_SIGNAL', 'DIRECTIONAL', 'ACTIONABLE', 'WEAKENING', 'INVALIDATED', 'INCONCLUSIVE'].map((s) => <SignalChip key={s} state={s} />)}
            </div>
            <div className="ak-row" style={{ flexWrap: 'wrap' }}>
              {Object.keys(CLAIM_CHIP).map((s) => <ClaimChip key={s} status={s} />)}
            </div>
          </div>
        </Section>

        <Section no={no()} id="rail" title="Rail">
          <div className="ak-stack">{([1, 2, 3, 4] as const).map((s) => <Rail key={s} step={s} />)}</div>
        </Section>

        <Section no={no()} id="ledger" title="Progress ledger">
          <div style={{ maxWidth: 560 }}><LedgerDemo /></div>
        </Section>

        <Section no={no()} id="banners" title="Banners · empty state · stamp">
          <div className="ak-stack">
            <Banner>Queued: a production partner is busy. Your place is held.</Banner>
            <Banner tone="warn">Your page and photos disagree on Size. Tell us which is right.</Banner>
            <Banner tone="risk">We couldn’t finish this ad. You haven’t been charged.</Banner>
            <Empty title="Nothing archived yet." body="Your first test will appear here, numbered No. 001." action={<LinkButton href="#banners" variant="secondary">Add a product</LinkButton>} />
            <div className="ak-row"><Stamp>No. 001</Stamp><span className="ak-index">23 Sep 2026</span></div>
          </div>
        </Section>

        <Section no={no()} id="offer" title="Offer timer">
          <OfferDemo />
        </Section>

        <Section no={no()} id="sheets" title="Sheet · confirmation · toast">
          <div className="ak-stack">
            <SheetDemo />
            <ToastDemo />
            <StickyDemo />
          </div>
        </Section>

        <Section no={no()} id="upload" title="Upload well">
          <div className="ak-grid-12">
            {(['idle', 'drag', 'busy'] as const).map((s) => (
              <div key={s} className="ak-span-4 ak-upload" data-state={s}>
                <p className="ak-upload-title">Your product, catalogued.</p>
                <span className="ak-index">data-state={s}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section no={no()} id="frames" title="Storyboard frames">
          <div className="ak-scroll-row" role="list" style={{ maxWidth: 520 }}>
            {[true, false].map((locked, i) => (
              <figure key={i} className="ak-frame" role="listitem" data-locked={locked}>
                <div className="ak-well ak-well--916"><img src={FRAME} alt={`Scene ${i + 1}`} /></div>
                <figcaption className="ak-small">
                  <span className="ak-index">{String(i + 1).padStart(2, '0')} · Hook · 2.5s</span>
                  <p style={{ fontWeight: 500 }}>Glass skin in one step</p>
                  <p className="ak-muted">“Skin feels soft and looks dewy.”</p>
                  <span className="ak-index">{locked ? 'Locked: 1px ink inner rule' : 'Unlocked'}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </Section>

        <Section no={no()} id="dense-table" title="Dense table (admin)">
          <div className="ak-dense ak-scroll-x">
            <table className="ak-table">
              <thead><tr><th>Code</th><th>Hook</th><th>State</th></tr></thead>
              <tbody>
                <tr><td className="ak-mono">A1</td><td>Texture first</td><td><SignalChip state="ACTIONABLE" /></td></tr>
                <tr><td className="ak-mono">B2</td><td>Routine demo</td><td><SignalChip state="DIRECTIONAL" /></td></tr>
              </tbody>
            </table>
          </div>
        </Section>

        <Section no={no()} id="example-asset" title="Example asset">
          <div style={{ maxWidth: 220 }}><ExampleAsset src={FRAME} caption="Example, made for a demo product" /></div>
        </Section>
      </main>
    </CatalogueFrame>
  );
}
