import { storage, verifyLocalSignature } from '@arkiv/core';
import { env } from '@arkiv/shared';

/** Local driver stand-in for a presigned PUT into quarantine (validated by processUpload before use). */
export async function PUT(req: Request) {
  if (env().STORAGE_DRIVER !== 'local') return new Response('Not found', { status: 404 });
  const q = new URL(req.url).searchParams;
  const key = q.get('key') ?? '';
  if (!key.startsWith('q/') || !verifyLocalSignature(key, 'put', q.get('exp') ?? '0', q.get('sig') ?? '')) return new Response('Forbidden', { status: 403 });
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > 600 * 1024 * 1024) return new Response('Too large', { status: 413 });
  const bytes = Buffer.from(await req.arrayBuffer());
  await storage().put(key, bytes, req.headers.get('content-type') ?? 'application/octet-stream');
  return new Response(null, { status: 204 });
}
