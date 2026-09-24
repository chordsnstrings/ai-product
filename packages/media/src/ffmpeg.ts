import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

export class MediaError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

function run(bin: string, args: string[], timeoutMs = 300_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new MediaError(`${bin} timed out after ${timeoutMs}ms`, stderr));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(new MediaError(`${bin} failed to start: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new MediaError(`${bin} exited with ${code}`, stderr.slice(-4000)));
    });
  });
}

export const ffmpeg = (args: string[], timeoutMs?: number) =>
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], timeoutMs);

export interface ProbeResult {
  durationMs: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  formatName: string;
  /** Container tags (lower-cased keys), e.g. comment/description. */
  tags: Record<string, string>;
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 30_000);
  const j = JSON.parse(stdout) as {
    format: { duration?: string; format_name: string; tags?: Record<string, string> };
    streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
  };
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    durationMs: Math.round(Number(j.format.duration ?? 0) * 1000),
    width: v?.width ?? null,
    height: v?.height ?? null,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    hasAudio: !!a,
    formatName: j.format.format_name,
    tags: Object.fromEntries(Object.entries(j.format.tags ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
  };
}

/** Scratch directory that is always cleaned up. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'arkiv-media-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
