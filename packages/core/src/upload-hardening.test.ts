import { createServer, type Server } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ffmpeg, withTempDir } from '@arkiv/media';
import { validateMedia, validatePdf } from './uploads';

/**
 * Standard §48 "Malicious or malformed upload": verify type, sandbox media parsing, cap dimensions/duration/streams,
 * scan where appropriate, and store formats truthfully.
 */
async function video(args: string[], ext = 'mp4'): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const out = path.join(dir, `v.${ext}`);
    await ffmpeg([...args, out], 60_000);
    return readFile(out);
  });
}
const color = (size: string, seconds: number) => ['-f', 'lavfi', '-i', `color=c=gray:s=${size}:d=${seconds}:r=5`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
const reason = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

describe('video uploads', () => {
  it('accepts a normal MP4 and stores a QuickTime file as QuickTime', async () => {
    expect((await validateMedia(await video(color('320x568', 2)))).mime).toBe('video/mp4');
    expect((await validateMedia(await video(color('320x568', 2), 'mov'))).mime).toBe('video/quicktime');
  });

  it('refuses a video over the duration cap, over the dimension cap, with too many tracks, or unreadable', async () => {
    expect(await reason(validateMedia(await video(color('64x64', 185))))).toMatch(/up to 3 minutes/);
    expect(await reason(validateMedia(await video(color('4200x64', 1))))).toMatch(/larger than 4096 pixels/);
    const tracks = ['-f', 'lavfi', '-i', 'color=c=gray:s=64x64:d=1:r=5', ...[0, 1, 2, 3].flatMap(() => ['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono']), '-t', '1', '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-map', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
    expect(await reason(validateMedia(await video(tracks)))).toMatch(/more tracks/);
    const good = await video(color('320x568', 2));
    // A real MP4 header over garbage: the type sniffs as MP4, the parser can't read it.
    const broken = Buffer.concat([good.subarray(0, 64), Buffer.alloc(4096, 7)]);
    expect(await reason(validateMedia(broken))).toMatch(/couldn’t read that video/);
  }, 120_000);
});

describe('PDF evidence', () => {
  const pdf = (body: string, pages = 1) => Buffer.from(`%PDF-1.4\n${Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join('')}2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${body}\n%%EOF\n`, 'latin1');
  it('accepts a plain document', () => {
    expect(() => validatePdf(pdf(''))).not.toThrow();
  });
  it('refuses a damaged file, active content, and too many pages', () => {
    expect(() => validatePdf(Buffer.from('%PDF-1.4\nno end marker'))).toThrow(/damaged/);
    expect(() => validatePdf(pdf('9 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj'))).toThrow(/scripts or embedded files/);
    expect(() => validatePdf(pdf('', 301))).toThrow(/up to 300 pages/);
  });
});

describe('optional malware scan (clamd INSTREAM)', () => {
  let server: Server;
  let answer = 'stream: OK';
  let received = 0;
  beforeAll(async () => {
    server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        // Command, then length-prefixed chunks, ending with a zero length.
        if (buf.subarray(-4).readUInt32BE(0) === 0 && buf.length > 14) {
          received = buf.length;
          sock.end(`${answer}\0`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterEach(() => {
    delete process.env.CLAMAV_HOST;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const doc = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n', 'latin1');
  it('passes a clean file and rejects one clamd flags', async () => {
    process.env.CLAMAV_HOST = `127.0.0.1:${(server.address() as { port: number }).port}`;
    answer = 'stream: OK';
    expect((await validateMedia(doc)).mime).toBe('application/pdf');
    expect(received).toBeGreaterThan(doc.length);
    answer = 'stream: Eicar-Test-Signature FOUND';
    expect(await reason(validateMedia(doc))).toMatch(/flagged by our security scan/);
  });
  it('fails closed when a configured scanner is unreachable', async () => {
    process.env.CLAMAV_HOST = '127.0.0.1:1';
    await expect(validateMedia(doc)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
