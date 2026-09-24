'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@arkiv/ui/client';
import { loadTurnstile } from './turnstile';
import { usePhotoUploads } from './photo-uploads';

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
    loadTurnstile()
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

const MARKETPLACE_RE = /(^|\.)(amazon|walmart|ebay)\.[a-z.]+$/i;
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

/**
 * P2 upload (plan 04 L2/L5/L6/L19): photo or link, no account, starts immediately. Mobile camera + library are
 * first-class; the URL field uses the url keyboard; errors keep what the user entered.
 */
export function UploadModule({ page, variant, compact, turnstileSiteKey, assurance }: { page: string; variant?: string | null; compact?: boolean; turnstileSiteKey?: string | null; assurance?: string }) {
  const turnstile = useTurnstile(turnstileSiteKey);
  const [url, setUrl] = useState('');
  const uploads = usePhotoUploads(downscale);
  const [state, setState] = useState<'idle' | 'drag' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const validUrl = /^https?:\/\/[^\s.]+\.[^\s]{2,}/i.test(url.trim());
  // Upload started (standard §7): recorded once, when the first photo or a product link is added — not only when
  // the form reaches the server — so starts lost in transit still count. The server dedupes it with the submit.
  const started = useRef(false);
  const markStarted = useCallback(
    (method: 'url' | 'photos') => {
      if (started.current) return;
      started.current = true;
      fetch('/api/funnel/upload-start', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page, variant: variant ?? null, method }) }).catch(() => {});
    },
    [page, variant],
  );
  useEffect(() => {
    if (validUrl) markStarted('url');
  }, [validUrl, markStarted]);
  const addFiles = (list: FileList | null) => {
    if (!list) return;
    // Some desktop browsers report iPhone HEIC files with an empty type; the server converts them.
    const imgs = [...list].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)).slice(0, 6);
    if (!imgs.length) return setError('Choose a photo (JPG or PNG).');
    markStarted('photos');
    setError(null);
    uploads.add(imgs);
  };

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!validUrl && !uploads.items.some((i) => i.status !== 'failed')) return setError('Paste your product link or add a photo.');
    // Mirrors isMarketplaceUrl in @arkiv/core (the server checks again).
    if (validUrl && !uploads.items.length && MARKETPLACE_RE.test(hostOf(url.trim()))) return setError('Marketplace listings aren’t supported yet. Paste your own store’s product page, or upload photos.');
    setState('busy');
    setError(null);
    try {
      // Photos started uploading when they were chosen; wait for any still on their way.
      const photos = await uploads.settled();
      if (!validUrl && !photos.length) throw new Error('Add a photo we can use, or paste your product link.');
      const fd = new FormData();
      if (validUrl) fd.set('url', url.trim());
      for (const id of photos) fd.append('assetIds', id);
      fd.set('page', page);
      if (variant) fd.set('variant', variant);
      const challenge = await turnstile.token();
      if (challenge) fd.set('cf-turnstile-response', challenge);
      const r = await api<{ projectId: string }>('/api/preview', fd);
      uploads.clear();
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
          {/* Plan 03 P2: validated as the user types — a valid link shape gets a subtle ✓. */}
          {validUrl ? <span className="ak-url-ok" aria-hidden>✓</span> : null}
          <span className="ak-sr" aria-live="polite">{validUrl ? 'Link looks good' : ''}</span>
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
      {uploads.items.length > 0 && (
        <div className="ak-row" style={{ flexWrap: 'wrap' }} aria-live="polite">
          {uploads.items.map((f) => (
            <span key={f.key} className="ak-chip" title={f.error}>
              {f.name.slice(0, 18)}
              {f.status === 'uploading' ? ` · ${Math.round(f.progress * 100)}%` : f.status === 'waiting' ? ' · waiting for connection' : f.status === 'failed' ? ' · can’t use this file' : ' · ✓'}
              {' '}<button type="button" className="ak-textbtn" aria-label={`Remove ${f.name}`} onClick={() => uploads.remove(f.key)}>×</button>
            </span>
          ))}
        </div>
      )}
      {uploads.items.filter((f) => f.status === 'failed').map((f) => <p key={f.key} className="ak-error ak-small" role="alert" style={{ margin: 0 }}>{f.name}: {f.error}</p>)}
      {error && <p className="ak-error" role="alert" style={{ margin: 0 }}>{error}</p>}
      {turnstileSiteKey ? <div ref={turnstile.box} className="ak-turnstile" /> : null}
      <button type="submit" className="ak-btn ak-btn--accent ak-btn--block" disabled={state === 'busy'}>
        {state === 'busy' ? 'Starting…' : uploads.pending ? 'Uploading photos…' : 'Analyze my product — free'}
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
