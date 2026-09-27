import { cloneElement, isValidElement, useId, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { formatTime } from '@arkiv/shared/format';
import { ledgerMark, ledgerStatusWord, type LedgerStep } from './ledger';

/** Server-safe arkiv components (no client state). Client components live in client.tsx. */

type Variant = 'primary' | 'accent' | 'secondary' | 'danger';
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
const btn = (variant: Variant, block?: boolean, size?: 'sm', className?: string) =>
  cx('ak-btn', variant === 'accent' && 'ak-btn--accent', variant === 'secondary' && 'ak-btn--secondary', variant === 'danger' && 'ak-btn--danger', block && 'ak-btn--block', size === 'sm' && 'ak-btn--sm', className);

export function Button({ variant = 'primary', block, size, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; block?: boolean; size?: 'sm' }) {
  return <button {...p} className={btn(variant, block, size, className)} />;
}

export function LinkButton({ variant = 'primary', block, size, className, ...p }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; block?: boolean; size?: 'sm' }) {
  return <a {...p} className={btn(variant, block, size, className)} />;
}

export const Label = ({ children, as: As = 'p', className }: { children: ReactNode; as?: 'p' | 'span' | 'h2' | 'h3'; className?: string }) => <As className={cx('ak-label', className)} style={{ margin: 0 }}>{children}</As>;

/* ── Inputs (§3 Input): label above in mono uppercase; errors are oxide text below, wired to the control. ── */

type ControlProps = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' };

/**
 * A labelled form control. The child control gets an id, `aria-describedby` pointing at the hint and error, and
 * `aria-invalid` while there is an error — so the message is read out with the field, not just shown in red.
 */
export function Field({ label, hint, error, children, id: idProp, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactElement<ControlProps>; id?: string; className?: string }) {
  const auto = useId();
  const id = idProp ?? children.props.id ?? `f${auto}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-error` : undefined;
  const describedBy = [children.props['aria-describedby'], hintId, errId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children) ? cloneElement(children, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : children.props['aria-invalid'] }) : children;
  return (
    <div className={cx('ak-field', className)}>
      <label className="ak-label" htmlFor={id}>{label}</label>
      {control}
      {hint ? <span id={hintId} className="ak-hint">{hint}</span> : null}
      {error ? <span id={errId} className="ak-error" role="alert">{error}</span> : null}
    </div>
  );
}

/** Controls keep a 16px font so iOS doesn't zoom (§2.2). */
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx('ak-input', className)} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx('ak-textarea', className)} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx('ak-select', className)} />;

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

/**
 * Two-column metadata (§3). `newKeys` marks rows that have just arrived (M2): driven by real extraction events,
 * each one's number stamps in, a hairline draws left→right and the value types in. `indexed` numbers the rows.
 */
