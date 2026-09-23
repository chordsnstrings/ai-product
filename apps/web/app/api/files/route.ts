import { storage, verifyLocalSignature } from '@arkiv/core';
import { env } from '@arkiv/shared';

/** Local-disk storage driver only (dev/test): serves HMAC-signed, expiring URLs. Production uses Spaces presigned URLs. */
export async function GET(req: Request) {
  if (env().STORAGE_DRIVER !== 'local') return new Response('Not found', { status: 404 });
  const q = new URL(req.url).searchParams;
  const key = q.get('key') ?? '';
  if (!verifyLocalSignature(key, 'get', q.get('exp') ?? '0', q.get('sig') ?? '')) return new Response('Link expired', { status: 403 });
  let bytes: Buffer;
  try {
    bytes = await storage().get(key);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const type = sniff(bytes);
  const headers: Record<string, string> = { 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' };
  const dl = q.get('dl');
  if (dl) headers['Content-Disposition'] = `attachment; filename="${dl.replace(/[^\w.\-]/g, '_')}"`;
  const range = req.headers.get('range');
  if (range && type.startsWith('video/')) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
    return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers: { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': String(bytes.length) } });
}

function sniff(b: Buffer): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  if (b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b.subarray(0, 4).toString() === 'RIFF') return 'audio/wav';
  if (b.subarray(0, 4).toString() === 'PK\u0003\u0004') return 'application/zip';
  return 'application/octet-stream';
}
