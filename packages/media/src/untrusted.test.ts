import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ffmpeg, framesAtUntrusted, probeUntrusted, sceneCutsUntrusted, withTempDir } from './index';

/**
 * The untrusted-media readers run ffmpeg/ffprobe under kernel resource limits (standard §48 "sandbox media parsing").
 * Each step is exercised directly on a real clip so a limit that is too tight for a host's ffmpeg build fails here,
 * with ffmpeg's own error, instead of silently degrading a caller (the genome reader falls back to the ad copy).
 */
describe('untrusted media readers', () => {
  it('probe, detect cuts and take stills of a normal clip under the resource limits', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'clip.mp4');
      const shot = (c: string) => ['-f', 'lavfi', '-i', `color=c=${c}:s=180x320:d=2:r=10`];
      await ffmpeg([...shot('red'), ...shot('blue'), ...shot('green'), '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], 60_000);
      const p = await probeUntrusted(file);
      expect(p.width).toBe(180);
      expect(p.durationMs).toBeGreaterThan(5500);
      expect((await sceneCutsUntrusted(file)).filter((t) => t > 0.2 && t < 5.8)).toHaveLength(2);
      expect(await framesAtUntrusted(file, [0, 1, 3], dir)).toHaveLength(3);
    });
  }, 60_000);
});
