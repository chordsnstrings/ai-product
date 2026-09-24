'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@arkiv/ui/client';
import { TURNSTILE_SCRIPT } from '@/lib/turnstile';

interface TurnstileApi {
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

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing && window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = existing ?? Object.assign(document.createElement('script'), { src, async: true, defer: true });
    s.addEventListener('load', () => resolve());
    s.addEventListener('error', () => reject(new Error('turnstile script failed to load')));
    if (!existing) document.head.appendChild(s);
  });
}

/**
 * Invisible Turnstile challenge run on submit only (plan 03 P1). Renders nothing visible unless Cloudflare
 * needs an interaction; each submit gets a fresh single-use token. A no-op when no site key is configured.
 */
function useTurnstile(siteKey: string | null | undefined) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const pending = useRef<{ resolve: (t: string) => void; reject: (e: Error) => void } | null>(null);
  useEffect(() => {
    if (!siteKey || !box.current) return;
    let cancelled = false;
    loadScript(TURNSTILE_SCRIPT)
      .then(() => {
        if (cancelled || !window.turnstile || !box.current) return;
        widget.current = window.turnstile.render(box.current, {
          sitekey: siteKey,
          execution: 'execute',
          appearance: 'interaction-only',
          callback: (token: string) => pending.current?.resolve(token),
          'error-callback': () => pending.current?.reject(new Error('We couldn’t confirm you’re human. Please try again.')),
          'expired-callback': () => widget.current && window.turnstile?.reset(widget.current),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);
  const token = useCallback(async (): Promise<string | null> => {
    if (!siteKey) return null;
    const t = window.turnstile;
    const id = widget.current;
    if (!t || !id) throw new Error('The security check is still loading — try again in a moment.');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current = null;
        reject(new Error('The security check timed out. Please try again.'));
      }, 30_000);
      pending.current = {
        resolve: (v) => {
          clearTimeout(timer);
          pending.current = null;
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          pending.current = null;
          reject(e);
        },
      };
      t.reset(id); // tokens are single-use: a fresh challenge per submit
      t.execute(id);
    });
  }, [siteKey]);
  return { box, token };
}

/**
 * P2 upload (plan 04 L2/L5/L6/L19): photo or link, no account, starts immediately. Mobile camera + library are
 * first-class; the URL field uses the url keyboard; errors keep what the user entered.
 */
export function UploadModule({ page, variant, compact, turnstileSiteKey, assurance }: { page: string; variant?: string | null; compact?: boolean; turnstileSiteKey?: string | null; assurance?: string }) {
  const turnstile = useTurnstile(turnstileSiteKey);
  const [url, setUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<'idle' | 'drag' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const validUrl = /^https?:\/\/[^\s.]+\.[^\s]{2,}/i.test(url.trim());
  const addFiles = (list: FileList | null) => {
    if (!list) return;
    // Some desktop browsers report iPhone HEIC files with an empty type; the server converts them.
    const imgs = [...list].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)).slice(0, 6);
    if (!imgs.length) return setError('Choose a photo (JPG or PNG).');
    setError(null);
    setFiles((prev) => [...prev, ...imgs].slice(0, 6));
  };

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!validUrl && !files.length) return setError('Paste your product link or add a photo.');
    setState('busy');
    setError(null);
    try {
      const fd = new FormData();
      if (validUrl) fd.set('url', url.trim());
      for (const f of files) fd.append('photos', await downscale(f));
      fd.set('page', page);
      if (variant) fd.set('variant', variant);
      const challenge = await turnstile.token();
      if (challenge) fd.set('cf-turnstile-response', challenge);
      const r = await api<{ projectId: string }>('/api/preview', fd);
      window.location.assign(`/start/${r.projectId}`);
    } catch (err) {
      setState('idle');
      setError((err as Error).message);
    }
  }

  async function pasteFromClipboard() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setUrl(t.trim());
    } catch {
      /* permission denied — user can type */
    }
  }

  return (
    <form
      id="upload"
      onSubmit={submit}
      className="ak-upload"
      data-state={state}
      onDragOver={(e) => {
        e.preventDefault();
        setState('drag');
      }}
      onDragLeave={() => setState('idle')}
      onDrop={(e) => {
        e.preventDefault();
        setState('idle');
        addFiles(e.dataTransfer.files);
      }}
      aria-busy={state === 'busy'}
    >
      {!compact && <p className="ak-upload-title">Your product, catalogued.</p>}
      <div className="ak-field">
        <label className="ak-label" htmlFor="product-url">Product link</label>
        <div className="ak-row">
          <input
            id="product-url"
            className="ak-input"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://yourstore.com/products/serum"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-describedby="upload-help"
          />
          <button type="button" className="ak-btn ak-btn--secondary ak-btn--sm" onClick={pasteFromClipboard} aria-label="Paste link from clipboard">Paste</button>
        </div>
      </div>
      <div className="ak-row" style={{ flexWrap: 'wrap' }}>
        <span className="ak-label">or</span>
        <button type="button" className="ak-btn ak-btn--secondary ak-btn--sm" onClick={() => cameraRef.current?.click()}>Take a photo</button>
        <button type="button" className="ak-btn ak-btn--secondary ak-btn--sm" onClick={() => fileRef.current?.click()}>Upload photos</button>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => addFiles(e.target.files)} />
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" multiple hidden onChange={(e) => addFiles(e.target.files)} />
      </div>
      {files.length > 0 && (
        <div className="ak-row" style={{ flexWrap: 'wrap' }}>
          {files.map((f, i) => (
            <span key={i} className="ak-chip">{f.name.slice(0, 18)} <button type="button" className="ak-textbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>
          ))}
        </div>
      )}
      {error && <p className="ak-error" role="alert" style={{ margin: 0 }}>{error}</p>}
      {turnstileSiteKey ? <div ref={turnstile.box} className="ak-turnstile" /> : null}
      <button type="submit" className="ak-btn ak-btn--accent ak-btn--block" disabled={state === 'busy'}>
        {state === 'busy' ? 'Starting…' : 'Analyze my product — free'}
      </button>
      <p id="upload-help" className="ak-small ak-muted" style={{ margin: 0 }}>{assurance || 'Free analysis · no card · about 40 seconds'}</p>
    </form>
  );
}

/** Client-side downscale keeps uploads fast on phones (L6) and under the 25 MB cap. */
async function downscale(file: File): Promise<File> {
  if (file.size < 2_500_000 || !/image\/(jpeg|png|webp)/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}
