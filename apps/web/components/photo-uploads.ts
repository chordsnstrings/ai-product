'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** One chosen photo on its way to quarantine and back as a validated product photo. */
export interface PhotoUpload {
  key: string;
  name: string;
  status: 'uploading' | 'waiting' | 'done' | 'failed';
  progress: number;
  assetId?: string;
  error?: string;
}

const STORE = 'arkiv.preview-uploads';
const MAX = 6;

function readStore(): { name: string; assetId: string }[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE) ?? '[]') as { name: string; assetId: string }[];
    return Array.isArray(v) ? v.filter((x) => typeof x?.assetId === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}
function writeStore(items: PhotoUpload[]) {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(items.filter((i) => i.status === 'done' && i.assetId).map((i) => ({ name: i.name, assetId: i.assetId }))));
  } catch {
    /* private mode: uploads still work, they just don't survive a reload */
  }
}

/** PUT with progress (fetch has no upload progress). Resolves on 2xx, rejects otherwise. */
function put(url: string, file: Blob, type: string, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Content-Type', type);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`upload failed (${x.status})`)));
    x.onerror = () => reject(new Error('network'));
    x.onabort = () => reject(new Error('aborted'));
    x.send(file);
  });
}

class Unusable extends Error {}

/**
 * Plan 03 P2 / plan 06 Phase 1 #3: a photo starts uploading the moment it is chosen — a presigned PUT into
 * quarantine, then validation — with per-file progress. A failed or offline upload retries by itself (a few times
 * with backoff, and again when the browser comes back online); finished photos are remembered for this tab, so a
 * reload doesn't lose them. The preview is started with the resulting asset ids.
 */
export function usePhotoUploads(prepare: (f: File) => Promise<File>) {
  const [items, setItems] = useState<PhotoUpload[]>([]);
  const files = useRef(new Map<string, File>());
  const attempts = useRef(new Map<string, number>());
  const update = useCallback((key: string, patch: Partial<PhotoUpload>) => {
    setItems((prev) => {
      const next = prev.map((i) => (i.key === key ? { ...i, ...patch } : i));
      writeStore(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const kept = readStore();
    if (kept.length) setItems(kept.map((k) => ({ key: k.assetId, name: k.name, status: 'done', progress: 1, assetId: k.assetId })));
  }, []);

  const start = useCallback(
    async (key: string) => {
      const original = files.current.get(key);
      if (!original) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return update(key, { status: 'waiting' });
      update(key, { status: 'uploading', progress: 0, error: undefined });
      try {
        const file = await prepare(original);
        const type = file.type || 'image/heic';
        const r = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ mime: type, bytes: file.size }] }) });
        const j = (await r.json()) as { uploads?: { uploadId: string; putUrl: string }[]; error?: string };
        if (!r.ok) throw r.status === 400 || r.status === 422 ? new Unusable(j.error ?? 'We can’t use that file.') : new Error(j.error ?? 'upload failed');
        const u = j.uploads![0]!;
        await put(u.putUrl, file, type, (p) => update(key, { progress: Math.min(p, 0.95) }));
        const c = await fetch(`/api/uploads/${u.uploadId}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: original.name }) });
        const cj = (await c.json()) as { assetId?: string; error?: string };
        if (c.status === 422) throw new Unusable(cj.error ?? 'We can’t use that file.');
        if (!c.ok || !cj.assetId) throw new Error(cj.error ?? 'upload failed');
        files.current.delete(key);
        update(key, { status: 'done', progress: 1, assetId: cj.assetId });
      } catch (e) {
        if (e instanceof Unusable) return update(key, { status: 'failed', error: e.message });
        const n = (attempts.current.get(key) ?? 0) + 1;
        attempts.current.set(key, n);
        if (n < 4 && navigator.onLine !== false) {
          update(key, { status: 'uploading', progress: 0 });
          setTimeout(() => void start(key), 1000 * 2 ** (n - 1));
        } else update(key, { status: 'waiting', error: 'Waiting for a connection — we’ll carry on automatically.' });
      }
    },
    [prepare, update],
  );

  // Back online: carry on with everything that was waiting.
  useEffect(() => {
    const resume = () => {
      for (const i of items) {
        if (i.status === 'waiting' && files.current.has(i.key)) {
          attempts.current.set(i.key, 0);
          void start(i.key);
        }
      }
    };
    window.addEventListener('online', resume);
    return () => window.removeEventListener('online', resume);
  }, [items, start]);

  const add = useCallback(
    (list: File[]) => {
      const room = MAX - items.length;
      for (const f of list.slice(0, Math.max(0, room))) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        files.current.set(key, f);
        setItems((prev) => [...prev, { key, name: f.name, status: 'uploading', progress: 0 }]);
        void start(key);
      }
    },
    [items.length, start],
  );

  const remove = useCallback((key: string) => {
    files.current.delete(key);
    setItems((prev) => {
      const next = prev.filter((i) => i.key !== key);
      writeStore(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    files.current.clear();
    setItems([]);
    writeStore([]);
  }, []);

  // The latest items, for waiting on uploads still in flight when the form is submitted.
  const latest = useRef(items);
  latest.current = items;
  const settled = useCallback(async (timeoutMs = 120_000): Promise<string[]> => {
    const until = Date.now() + timeoutMs;
    while (latest.current.some((i) => i.status === 'uploading' || i.status === 'waiting')) {
      if (Date.now() > until) throw new Error('Your photos are taking a while to upload. Check your connection and try again.');
      await new Promise((r) => setTimeout(r, 200));
    }
    return latest.current.filter((i) => i.status === 'done' && i.assetId).map((i) => i.assetId!);
  }, []);

  return { items, add, remove, clear, settled, pending: items.some((i) => i.status === 'uploading' || i.status === 'waiting'), assetIds: items.filter((i) => i.status === 'done' && i.assetId).map((i) => i.assetId!) };
}
