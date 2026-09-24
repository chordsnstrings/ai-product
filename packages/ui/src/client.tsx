'use client';

import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import * as Toast from '@radix-ui/react-toast';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDate, formatTime } from '@arkiv/shared/format';
import { Button, cx, Ledger } from './components';
import { ledgerAnnouncements, type LedgerStep } from './ledger';
import { monotonicNow, remainingMs } from './offer-clock';

/* ── Theme scope ── */

type Theme = 'light' | 'dark';
const ThemeContext = createContext<Theme | undefined>(undefined);

/**
 * A subtree with a forced theme (marketing and the funnel are light-only, design §7). Sheets, popovers and
 * dialogs portal out to <body>, so they read the scope and carry the same data-theme instead of the page's.
 */
export function ThemeScope({ theme, children, className, style }: { theme: Theme; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <ThemeContext.Provider value={theme}>
      <div data-theme={theme} className={className} style={{ background: 'var(--paper)', minHeight: '100vh', ...style }}>{children}</div>
    </ThemeContext.Provider>
  );
}
export const useThemeScope = () => useContext(ThemeContext);

/**
 * Honest urgency (plan 04 L8, design M9): renders a server-issued expiry. No reset, no acceleration, no flashing.
 * `serverNow` corrects for device clock skew (plan 03 P7 edge case).
 */