export function MetadataTable({ rows, newKeys, indexed }: { rows: { label: string; value: ReactNode; chip?: ReactNode; key?: string }[]; newKeys?: ReadonlySet<string>; indexed?: boolean }) {
  return (
    <table className="ak-meta">
      <tbody>
        {rows.map((r, i) => {
          const key = r.key ?? r.label;
          return (
            <tr key={key} className={newKeys?.has(key) ? 'ak-row-new' : undefined}>
              <th scope="row">
                {indexed ? <span className="ak-meta-no">{String(i + 1).padStart(2, '0')}</span> : null}
                {r.label}
              </th>
              <td>
                <span className="ak-between" style={{ alignItems: 'baseline' }}>
                  <span className="ak-meta-value">{r.value}</span>
                  {r.chip}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
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

/** §3 Claim chip: VERIFIED moss fill, QUALIFIER moss outline + ⓠ, REVIEW ochre, RESTRICTED/BLOCKED oxide, INFERRED_ONLY stone dashed. */
export const CLAIM_CHIP: Record<string, { text: string; className: string; glyph?: string }> = {
  VERIFIED: { text: 'Can use', className: 'ak-chip--ok-fill' },
  VERIFIED_WITH_QUALIFIER: { text: 'Use with qualifier', className: 'ak-chip--ok', glyph: 'ⓠ' },
  MERCHANT_REVIEW_REQUIRED: { text: 'Needs your evidence', className: 'ak-chip--warn' },
  RESTRICTED: { text: 'Compliance review', className: 'ak-chip--risk' },
  BLOCKED: { text: 'We won’t use this', className: 'ak-chip--risk' },
  INFERRED_ONLY: { text: 'Idea only', className: 'ak-chip--inf-stone' },
};

export function ClaimChip({ status }: { status: string }) {
  const c = CLAIM_CHIP[status];
  if (!c) return <span className="ak-chip">{status}</span>;
  return (
    <span className={cx('ak-chip', c.className)}>
      {c.glyph ? <span aria-hidden>{c.glyph}</span> : null}
      {c.text}
    </span>
  );
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

/**
 * Progress ledger (M11): semantic steps with a mono timestamp as each completes and a thin rule that grows
 * between steps. Each step says its status in words for screen readers; changes are announced by LiveLedger
 * (client.tsx), so the list itself is not a live region.
 */
export function Ledger({ steps }: { steps: LedgerStep[] }) {
  return (
    <ol className="ak-ledger">
      {steps.map((s) => (
        <li key={s.key} data-status={s.status}>
          <span className="ak-ledger-mark" aria-hidden>{ledgerMark(s.status)}</span>
          <span>
            {s.label}
            <span className="ak-sr"> — {ledgerStatusWord(s.status)}</span>
            {s.detail ? <span className="ak-small ak-muted" style={{ display: 'block' }}>{s.detail}</span> : null}
            {s.note && s.status === 'active' ? <span className="ak-small" style={{ display: 'block' }}>{s.note}</span> : null}
          </span>
          <span className="ak-index">{s.at ? <time dateTime={s.at}>{formatTime(s.at)}</time> : ''}</span>
          <span className="ak-ledger-rule" aria-hidden />
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
 * Specimen card (§3, §2.4): a paper-sunk 4:5 well with the product centred, then a caption block — index, title
 * and 2–3 metadata pairs. Hover scales the image 1.02 and extends the caption rule to full width.
 */
export function SpecimenCard({ index, title, meta = [], href, image, placeholder, imageClassName, onImageLoad }: {
  index?: string;
  title?: ReactNode;
  meta?: [string, ReactNode][];
  href?: string;
  image?: { src: string; alt: string } | null;
  placeholder?: ReactNode;
  imageClassName?: string;
  onImageLoad?: () => void;
}) {
  const body = (
    <>
      <div className="ak-well">
        {image ? <img src={image.src} alt={image.alt} className={imageClassName} onLoad={onImageLoad} /> : (placeholder ?? <span className="ak-index" aria-hidden>{index ?? ''}</span>)}
      </div>
      <div className="ak-specimen-caption">
        {index ? <span className="ak-index">{index}</span> : null}
        {title ? <span className="ak-specimen-title">{title}</span> : null}
        {meta.length ? (
          <dl className="ak-specimen-meta">
            {meta.slice(0, 3).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </>
  );
  return href ? <a className="ak-specimen" href={href}>{body}</a> : <figure className="ak-specimen" style={{ margin: 0 }}>{body}</figure>;
}

/** §2.4: a video thumbnail — 9:16 fixed well with the mono caption `No. 014 · Texture-first · 15s · 9:16`. */
export function videoCaption({ no, angle, seconds, aspect = '9:16' }: { no?: number | string | null; angle?: string | null; seconds?: number | null; aspect?: string }) {
  return [no != null ? catalogueNo(no) : null, angle ? angle.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : null, seconds ? `${Math.round(seconds)}s` : null, aspect].filter(Boolean).join(' · ');
}

export function VideoThumb({ src, poster, caption, href, label }: { src?: string | null; poster?: string | null; caption: string; href?: string; label?: string }) {
  const media = src ? (
    <video src={src} poster={poster ?? undefined} muted playsInline preload="metadata" aria-label={label ?? caption} />
  ) : poster ? (
    <img src={poster} alt={label ?? caption} loading="lazy" />
  ) : (
    <span className="ak-index" aria-hidden>9:16</span>
  );
  const body = (
    <>
      <div className="ak-well ak-well--916">{media}</div>
      <span className="ak-specimen-caption ak-index">{caption}</span>
    </>
  );
  return href ? <a className="ak-specimen" href={href}>{body}</a> : <figure className="ak-specimen" style={{ margin: 0 }}>{body}</figure>;
}

/**
 * Plan 04 §3/§4 enforcement: example assets are always labelled; testimonials require a consent record id
 * (FTC 16 CFR 465). There is deliberately no scarcity/"people viewing" component in this library.
 */
export function ExampleAsset({ src, caption, poster, video }: { src: string; caption: string; poster?: string; video?: boolean }) {
  // Signed URLs carry no file extension, so callers that know the media type say so.
  const isVideo = video ?? /\.mp4($|\?)/.test(src);
  return (
    <figure className="ak-specimen" style={{ margin: 0 }}>
      <div className="ak-well ak-well--916">
        {isVideo ? <video src={src} poster={poster} muted playsInline loop autoPlay preload="metadata" aria-label={caption} /> : <img src={src} alt={caption} loading="lazy" />}
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

/** A Lucide-style lock (1.5px stroke) whose shackle opens when not pressed (M8). */
export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="4" y="11" width="16" height="10" rx="1" />
      <path className="ak-lock-shackle" d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** M8 scene lock: an icon toggle (aria-pressed) — the shackle closes over 90ms and the frame gets its ink rule. */
export function LockButton({ locked, onClick, disabled, scene }: { locked: boolean; onClick: () => void; disabled?: boolean; scene?: string }) {
  // The name stays "Lock scene …"; whether it is locked is the pressed state (and the icon), not a changing label.
  return (
    <button type="button" className="ak-textbtn ak-iconbtn" aria-pressed={locked} onClick={onClick} disabled={disabled}>
      <LockIcon />
      <span>Lock<span className="ak-sr"> scene{scene ? ` ${scene}` : ''}</span></span>
    </button>
  );
}
