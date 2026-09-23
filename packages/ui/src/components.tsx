import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

/** Server-safe arkiv components (no client state). Client components live in client.tsx. */

type Variant = 'primary' | 'accent' | 'secondary';
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({ variant = 'primary', block, size, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; block?: boolean; size?: 'sm' }) {
  return <button {...p} className={cx('ak-btn', variant === 'accent' && 'ak-btn--accent', variant === 'secondary' && 'ak-btn--secondary', block && 'ak-btn--block', size === 'sm' && 'ak-btn--sm', className)} />;
}

export function LinkButton({ variant = 'primary', block, size, className, ...p }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; block?: boolean; size?: 'sm' }) {
  return <a {...p} className={cx('ak-btn', variant === 'accent' && 'ak-btn--accent', variant === 'secondary' && 'ak-btn--secondary', block && 'ak-btn--block', size === 'sm' && 'ak-btn--sm', className)} />;
}

export const Label = ({ children, as: As = 'p', className }: { children: ReactNode; as?: 'p' | 'span' | 'h2' | 'h3'; className?: string }) => <As className={cx('ak-label', className)} style={{ margin: 0 }}>{children}</As>;

export const catalogueNo = (n: number | string) => `No. ${String(n).padStart(3, '0')}`;

export function IndexRow({ index, title, meta, href }: { index: string; title: ReactNode; meta?: ReactNode; href?: string }) {
  const inner = (
    <>
      <span className="ak-index">{index}</span>
      <span>{title}</span>
      <span className="ak-index" style={{ textAlign: 'right' }}>{meta}</span>
    </>
  );
  return href ? <a className="ak-index-row" href={href}>{inner}</a> : <div className="ak-index-row">{inner}</div>;
}

