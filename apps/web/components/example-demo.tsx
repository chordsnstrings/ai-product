import { EXAMPLE_INPUT, EXAMPLE_LABEL, EXAMPLE_LOOP, type BuiltInExample } from '@/lib/examples';

/**
 * The hero's input → output demo (standard §8 "visually demonstrate input-to-output immediately"; plan 03 P1): the
 * demo product's photo, an arrow, and the finished ad of this page's archetype — small enough to sit above the fold
 * on a phone. On desktop (≥900px) a muted, looping example plays beside it. Labelled as an example (L13).
 */
export function ExampleDemo({ example }: { example: BuiltInExample }) {
  return (
    <figure className="ak-demo" style={{ margin: 0 }} aria-label={`${EXAMPLE_LABEL}: a product photo becomes a finished ad`}>
      <div className="ak-demo-row">
        <div className="ak-demo-cell">
          <div className="ak-well" style={{ aspectRatio: '4 / 5' }}>
            <img src={EXAMPLE_INPUT} alt="A plain photo of a demo serum bottle" width={108} height={135} />
          </div>
          <span className="ak-index">Your photo</span>
        </div>
        <span className="ak-demo-arrow" aria-hidden>→</span>
        <div className="ak-demo-cell">
          <div className="ak-well ak-well--916" style={{ position: 'relative' }}>
            <img src={example.src} alt={`A finished ${example.caption.toLowerCase()} ad for the demo serum`} width={108} height={192} />
            <span className="ak-chip" style={{ position: 'absolute', top: 6, left: 6, background: 'var(--paper-raised)' }}>Example</span>
          </div>
          <span className="ak-index">Your ad · {example.caption}</span>
        </div>
        <div className="ak-demo-cell ak-demo-loop">
          <div className="ak-well ak-well--916" style={{ position: 'relative' }}>
            <video src={EXAMPLE_LOOP} poster={example.src} muted loop autoPlay playsInline preload="none" aria-label="Looping examples of finished ads for the demo serum" />
            <span className="ak-chip" style={{ position: 'absolute', top: 6, left: 6, background: 'var(--paper-raised)' }}>Example</span>
          </div>
          <span className="ak-index">More formats</span>
        </div>
      </div>
      <figcaption className="ak-small ak-muted">{EXAMPLE_LABEL}.</figcaption>
      <style>{`
        .ak-demo-row { display: flex; align-items: center; gap: 12px; }
        .ak-demo-cell { display: flex; flex-direction: column; gap: 4px; width: 108px; }
        .ak-demo-cell img, .ak-demo-cell video { width: 100%; height: 100%; object-fit: cover; display: block; }
        .ak-demo-arrow { font-size: 20px; color: var(--stone-text); }
        .ak-demo-loop { display: none; }
        @media (min-width: 900px) { .ak-demo-cell { width: 132px; } .ak-demo-loop { display: flex; } }
        @media (prefers-reduced-motion: reduce) { .ak-demo-loop { display: none !important; } }
      `}</style>
    </figure>
  );
}
