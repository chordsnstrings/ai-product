import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, probe, withTempDir } from './ffmpeg';
import { ASPECT_SIZE, captionOverlay, endCard, type Aspect } from './render';

const FPS = 30;
const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Still image → clip with a slow push-in (or static), sized to the aspect. */
export async function stillToClip(
  png: string,
  durationMs: number,
  aspect: Aspect,
  out: string,
  motion: 'push' | 'none' = 'push',
): Promise<void> {
  const { w, h } = ASPECT_SIZE[aspect];
  const frames = Math.max(1, Math.round((durationMs / 1000) * FPS));
  const fit = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2}`;
  const vf =
    motion === 'push'
      ? `${fit},zoompan=z='min(zoom+0.0006,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${FPS},format=yuv420p`
      : `${fit},scale=${w}:${h},fps=${FPS},format=yuv420p`;
  await ffmpeg(['-loop', '1', '-i', png, '-vf', vf, '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
}

/** Any video → exact aspect/size/fps/duration, audio stripped (audio is mixed at the end). */
export async function normalizeClip(input: string, durationMs: number, aspect: Aspect, out: string): Promise<void> {
  const { w, h } = ASPECT_SIZE[aspect];
  await ffmpeg([
    '-i', input,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${FPS},tpad=stop_mode=clone:stop_duration=10,format=yuv420p`,
    '-t', sec(durationMs), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out,
  ]);
}

export async function concatClips(clips: string[], out: string, dir: string): Promise<void> {
  const list = path.join(dir, `concat-${Date.now()}.txt`);
  await writeFile(list, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
}

export interface TimedOverlay {
  png: string;
  startMs: number;
  endMs: number;
}

export async function overlayTimed(video: string, overlays: TimedOverlay[], out: string): Promise<void> {
  if (!overlays.length) {
    await ffmpeg(['-i', video, '-c', 'copy', out]);
    return;
  }
  const inputs = overlays.flatMap((o) => ['-i', o.png]);
  let chain = '';
  let last = '0:v';
  overlays.forEach((o, i) => {
    const next = i === overlays.length - 1 ? 'vout' : `v${i}`;
    chain += `[${last}][${i + 1}:v]overlay=0:0:enable='between(t,${sec(o.startMs)},${sec(o.endMs)})'[${next}];`;
    last = next;
  });
  await ffmpeg([
    '-i', video, ...inputs, '-filter_complex', chain.replace(/;$/, ''), '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out,
  ]);
}

/**
 * Mix voice-over (if any) and normalize loudness to −14 LUFS (plan 06 Phase 3). Always outputs an AAC track:
 * Meta reports Reels with audio outperform silent creative (§25), and platforms expect one.
 */
export async function finalizeAudio(video: string, voiceover: string | null, durationMs: number, out: string): Promise<void> {
  const base = ['-i', video];
  const audioIn = voiceover ? ['-i', voiceover] : ['-f', 'lavfi', '-t', sec(durationMs), '-i', 'anullsrc=r=48000:cl=stereo'];
  await ffmpeg([
    ...base, ...audioIn,
    '-filter_complex', `[1:a]apad,atrim=0:${sec(durationMs)},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', sec(durationMs),
    '-movflags', '+faststart', out,
  ]);
}

/** Tone/silence audio of a given length (mock TTS and tests). */
export async function toneAudio(durationMs: number, out: string, freq = 220): Promise<void> {
  await ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${sec(durationMs)}`, '-af', 'volume=0.05', '-c:a', 'libmp3lame', '-b:a', '96k', out]);
}

/** Extract N evenly spaced frames for QA review (§25). */
export async function extractFrames(video: string, count: number, dir: string): Promise<string[]> {
  const { durationMs } = await probe(video);
  const outs: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = ((durationMs / 1000) * (i + 0.5)) / count;
    const out = path.join(dir, `frame-${i}.png`);
    await ffmpeg(['-ss', t.toFixed(3), '-i', video, '-frames:v', '1', out]);
    outs.push(out);
  }
  return outs;
}

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}
export function toSrt(cues: Cue[]): string {
  const ts = (ms: number) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.startMs)} --> ${ts(c.endMs)}\n${c.text}\n`).join('\n');
}

export interface SceneInput {
  kind: 'still' | 'video';
  file: string;
  durationMs: number;
  overlayText?: string | null;
  motion?: 'push' | 'none';
}

export interface ComposeSpec {
  scenes: SceneInput[];
  voiceover?: string | null;
  endCard?: { productName: string; cta: string; index?: string; durationMs: number } | null;
  aspects: Aspect[];
}

export interface ComposedOutput {
  aspect: Aspect;
  file: string;
  durationMs: number;
  srt: string;
}

/** Deterministic composition from scene versions (§24): same inputs → same timeline. */
export async function composeAd(spec: ComposeSpec, outDir: string): Promise<ComposedOutput[]> {
  const results: ComposedOutput[] = [];
  for (const aspect of spec.aspects) {
    await withTempDir(async (dir) => {
      const clips: string[] = [];
      const overlays: TimedOverlay[] = [];
      const cues: Cue[] = [];
      let t = 0;
      for (const [i, s] of spec.scenes.entries()) {
        const clip = path.join(dir, `scene-${i}.mp4`);
        if (s.kind === 'still') await stillToClip(s.file, s.durationMs, aspect, clip, s.motion ?? 'push');
        else await normalizeClip(s.file, s.durationMs, aspect, clip);
        clips.push(clip);
        if (s.overlayText) {
          const png = path.join(dir, `ov-${i}.png`);
          await writeFile(png, await captionOverlay(s.overlayText, aspect, { position: i === 0 ? 'upper' : 'lower' }));
          overlays.push({ png, startMs: t, endMs: t + s.durationMs });
          cues.push({ startMs: t, endMs: t + s.durationMs, text: s.overlayText });
        }
        t += s.durationMs;
      }
      if (spec.endCard) {
        const png = path.join(dir, 'end.png');
        await writeFile(png, await endCard({ ...spec.endCard, aspect }));
        const clip = path.join(dir, 'end.mp4');
        await stillToClip(png, spec.endCard.durationMs, aspect, clip, 'none');
        clips.push(clip);
        t += spec.endCard.durationMs;
      }
      const joined = path.join(dir, 'joined.mp4');
      await concatClips(clips, joined, dir);
      const withOv = path.join(dir, 'overlaid.mp4');
      await overlayTimed(joined, overlays, withOv);
      const out = path.join(outDir, `final-${aspect}.mp4`);
      await finalizeAudio(withOv, spec.voiceover ?? null, t, out);
      results.push({ aspect, file: out, durationMs: t, srt: toSrt(cues) });
    });
  }
  return results;
}

export async function readBytes(file: string): Promise<Buffer> {
  return readFile(file);
}