export function MetadataTable({ rows, animate }: { rows: { label: string; value: ReactNode; chip?: ReactNode; key?: string }[]; animate?: boolean }) {
  return (
    <table className="ak-meta">
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.key ?? r.label} className={animate ? 'ak-row-in' : undefined} style={animate ? { animationDelay: `${i * 60}ms` } : undefined}>
            <th scope="row">{r.label}</th>
            <td>
              <span className="ak-between" style={{ alignItems: 'baseline' }}>
                <span>{r.value}</span>
                {r.chip}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** §15 three-state doctrine made visible. */
export function ProvenanceChip({ state, source }: { state: 'OBSERVED' | 'INFERRED' | 'DECIDED'; source?: string }) {
  const map = { OBSERVED: ['OBS', 'ak-chip--obs'], INFERRED: ['INF', 'ak-chip--inf'], DECIDED: ['DEC', 'ak-chip--dec'] } as const;
  const [t, c] = map[state];
  const title = `${state === 'OBSERVED' ? 'Observed' : state === 'INFERRED' ? 'Inferred by the system' : 'Decided by you'}${source ? ` · ${source.replace(/_/g, ' ')}` : ''}`;
  return <span className={cx('ak-chip', c)} title={title} aria-label={title}>{t}</span>;
}

export function SignalChip({ state }: { state: string }) {
  const s = state.toLowerCase().replace(/_signal$/, '').replace(/_/g, '-');
  const label = { gathering: 'Gathering signal', directional: 'Directional', actionable: 'Actionable', weakening: 'Weakening', invalidated: 'Invalidated', inconclusive: 'Inconclusive', 'operationally-confounded': 'Confounded', 'ready-to-run': 'Ready to run', producing: 'Producing', approved: 'Approved', archived: 'Archived' }[s] ?? state;
  return (
    <span className={cx('ak-chip', `ak-signal--${s}`)} style={{ borderColor: 'currentColor' }}>
      <span className="ak-dot" aria-hidden />
      {label}
    </span>
  );
}

export function ClaimChip({ status }: { status: string }) {
  const m: Record<string, [string, string]> = {
    VERIFIED: ['Can use', 'ak-chip--ok'],
    VERIFIED_WITH_QUALIFIER: ['Use with qualifier', 'ak-chip--ok'],
    MERCHANT_REVIEW_REQUIRED: ['Needs your evidence', 'ak-chip--warn'],
    RESTRICTED: ['Compliance review', 'ak-chip--risk'],
    BLOCKED: ['We won’t use this', 'ak-chip--risk'],
    INFERRED_ONLY: ['Idea only', 'ak-chip--inf'],
  };
  const [t, c] = m[status] ?? [status, ''];
  return <span className={cx('ak-chip', c)}>{t}</span>;
}

export function Rail({ step }: { step: 1 | 2 | 3 | 4 }) {
  const items = ['Product', 'Concepts', 'Storyboard', 'Your ad'];
  return (
    <ol className="ak-rail" aria-label={`Step ${step} of 4`}>
      {items.map((t, i) => (
        <li key={t} data-done={i + 1 < step} data-active={i + 1 === step} aria-current={i + 1 === step ? 'step' : undefined}>
          {String(i + 1).padStart(2, '0')} {t} {i + 1 < step ? '✓' : ''}
        </li>
      ))}
    </ol>
  );
}

export function Ledger({ steps }: { steps: { key: string; label: string; status: string; detail?: string | null; at?: string | null }[] }) {
  return (
    <ol className="ak-ledger" aria-live="polite">
      {steps.map((s) => (
        <li key={s.key} data-status={s.status}>
          <span className="ak-ledger-mark" aria-hidden>{s.status === 'done' ? '✓' : s.status === 'failed' ? '×' : s.status === 'active' ? '●' : '○'}</span>
          <span>
            {s.label}
            {s.detail ? <span className="ak-small ak-muted" style={{ display: 'block' }}>{s.detail}</span> : null}
          </span>
          <span className="ak-index">{s.at ? new Date(s.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}</span>
        </li>
      ))}
    </ol>
  );
}

export function Banner({ tone, children }: { tone?: 'risk' | 'warn'; children: ReactNode }) {
  return <div role={tone === 'risk' ? 'alert' : 'status'} className={cx('ak-banner', tone === 'risk' && 'ak-banner--risk', tone === 'warn' && 'ak-banner--warn')}>{children}</div>;
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="ak-empty">
      <p className="ak-display" style={{ fontSize: 28 }}>{title}</p>
      <p className="ak-muted" style={{ margin: 0 }}>{body}</p>
      {action}
    </div>
  );
}

/**
 * Plan 04 §3/§4 enforcement: example assets are always labelled; testimonials require a consent record id
 * (FTC 16 CFR 465). There is deliberately no scarcity/"people viewing" component in this library.
 */
export function ExampleAsset({ src, caption, poster }: { src: string; caption: string; poster?: string }) {
  return (
    <figure className="ak-specimen" style={{ margin: 0 }}>
      <div className="ak-well ak-well--916">
        {src.endsWith('.mp4') ? <video src={src} poster={poster} muted playsInline loop autoPlay preload="metadata" /> : <img src={src} alt={caption} loading="lazy" />}
        <span className="ak-chip" style={{ position: 'absolute', top: 8, left: 8, background: 'var(--paper-raised)' }}>Example</span>
      </div>
      <figcaption className="ak-specimen-caption ak-index">{caption}</figcaption>
    </figure>
  );
}

export function Testimonial({ consentId, quote, name, brand }: { consentId: string; quote: string; name: string; brand?: string }) {
  if (!consentId) throw new Error('Testimonial requires a consent record id (plan 04 §4)');
  return (
    <blockquote style={{ margin: 0 }} data-consent={consentId}>
      <p className="ak-quote">“{quote}”</p>
      <footer className="ak-label" style={{ marginTop: 8 }}>{name}{brand ? ` · ${brand}` : ''}</footer>
    </blockquote>
  );
}

export const Stamp = ({ children }: { children: ReactNode }) => <span className="ak-stamp">{children}</span>;