export function OfferExpiry({ expiresAt, serverNow, onExpire }: { expiresAt: string; serverNow: string; onExpire?: () => void }) {
  // When the server's `now` arrived (monotonic clock): elapsed time is measured from here, never the wall clock.
  const rendered = useRef({ serverNow, at: monotonicNow() });
  const [left, setLeft] = useState(() => remainingMs(expiresAt, serverNow));
  useEffect(() => {
    if (rendered.current.serverNow !== serverNow) rendered.current = { serverNow, at: monotonicNow() };
    const t = setInterval(() => {
      const l = remainingMs(expiresAt, serverNow, monotonicNow() - rendered.current.at);
      setLeft(l);
      if (l <= 0) {
        clearInterval(t);
        onExpire?.();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt, serverNow, onExpire]);
  if (left <= 0) return <span className="ak-timer">Intro price ended</span>;
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const digits = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const clock = formatTime(expiresAt);
  return (
    <span className="ak-timer" aria-label={`Intro price ends at ${clock}`}>
      <span>Ends {clock} · </span>
      {digits.split('').map((d, i) => (
        <span key={`${i}-${d}`} className="ak-digit" aria-hidden>
          <span>{d}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * Sticky bottom CTA that appears once the hero CTA scrolls out of view (plan 04 L19). While hidden it is inert —
 * out of the tab order and the accessibility tree — not merely moved off-screen.
 */
export function StickyCta({ watchId, children, mobileOnly }: { watchId: string; children: ReactNode; mobileOnly?: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = document.getElementById(watchId);
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setShow(!e!.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [watchId]);
  return (
    <div className={`ak-sticky${mobileOnly ? ' ak-sticky--mobile' : ''}`} data-show={show} inert={!show}>
      {children}
    </div>
  );
}

export function Sheet({ open, onOpenChange, title, children, description, theme }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; children: ReactNode; theme?: Theme }) {
  const scoped = useThemeScope();
  const t = theme ?? scoped;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ak-overlay" data-theme={t} />
        <Dialog.Content className="ak-sheet" data-theme={t}>
          <div className="ak-between" style={{ marginBottom: 12 }}>
            <Dialog.Title className="ak-h2">{title}</Dialog.Title>
            <Dialog.Close className="ak-textbtn">Close</Dialog.Close>
          </div>
          {description ? <Dialog.Description className="ak-muted" style={{ marginTop: 0 }}>{description}</Dialog.Description> : <Dialog.Description className="ak-sr">{title}</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── Confirmation sheet (replaces window.confirm / window.prompt) ── */

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: the confirm button is oxide (§2.1 --risk). */
  danger?: boolean;
  /** Ask for a value too (an audit reason, an authenticator code). */
  input?: { label: string; kind?: 'text' | 'code' | 'textarea'; required?: boolean; placeholder?: string; hint?: string };
};
export type ConfirmResult = { ok: true; value: string } | { ok: false };

let confirmHandler: ((o: ConfirmOptions) => Promise<ConfirmResult>) | null = null;

/** Where the browser's own dialogs are the only option (no ConfirmHost mounted). */
function nativeConfirm(o: ConfirmOptions): ConfirmResult {
  const text = [o.title, typeof o.body === 'string' ? o.body : null].filter(Boolean).join('\n\n');
  if (o.input) {
    const v = window.prompt(o.input.label ? `${text}\n\n${o.input.label}` : text);
    if (v === null || (o.input.required !== false && !v.trim())) return { ok: false };
    return { ok: true, value: v };
  }
  return window.confirm(text) ? { ok: true, value: '' } : { ok: false };
}

/**
 * Ask the viewer to confirm in the arkiv Sheet (bottom sheet on mobile, centred panel on desktop — §3). Resolves
 * `{ ok: false }` when dismissed. Requires a mounted <ConfirmHost />; without one it falls back to the browser.
 */
export function confirmSheet(o: ConfirmOptions): Promise<ConfirmResult> {
  if (confirmHandler) return confirmHandler(o);
  return Promise.resolve(typeof window === 'undefined' ? { ok: false } : nativeConfirm(o));
}

export function ConfirmHost() {
  const [req, setReq] = useState<{ o: ConfirmOptions; resolve: (r: ConfirmResult) => void } | null>(null);
  const [value, setValue] = useState('');
  const current = useRef(req);
  current.current = req;
  useEffect(() => {
    confirmHandler = (o) =>
      new Promise<ConfirmResult>((resolve) => {
        current.current?.resolve({ ok: false });
        setValue('');
        setReq({ o, resolve });
      });
    return () => {
      confirmHandler = null;
      current.current?.resolve({ ok: false });
    };
  }, []);
  const finish = (r: ConfirmResult) => {
    req?.resolve(r);
    setReq(null);
  };
  const o = req?.o;
  const needsValue = !!o?.input && o.input.required !== false;
  return (
    <Sheet open={!!req} onOpenChange={(open) => !open && finish({ ok: false })} title={o?.title ?? ''} description={o?.body}>
      {o ? (
        <form
          className="ak-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (needsValue && !value.trim()) return;
            finish({ ok: true, value });
          }}
        >
          {o.input ? (
            <label className="ak-field">
              <span className="ak-label">{o.input.label}</span>
              {o.input.kind === 'textarea' ? (
                <textarea className="ak-textarea" autoFocus required={needsValue} placeholder={o.input.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
              ) : (
                <input
                  className="ak-input"
                  autoFocus
                  required={needsValue}
                  placeholder={o.input.placeholder}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  {...(o.input.kind === 'code' ? { inputMode: 'numeric' as const, autoComplete: 'one-time-code', pattern: '[0-9 ]*', className: 'ak-input ak-mono' } : {})}
                />
              )}
              {o.input.hint ? <span className="ak-hint">{o.input.hint}</span> : null}
            </label>
          ) : null}
          <div className="ak-row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button type="button" variant="secondary" onClick={() => finish({ ok: false })}>{o.cancelLabel ?? 'Cancel'}</Button>
            <Button type="submit" variant={o.danger ? 'danger' : 'primary'} disabled={needsValue && !value.trim()} autoFocus={!o.input}>{o.confirmLabel ?? 'Confirm'}</Button>
          </div>
        </form>
      ) : null}
    </Sheet>
  );
}

/* ── Toast (§3): 4s, ink on paper, bottom-left desktop / top mobile; never for errors that need action ── */

let toastHandler: ((message: string) => void) | null = null;

/** Show a short confirmation ("Saved"). Errors stay inline where they happened. No-op without a <Toaster />. */
export function toast(message: string) {
  toastHandler?.(message);
}
export const useToast = () => toast;

export function Toaster() {
  const [items, setItems] = useState<{ id: number; message: string; open: boolean }[]>([]);
  const next = useRef(0);
  useEffect(() => {
    toastHandler = (message) => setItems((xs) => [...xs.slice(-2), { id: ++next.current, message, open: true }]);
    return () => {
      toastHandler = null;
    };
  }, []);
  return (
    <Toast.Provider duration={4000} swipeDirection="left" label="Notification">
      {items.map((t) => (
        <Toast.Root
          key={t.id}
          className="ak-toast"
          open={t.open}
          onOpenChange={(open) => {
            if (open) return;
            setItems((xs) => xs.map((x) => (x.id === t.id ? { ...x, open: false } : x)));
            setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 200);
          }}
        >
          <Toast.Description>{t.message}</Toast.Description>
          <Toast.Close className="ak-textbtn ak-small">Dismiss</Toast.Close>
        </Toast.Root>
      ))}
      <Toast.Viewport className="ak-toast-viewport" />
    </Toast.Provider>
  );
}

/* ── Screen-reader announcements ── */

const ANNOUNCER_ID = 'ak-announcer';
function announcerNode(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(ANNOUNCER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = ANNOUNCER_ID;
    el.className = 'ak-sr';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

/** Say something politely through the one shared live region (created on first use). */
export function announce(message: string) {
  const el = announcerNode();
  if (!el || !message) return;
  el.textContent = '';
  // A fresh text node after a tick, so the same message twice is still read.
  setTimeout(() => {
    el.textContent = message;
  }, 60);
}

/** Mounts the shared live region early (a region created at the moment of speaking may be missed). */
export function Announcer() {
  useEffect(() => {
    announcerNode();
  }, []);
  return null;
}

export function useAnnounce() {
  useEffect(() => {
    announcerNode();
  }, []);
  return announce;
}

/** The progress ledger, announcing each step's change ("Checking claims — done") as it happens. */
export function LiveLedger({ steps }: { steps: LedgerStep[] }) {
  const prev = useRef<LedgerStep[] | null>(null);
  const say = useAnnounce();
  useEffect(() => {
    const msgs = ledgerAnnouncements(prev.current, steps);
    prev.current = steps;
    if (msgs.length) say(msgs.join('. '));
  }, [steps, say]);
  return <Ledger steps={steps} />;
}

/* ── Provenance chip ── */

const PROVENANCE = { OBSERVED: ['OBS', 'ak-chip--obs', 'Observed'], INFERRED: ['INF', 'ak-chip--inf', 'Inferred by the system'], DECIDED: ['DEC', 'ak-chip--dec', 'Decided by you'] } as const;

export function provenanceText({ state, source, at }: { state: keyof typeof PROVENANCE; source?: string | null; at?: string | null }) {
  const when = at ? `${formatDate(at)} ${formatTime(at)}` : null;
  return [PROVENANCE[state][2], source ? source.replace(/_/g, ' ') : null, when].filter(Boolean).join(' · ');
}

/**
 * §15 three-state doctrine made visible (§3 Provenance chip): OBS / INF / DEC. Hover (mouse), keyboard focus or a
 * tap shows the source and time, e.g. "Observed · product page · 23 Sep 2026 14:02 ET".
 */
export function ProvenanceChip({ state, source, at }: { state: 'OBSERVED' | 'INFERRED' | 'DECIDED'; source?: string | null; at?: string | null }) {
  const [open, setOpen] = useState(false);
  const pointer = useRef<string>('');
  const theme = useThemeScope();
  const [label, cls] = PROVENANCE[state];
  const text = provenanceText({ state, source, at });
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        className={cx('ak-chip', cls)}
        aria-label={text}
        onPointerDown={(e) => {
          pointer.current = e.pointerType;
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') setOpen(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setOpen(false);
        }}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          // A mouse already opened it on hover; a click shouldn't toggle it shut under the pointer.
          if (pointer.current === 'mouse' && open) e.preventDefault();
        }}
      >
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="ak-popover" data-theme={theme} side="top" sideOffset={6} onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}>
          {text}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Poll a JSON endpoint while `active`; used for real server progress (never scripted). */
export function usePoll<T>(url: string, intervalMs: number, active: boolean): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) setError(j.error ?? 'Something went wrong');
        else {
          setData(j as T);
          setError(null);
        }
      } catch {
        if (alive) setError('Connection lost — retrying…');
      }
      if (alive && active) timer = setTimeout(run, intervalMs);
    };
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url, intervalMs, active, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, refresh };
}

/**
 * An idempotency key for one submission of a create form (standard §39): the same key while the submission is
 * being retried or clicked twice, a new one once it succeeded (`next()`).
 */
export function useSubmissionKey(): { key: () => string; next: () => void } {
  const ref = useRef<string | null>(null);
  const key = useCallback(() => (ref.current ??= newKey()), []);
  const next = useCallback(() => {
    ref.current = null;
  }, []);
  return { key, next };
}
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export async function api<T = unknown>(url: string, body?: unknown, method = 'POST', opts: { idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  // One key per submission (standard §39): a retried or doubled submit of the same create returns the first answer.
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const r = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((j as { error?: string }).error ?? 'Something went wrong') as Error & { status: number; details?: unknown };
    err.status = r.status;
    err.details = (j as { details?: unknown }).details;
    throw err;
  }
  return j as T;
}
