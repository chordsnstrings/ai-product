import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { boxInside, captionLayout, composeAd, contrastRatio, endCardLayout, finalizeAudio, mapBox, placeholderFrame, productPlacement, safeRect, stillToClip, withTempDir } from '@arkiv/media';
import { CAPTION_MAX_CPS, qaClipContract, qaExport, qaLayout, TEXT_MIN_CONTRAST } from './qa';

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

describe('safe zones and caption readability (standard §25.5: prod-23)', () => {
  const aspects = ['9x16', '4x5', '1x1'] as const;
  it('places overlays, captions and every end-card element inside each aspect’s safe zone', () => {
    for (const aspect of aspects) {
      const safe = safeRect(aspect);
      const ec = endCardLayout({ aspect, productName: 'Barrier Repair Serum with a Very Long Name Indeed', cta: 'Shop the serum', price: '$38', accent: '#F4E9DC', note: 'Results vary. Patch test before use. Not intended to diagnose, treat or cure any condition or disease.' });
      for (const el of [ec.name, ec.price, ec.cta, ec.note]) expect(boxInside(el!.box, safe)).toBe(true);
      // A light brand colour gets ink text on the CTA bar, a dark one paper: both readable.
      expect(contrastRatio(ec.cta.ink, ec.cta.plate)).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
      expect(endCardLayout({ aspect, productName: 'Serum', cta: 'Shop now', accent: '#1F3A5F' }).cta.ink).toBe('#F5F2EC');
      for (const position of ['upper', 'lower'] as const) {
        for (const style of ['overlay', 'caption'] as const) expect(boxInside(captionLayout('Absorbs in seconds, no sticky finish, layers under makeup', aspect, { position, style }).box, safe)).toBe(true);
      }
    }
  });
  it('keeps a composited product inside the safe zone of every export cropped from its frame', () => {
    for (const anchor of ['center', 'lower'] as const) {
      for (const [cw, ch] of [[200, 400], [800, 300], [300, 300]]) {
        const box = productPlacement(cw!, ch!, '9x16', { scale: 0.5, anchor });
        for (const to of aspects) expect(boxInside(mapBox(box, '9x16', to), safeRect(to))).toBe(true);
      }
    }
    // Before: a centred product 86% of the width ran under the 9:16 right-hand buttons.
    expect(boxInside({ x: 75, y: 528, w: 929, h: 864 }, safeRect('9x16'))).toBe(false);
  });
  it('fails text outside the safe zone, small or low-contrast text hard; fast captions are only reported', () => {
    const base = { lines: ['Shop now'], startMs: 0, endMs: 2000 };
    const ok = qaLayout('9x16', [{ ...captionLayout('Shop now', '9x16', { style: 'caption' }), kind: 'caption', role: 'caption', text: 'Shop now', startMs: 0, endMs: 2000 }]);
    expect(ok.every((c) => c.pass)).toBe(true);
    const under = qaLayout('9x16', [{ ...base, kind: 'end_card', role: 'cta', text: 'Shop now', box: { x: 86, y: 1700, w: 908, h: 140 }, fontSize: 49, ink: '#F5F2EC', plate: '#1A1917' }]);
    expect(under[0]).toMatchObject({ pass: false, hard: true, detail: expect.stringMatching(/Outside the 9:16 safe zone: end card cta/) });
    const small = qaLayout('9x16', [{ ...base, kind: 'caption', role: 'caption', text: 'Shop now', box: { x: 100, y: 1200, w: 300, h: 60 }, fontSize: 24, ink: '#8A857D', plate: '#ECE8E0' }]);
    expect(small[1]).toMatchObject({ pass: false, hard: true, detail: expect.stringMatching(/set at 24px.*low contrast/) });
    const fast = qaLayout('9x16', [{ ...captionLayout('A very long caption that flashes by far too fast', '9x16', { style: 'caption' }), kind: 'caption', role: 'caption', text: 'A very long caption that flashes by far too fast', startMs: 0, endMs: 1000 }]);
    expect(fast[1]).toMatchObject({ pass: false, hard: false, detail: expect.stringMatching(/characters\/s/) });
    expect(CAPTION_MAX_CPS).toBe(17);
  });
  it('the composer reports its layout and the export passes the placement checks', async () => {
    await withTempDir(async (dir) => {
      const png = path.join(dir, 'f.png');
      await writeFile(png, await placeholderFrame('layout', '9x16'));
      const [out] = await composeAd(
        {
          scenes: [{ kind: 'still', file: png, durationMs: 2500, overlayText: 'No sticky finish' }],
          captions: [{ startMs: 0, endMs: 2500, text: 'Two drops, morning and night' }],
          endCard: { productName: 'Barrier Serum', cta: 'Shop now', durationMs: 1000, price: '$38', note: 'Results vary.' },
          aspects: ['1x1'],
        },
        dir,
      );
      expect(out!.layout.map((l) => `${l.kind}:${l.role}`)).toEqual(['overlay:scene 1', 'caption:caption', 'end_card:name', 'end_card:price', 'end_card:cta', 'end_card:note']);
      const checks = await qaExport(out!.file, '1x1', 3500, out!.layout);
      expect(checks.filter((c) => c.check === 'platform')).toHaveLength(3);
      expect(checks.filter((c) => !c.pass)).toEqual([]);
    });
  });
});
