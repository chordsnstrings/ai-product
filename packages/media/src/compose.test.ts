import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeAd, extractFrames, probe, toneAudio, withTempDir, placeholderFrame, toSrt } from './index';

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
});
