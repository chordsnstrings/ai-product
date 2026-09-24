import sharp from 'sharp';
import { keyBackground, type KeyedCutout } from '@arkiv/media';

function dist(a: number[], b: number[]) {
  return Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2);
}

/**
 * Deterministic image helpers. The product cut-out (design M3, conversion L3) starts with border-colour keying:
 * product photos are usually shot on a plain background. If keying is unreliable the original is returned framed
 * on paper rather than a damaged cut-out (product fidelity outranks spectacle); a background-removal provider
 * then gets a chance at it where the cut-out is first used (see cutout.ts).
 */
export async function cutout(input: Buffer): Promise<KeyedCutout> {
  return keyBackground(input);
}

/** Dominant colours (hex) via coarse quantization; used by the Visual Fingerprint (§16). */
export async function dominantColors(input: Buffer, k = 4): Promise<string[]> {
  const { data, info } = await sharp(input).flatten({ background: '#ffffff' }).resize(48, 48, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const counts = new Map<string, number>();
  for (let i = 0; i < info.width * info.height; i++) {
    const q = [0, 1, 2].map((c) => Math.min(255, Math.round(data[i * info.channels + c]! / 32) * 32));
    const key = q.join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([rgb]) => '#' + rgb.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join(''));
}

/** Mean colour distance between two images' palettes — a cheap, deterministic fidelity signal. */
export async function paletteDistance(a: Buffer, b: Buffer): Promise<number> {
  const [pa, pb] = await Promise.all([dominantColors(a, 3), dominantColors(b, 3)]);
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ds = pa.map((c) => Math.min(...pb.map((d) => dist(rgb(c), rgb(d)))));
  return ds.reduce((s, d) => s + d, 0) / Math.max(1, ds.length);
}

export async function toJpegBase64(input: Buffer, maxEdge = 1024): Promise<string> {
  return (await sharp(input).rotate().flatten({ background: '#ffffff' }).resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()).toString('base64');
}

export async function toDataUrl(input: Buffer): Promise<string> {
  return `data:image/jpeg;base64,${await toJpegBase64(input, 1536)}`;
}
