'use client';

import { useRef, useState } from 'react';
import { api } from '@arkiv/ui/client';

/**
 * P2 upload (plan 04 L2/L5/L6/L19): photo or link, no account, starts immediately. Mobile camera + library are
 * first-class; the URL field uses the url keyboard; errors keep what the user entered.
 */
export function UploadModule({ page, variant, compact }: { page: string; variant?: string | null; compact?: boolean }) {
  const [url, setUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<'idle' | 'drag' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const validUrl = /^https?:\/\/[^\s.]+\.[^\s]{2,}/i.test(url.trim());
  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const imgs = [...list].filter((f) => f.type.startsWith('image/')).slice(0, 6);
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
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic" multiple hidden onChange={(e) => addFiles(e.target.files)} />
      </div>
      {files.length > 0 && (
        <div className="ak-row" style={{ flexWrap: 'wrap' }}>
          {files.map((f, i) => (
            <span key={i} className="ak-chip">{f.name.slice(0, 18)} <button type="button" className="ak-textbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>
          ))}
        </div>
      )}
      {error && <p className="ak-error" role="alert" style={{ margin: 0 }}>{error}</p>}
      <button type="submit" className="ak-btn ak-btn--accent ak-btn--block" disabled={state === 'busy'}>
        {state === 'busy' ? 'Starting…' : 'Analyze my product — free'}
      </button>
      <p id="upload-help" className="ak-small ak-muted" style={{ margin: 0 }}>Free analysis · no card · about 40 seconds</p>
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
