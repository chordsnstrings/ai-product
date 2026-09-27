'use client';

/**
 * Resumable uploads for workspace forms (plan 06 Phase 0 D7, Phase 1 D3): the file goes straight into quarantine
 * (never through our server or its request-size cap), in parts when it is large. Parts are sent a few at a time and
 * retried with backoff; while the browser is offline it waits for the connection to come back; and a reload or a
 * second try of the same file carries on from the parts already stored (the upload id is kept for this tab).
 */

type Parts = { uploadId: string; partSize: number; partCount: number; received: number[]; parts: { partNumber: number; url: string }[]; status?: string };

/** Files that go up this way (the server accepts these kinds); anything else (a CSV) is posted with the form. */
export const RESUMABLE_TYPES = /^(image\/(jpeg|png|webp|heic|heif|avif)|video\/(mp4|quicktime)|application\/pdf)$/;

const storeKey = (slug: string, f: File) => `arkiv-upload:${slug}:${f.name}:${f.size}:${f.lastModified}`;
const remember = (k: string, id: string | null) => {
  try {
    if (id) sessionStorage.setItem(k, id);
    else sessionStorage.removeItem(k);
  } catch {
    /* private mode: the upload still works, it just can't resume after a reload */
  }
};
const recall = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T };
}

const online = () =>
  typeof navigator === 'undefined' || navigator.onLine
    ? Promise.resolve()
    : new Promise<void>((resolve) => window.addEventListener('online', () => resolve(), { once: true }));

function put(url: string, blob: Blob, type: string | null, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    // A single-part upload is signed with its type; a part of a multipart upload carries none.
    if (type) x.setRequestHeader('Content-Type', type);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`upload failed (${x.status})`)));
    x.onerror = () => reject(new Error('network'));
    x.onabort = () => reject(new Error('aborted'));
    x.send(blob);
  });
}

async function withRetry(fn: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    await online();
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
    }
  }
}

/**
 * Upload `file` for a form in workspace `slug`; resolves with the upload id to send as `fileUploadId`. `onProgress`
 * gets 0..1 across the whole file (parts stored earlier count as done).
 */
export async function resumableUpload(slug: string, file: File, onProgress: (p: number) => void = () => {}): Promise<string> {
  const key = storeKey(slug, file);
  const type = file.type || 'application/octet-stream';
  let plan: Parts | null = null;
  const known = recall(key);
  if (known) {
    const r = await call<Parts & { status: string }>(`/api/w/${slug}/uploads/${known}`);
    if (r.ok && r.body.status === 'quarantined') return known; // finished earlier, not used yet
    if (r.ok && r.body.status === 'pending') plan = r.body;
  }
  if (!plan) {
    const r = await call<Parts & { error?: string }>(`/api/w/${slug}/uploads`, { method: 'POST', body: JSON.stringify({ mime: type, bytes: file.size, filename: file.name }) });
    if (!r.ok) throw new Error(r.body.error ?? 'We couldn’t start the upload.');
    plan = r.body;
    remember(key, plan.uploadId);
  }
  const p = plan;
  for (let round = 0; round < 3; round++) {
    const loaded = new Map<number, number>();
    const done = (n: number) => Math.min(p.partSize, file.size - (n - 1) * p.partSize);
    const report = () => onProgress(Math.min(1, ([...p.received].reduce((a, n) => a + done(n), 0) + [...loaded.values()].reduce((a, b) => a + b, 0)) / file.size));
    const queue = [...p.parts];
    // Three parts in flight at a time.
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let part = queue.shift(); part; part = queue.shift()) {
          const { partNumber, url } = part;
          const blob = p.partCount === 1 ? file : file.slice((partNumber - 1) * p.partSize, partNumber * p.partSize);
          await withRetry(() => put(url, blob, p.partCount === 1 ? type : null, (b) => { loaded.set(partNumber, b); report(); }));
          loaded.set(partNumber, blob.size);
          report();
        }
      }),
    );
    const c = await call<{ uploadId?: string; missing?: number[]; error?: string }>(`/api/w/${slug}/uploads/${p.uploadId}/complete`, { method: 'POST', body: '{}' });
    if (c.ok) return p.uploadId;
    if (c.status !== 409 || !c.body.missing) {
      remember(key, null);
      throw new Error(c.body.error ?? 'The upload didn’t finish. Please try again.');
    }
    // Some parts never arrived: fetch fresh URLs for just those and send them again.
    const s = await call<Parts>(`/api/w/${slug}/uploads/${p.uploadId}`);
    if (!s.ok) break;
    p.received = s.body.received;
    p.parts = s.body.parts;
  }
  throw new Error('The upload didn’t finish. Please try again.');
}

/** The form using an upload succeeded: forget it, so the same file chosen again uploads afresh. */
export function forgetUpload(slug: string, file: File) {
  remember(storeKey(slug, file), null);
}
