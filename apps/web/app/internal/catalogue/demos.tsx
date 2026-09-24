'use client';

import { useState, type ReactNode } from 'react';
import { Button, LockButton, type LedgerStep } from '@arkiv/ui';
import { confirmSheet, ConfirmHost, LiveLedger, OfferExpiry, ProvenanceChip, Sheet, StickyCta, ThemeScope, toast, Toaster } from '@arkiv/ui/client';

type Theme = 'light' | 'dark' | null;

/** The catalogue's light/dark switch: a theme scope around every specimen (portals included). */
export function CatalogueFrame({ initial, children }: { initial: Theme; children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const body = (
    <>
      <fieldset className="ak-wrap" style={{ border: 0, paddingTop: 16, paddingBottom: 0 }} data-catalogue-chrome>
        <legend className="ak-sr">Theme</legend>
        <div className="ak-row" style={{ flexWrap: 'wrap' }}>
          {([[null, 'System'], ['light', 'Paper (light)'], ['dark', 'Ink (dark)']] as const).map(([k, label]) => (
            <label key={label} className="ak-check" style={{ alignItems: 'center' }}>
              <input type="radio" name="catalogue-theme" checked={theme === k} onChange={() => setTheme(k)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {children}
      <ConfirmHost />
      <Toaster />
    </>
  );
  return theme ? <ThemeScope theme={theme}>{body}</ThemeScope> : <div style={{ background: 'var(--paper)', minHeight: '100vh' }}>{body}</div>;
}

export function ProvenanceDemo() {
  return (
    <div className="ak-row" style={{ flexWrap: 'wrap' }}>
      <ProvenanceChip state="OBSERVED" source="product_page" at="2026-09-23T18:02:00Z" />
      <ProvenanceChip state="INFERRED" source="photo_ocr" at="2026-09-23T18:02:00Z" />
      <ProvenanceChip state="DECIDED" source="merchant" at="2026-09-23T18:04:00Z" />
    </div>
  );
}

const STEPS: LedgerStep[] = [
  { key: 'prep', label: 'Preparing your product', status: 'done', at: '2026-09-23T18:02:04Z' },
  { key: 'scenes', label: 'Creating scenes', status: 'done', at: '2026-09-23T18:03:41Z' },
  { key: 'accuracy', label: 'Checking accuracy', status: 'active', note: 'Comparing each scene with your packaging' },
  { key: 'claims', label: 'Checking claims', status: 'failed', detail: 'One line needs changing' },
  { key: 'voice', label: 'Voice & captions', status: 'skipped' },
  { key: 'platforms', label: 'Platform versions', status: 'pending' },
];

export function LedgerDemo() {
  const [steps, setSteps] = useState(STEPS);
  return (
    <div className="ak-stack">
      <LiveLedger steps={steps} />
      <div>
        <button type="button" className="ak-textbtn" onClick={() => setSteps((s) => s.map((x) => (x.key === 'accuracy' ? { ...x, status: 'done', at: '2026-09-23T18:05:12Z', note: null } : x)))}>
          Complete “Checking accuracy”
        </button>
      </div>
    </div>
  );
}

export function OfferDemo() {
  // A fixed 45-minute window from "now": the digits tick, so visual tests mask this specimen.
  const [now] = useState(() => new Date().toISOString());
  const [expires] = useState(() => new Date(Date.now() + 45 * 60_000).toISOString());
  return (
    <span data-catalogue-volatile>
      <OfferExpiry expiresAt={expires} serverNow={now} />
    </span>
  );
}

export function SheetDemo() {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <div className="ak-row" style={{ flexWrap: 'wrap' }}>
      <Button variant="secondary" onClick={() => setOpen(true)}>Open a sheet</Button>
      <Button
        variant="secondary"
        onClick={async () => {
          const r = await confirmSheet({ title: 'Remove this file?', body: 'It disappears from Arkiv.', danger: true, confirmLabel: 'Remove' });
          setSaid(r.ok ? 'Confirmed' : 'Cancelled');
        }}
      >
        Confirm (danger)
      </Button>
      <Button
        variant="secondary"
        onClick={async () => {
          const r = await confirmSheet({ title: 'Turn on this kill switch?', confirmLabel: 'Turn on', input: { label: 'Reason (recorded in the audit log)', kind: 'textarea', required: true } });
          setSaid(r.ok ? `Reason: ${r.value}` : 'Cancelled');
        }}
      >
        Confirm with a reason
      </Button>
      {said ? <span className="ak-small ak-muted" role="status">{said}</span> : null}
      <Sheet open={open} onOpenChange={setOpen} title="Edit this scene’s words" description="Bottom sheet on phones, centred panel on desktop.">
        <label className="ak-field"><span className="ak-label">Spoken line</span><textarea className="ak-textarea" defaultValue="Skin feels soft and looks dewy." /></label>
      </Sheet>
    </div>
  );
}

export function ToastDemo() {
  return <Button variant="secondary" onClick={() => toast('Saved')}>Show a toast</Button>;
}

export function LockDemo() {
  const [locked, setLocked] = useState(true);
  return <LockButton locked={locked} scene="1" onClick={() => setLocked((l) => !l)} />;
}

export function StickyDemo() {
  return (
    <div className="ak-small ak-muted">
      The sticky CTA (L19) appears once the watched CTA scrolls away; while hidden it is inert (out of the tab order).
      <StickyCta watchId="catalogue-top" mobileOnly>
        <Button block>Make my ad · $19</Button>
      </StickyCta>
    </div>
  );
}
