'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Honest urgency (plan 04 L8, design M9): renders a server-issued expiry. No reset, no acceleration, no flashing.
 * `serverNow` corrects for device clock skew (plan 03 P7 edge case).
 */
export function OfferExpiry({ expiresAt, serverNow, onExpire }: { expiresAt: string; serverNow: string; onExpire?: () => void }) {
  const skew = useRef(new Date(serverNow).getTime() - Date.now());
  const [left, setLeft] = useState(() => new Date(expiresAt).getTime() - (Date.now() + skew.current));
  useEffect(() => {
    const t = setInterval(() => {
      const l = new Date(expiresAt).getTime() - (Date.now() + skew.current);
      setLeft(l);
      if (l <= 0) {
        clearInterval(t);
        onExpire?.();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpire]);
  if (left <= 0) return <span className="ak-timer">Intro price ended</span>;
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const digits = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const clock = new Date(expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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

/** Sticky bottom CTA that appears once the hero CTA scrolls out of view (plan 04 L19). */
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
    <div className={`ak-sticky${mobileOnly ? ' ak-sticky--mobile' : ''}`} data-show={show} aria-hidden={!show}>
      {children}
    </div>
  );
}

export function Sheet({ open, onOpenChange, title, children, description }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ak-overlay" />
        <Dialog.Content className="ak-sheet">
          <div className="ak-between" style={{ marginBottom: 12 }}>
            <Dialog.Title className="ak-h2">{title}</Dialog.Title>
            <Dialog.Close className="ak-textbtn" aria-label="Close">Close</Dialog.Close>
          </div>
          {description ? <Dialog.Description className="ak-muted" style={{ marginTop: 0 }}>{description}</Dialog.Description> : <Dialog.Description className="ak-sr">{title}</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  return { data, error, refresh: () => setTick((t) => t + 1) };
}

export async function api<T = unknown>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
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
