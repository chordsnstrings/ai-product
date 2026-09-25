import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { finalizeAudio, placeholderFrame, stillToClip, withTempDir } from '@arkiv/media';
import { qaClipContract, qaExport } from './qa';

/** §48 "Provider returns wrong duration/resolution/format": the deliverable contract, per clip and per export. */
async function clip(ms: number, aspect: '9x16' | '1x1', withAudio = false) {
  return withTempDir(async (dir) => {
    const png = path.join(dir, 'f.png');
    await writeFile(png, await placeholderFrame('contract', aspect));
    const out = path.join(dir, 'v.mp4');
    await stillToClip(png, ms, aspect, out, 'push');
    if (!withAudio) return readFile(out);
    const final = path.join(dir, 'final.mp4');
    await finalizeAudio(out, null, ms, final);
    return readFile(final);
  });
}

describe('provider clip contract', () => {
  it('accepts a clip of the requested length and shape', async () => {
    expect(await qaClipContract(await clip(5000, '9x16'), { seconds: 5, resolution: '720p', ratio: '9:16' })).toMatchObject({ check: 'platform', pass: true });
  });
  it('refuses a short clip, the wrong ratio or unreadable bytes, as hard failures', async () => {
    const short = await qaClipContract(await clip(2500, '9x16'), { seconds: 5, resolution: '720p', ratio: '9:16' });
    expect(short).toMatchObject({ pass: false, hard: true });
    expect(short.detail).toMatch(/2\.50s instead of 5s/);
    const square = await qaClipContract(await clip(5000, '1x1'), { seconds: 5, resolution: '720p', ratio: '9:16' });
    expect(square.detail).toMatch(/is not 9:16/);
    const junk = await qaClipContract(Buffer.from('not a video'), { seconds: 5, resolution: '720p', ratio: '9:16' });
    expect(junk).toMatchObject({ pass: false, hard: true, detail: expect.stringMatching(/not a readable video/) });
  });
});

describe('export contract', () => {
  it('an export of the wrong duration is a hard platform failure (never delivered)', async () => {
    await withTempDir(async (dir) => {
      const f = path.join(dir, 'x.mp4');
      await writeFile(f, await clip(3000, '9x16', true));
      const ok = await qaExport(f, '9x16', 3000);
      expect(ok.find((c) => c.check === 'platform')).toMatchObject({ pass: true });
      const wrong = await qaExport(f, '9x16', 6000);
      expect(wrong.find((c) => c.check === 'platform')).toMatchObject({ pass: false, hard: true });
    });
  });
});
