import sharp from 'sharp';

/**
 * Deterministic image helpers. Product cut-out (design M3, conversion L3) uses border-colour keying:
 * product photos are usually shot on a plain background. If keying is unreliable we return the original
 * framed on paper rather than a damaged cut-out (product fidelity outranks spectacle).
 */

function dist(a: number[], b: number[]) {
  return Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2);
}

export async function cutout(input: Buffer): Promise<{ png: Buffer; keyed: boolean; coverage: number }> {
  const base = sharp(input).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true });
  const meta = await base.clone().metadata();
  if (meta.hasAlpha) {
    const trimmed = await base.clone().trim().png().toBuffer();
    return { png: trimmed, keyed: true, coverage: 1 };
  }
  const { data, info } = await base.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  // Background estimate: median of border pixels.
  const border: number[][] = [];
  for (let x = 0; x < w; x += 4) {
    border.push([data[x * 3]!, data[x * 3 + 1]!, data[x * 3 + 2]!]);
    const o = ((h - 1) * w + x) * 3;
    border.push([data[o]!, data[o + 1]!, data[o + 2]!]);
  }
  for (let y = 0; y < h; y += 4) {
    const l = y * w * 3;
    const r = (y * w + w - 1) * 3;
    border.push([data[l]!, data[l + 1]!, data[l + 2]!], [data[r]!, data[r + 1]!, data[r + 2]!]);
  }
  const med = [0, 1, 2].map((c) => border.map((p) => p[c]!).sort((a, b) => a - b)[Math.floor(border.length / 2)]!);
  const spread = border.filter((p) => dist(p, med) > 40).length / border.length;
  const alpha = Buffer.alloc(w * h);
  let fg = 0;
  for (let i = 0; i < w * h; i++) {
    const d = dist([data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!], med);
    const a = d < 28 ? 0 : d > 60 ? 255 : Math.round(((d - 28) / 32) * 255);
    alpha[i] = a;
    if (a > 128) fg++;
  }
  const coverage = fg / (w * h);
  // Busy backgrounds or nearly-empty/nearly-full masks → keying unreliable.
  if (spread > 0.25 || coverage < 0.03 || coverage > 0.92) {
    return { png: await base.clone().png().toBuffer(), keyed: false, coverage };
  }
  const mask = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).blur(1.2).raw().toBuffer();
  const png = await sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .joinChannel(mask, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();
  const trimmed = await sharp(png).trim({ threshold: 1 }).png().toBuffer().catch(() => png);
  return { png: trimmed, keyed: true, coverage };
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
