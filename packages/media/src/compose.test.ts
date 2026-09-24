import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { captionCues, composeAd, compositeProduct, extractFrames, layoutVoice, probe, productionBackdrop, scheduleVoice, toneAudio, withTempDir, placeholderFrame, toSrt } from './index';

describe('composeAd', () => {
  it('builds platform exports with exact size, duration and an audio track', async () => {
    await withTempDir(async (dir) => {
      const f1 = path.join(dir, 'a.png');
      const f2 = path.join(dir, 'b.png');
      await writeFile(f1, await placeholderFrame('Scene one', '9x16', 0));
      await writeFile(f2, await placeholderFrame('Scene two', '9x16', 1));
      const vo = path.join(dir, 'vo.mp3');
      await toneAudio(3000, vo);
      const outs = await composeAd(
        {
          scenes: [
            { kind: 'still', file: f1, durationMs: 1500, overlayText: 'Sticky serums? Not this one.' },
            { kind: 'still', file: f2, durationMs: 1000, overlayText: 'Absorbs in seconds.' },
          ],
          voiceover: vo,
          endCard: { productName: 'Serum No. 3', cta: 'Shop now', durationMs: 500 },
          aspects: ['9x16', '1x1'],
        },
        dir,
      );
      expect(outs).toHaveLength(2);
      const v = await probe(outs[0]!.file);
      expect(v.width).toBe(1080);
      expect(v.height).toBe(1920);
      expect(v.hasAudio).toBe(true);
      expect(Math.abs(v.durationMs - 3000)).toBeLessThan(150);
      const sq = await probe(outs[1]!.file);
      expect(sq.width).toBe(sq.height);
      expect(outs[0]!.srt).toContain('Absorbs in seconds.');
      const frames = await extractFrames(outs[0]!.file, 2, dir);
      expect(frames).toHaveLength(2);
    });
  }, 120_000);

  it('formats SRT timestamps', () => {
    expect(toSrt([{ startMs: 0, endMs: 1500, text: 'hi' }])).toContain('00:00:00,000 --> 00:00:01,500');
  });

  it('captions the spoken voice-over (burned in and in the SRT), not the on-screen text (plan 06 Phase 3 #6: prod-27)', async () => {
    await withTempDir(async (dir) => {
      const f1 = path.join(dir, 'a.png');
      await writeFile(f1, await placeholderFrame('Scene one', '9x16', 0));
      const line = path.join(dir, 'line.mp3');
      await toneAudio(900, line);
      const clipMs = (await probe(line)).durationMs;
      const { placed, overflowMs } = scheduleVoice([{ windowStartMs: 0, windowEndMs: 2000, clipMs }], 2500);
      expect(overflowMs).toBe(0);
      const vo = path.join(dir, 'vo.wav');
      await layoutVoice([{ file: line, startMs: placed[0]!.startMs, tempo: placed[0]!.tempo }], 2500, vo);
      expect(Math.abs((await probe(vo)).durationMs - 2500)).toBeLessThan(60);
      const captions = captionCues('Two drops. It absorbs fast.', placed[0]!.startMs, placed[0]!.endMs);
      const [out] = await composeAd(
        { scenes: [{ kind: 'still', file: f1, durationMs: 2000, overlayText: 'Absorbs in seconds' }], voiceover: vo, captions, endCard: { productName: 'Serum', cta: 'Shop now', durationMs: 500 }, aspects: ['9x16'] },
        dir,
      );
      expect(out!.srt).toContain('Two drops. It absorbs fast.');
      expect(out!.srt).not.toContain('Absorbs in seconds');
      expect((await probe(out!.file)).hasAudio).toBe(true);
    });
  }, 120_000);

  it('fits each spoken line to its scene and reports a voice-over that cannot fit', () => {
    // Fits: starts with its scene; a long line is sped up (at most 1.35x) to end inside it.
    const fit = scheduleVoice([{ windowStartMs: 0, windowEndMs: 3000, clipMs: 1500 }, { windowStartMs: 3000, windowEndMs: 5000, clipMs: 2600 }], 7000);
    expect(fit.placed[0]).toMatchObject({ startMs: 0, endMs: 1500, tempo: 1 });
    expect(fit.placed[1]!.startMs).toBe(3000);
    expect(fit.placed[1]!.tempo).toBeCloseTo(1.3, 2);
    expect(fit.placed[1]!.endMs).toBeLessThanOrEqual(5000);
    // Too long: the next line is pushed back rather than overlapping, and the overrun is measured.
    const over = scheduleVoice([{ windowStartMs: 0, windowEndMs: 1000, clipMs: 4000 }, { windowStartMs: 1000, windowEndMs: 2000, clipMs: 1000 }], 2000);
    expect(over.placed[1]!.startMs).toBeGreaterThan(over.placed[0]!.endMs);
    expect(over.overflowMs).toBeGreaterThan(0);
  });

  it('splits a spoken line into readable caption cues that cover it end to end', () => {
    const cues = captionCues('Morning and night, after cleansing, two drops on clean dry skin before moisturiser.', 1000, 5000);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.every((c) => c.text.length <= 42)).toBe(true);
    expect(cues[0]!.startMs).toBe(1000);
    expect(cues.at(-1)!.endMs).toBe(5000);
    expect(cues.map((c) => c.text).join(' ')).toBe('Morning and night, after cleansing, two drops on clean dry skin before moisturiser.');
  });
});

describe('production frames', () => {
  it('draws a clean backdrop and grounds a composited product (no debug marks: prod-02)', async () => {
    const bg = await productionBackdrop('9x16', ['#C9A27E']);
    const meta = await sharp(bg).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
    // A seamless sweep: the centre (where placeholders draw their dashed box) is the same tone as its surroundings.
    const { data, info } = await sharp(bg).extract({ left: 324, top: 576, width: 432, height: 768 }).raw().toBuffer({ resolveWithObject: true });
    const lum = (i: number) => data[i]! + data[i + 1]! + data[i + 2]!;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i += info.channels) {
      min = Math.min(min, lum(i));
      max = Math.max(max, lum(i));
    }
    expect(max - min).toBeLessThan(40);
    const cut = await sharp({ create: { width: 200, height: 400, channels: 4, background: { r: 30, g: 30, b: 30, alpha: 1 } } }).png().toBuffer();
    const out = await compositeProduct(bg, cut, '9x16', { scale: 0.5, shadow: true });
    expect((await sharp(out).metadata()).height).toBe(1920);
  });
});
