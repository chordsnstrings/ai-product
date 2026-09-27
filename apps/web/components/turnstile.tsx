'use client';

import { useEffect, useRef } from 'react';
import { TURNSTILE_SCRIPT } from '@/lib/turnstile';

export interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(id: string): void;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function loadTurnstile(src = TURNSTILE_SCRIPT): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing && window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = existing ?? Object.assign(document.createElement('script'), { src, async: true, defer: true });
    s.addEventListener('load', () => resolve());
    s.addEventListener('error', () => reject(new Error('turnstile script failed to load')));
    if (!existing) document.head.appendChild(s);
  });
}

/** The `{ challenge, siteKey }` a sign-in route returns past the per-IP limit (plan 03 Part C), or null. */
export function challengeOf(e: unknown): { siteKey: string | null } | null {
  const d = (e as { details?: { challenge?: boolean; siteKey?: string | null } } | null)?.details;
  return d?.challenge ? { siteKey: d.siteKey ?? null } : null;
}

/**
 * The visible human check shown after too many sign-in attempts from one network ("10 login attempts per IP per
 * 15 min, then Turnstile"). Hands its single-use token to `onToken` (null when it expires).
 */
export function HumanCheck({ siteKey, onToken }: { siteKey: string | null; onToken: (token: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  useEffect(() => {
    if (!siteKey || !box.current) return;
    let id: string | null = null;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !window.turnstile || !box.current) return;
        id = window.turnstile.render(box.current, {
          sitekey: siteKey,
          callback: (t: string) => cb.current(t),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey]);
  if (!siteKey) return <p className="ak-small ak-muted" role="status">Too many attempts from your network. Please wait 15 minutes and try again.</p>;
  return <div ref={box} className="ak-turnstile" aria-label="Security check" />;
}
