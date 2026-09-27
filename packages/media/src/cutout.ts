import sharp from 'sharp';

/**
 * Product cut-out helpers (design M3, conversion L3). Border-colour keying works for the usual plain-background
 * product photo; a background-removal provider handles the rest by putting the product on a flat backdrop, which
 * is then keyed here and its mask applied to the *original* photo — the cut-out always carries the photo's own
 * pixels, never generated ones (product fidelity outranks spectacle).
 */

export type CutoutTechnique = 'alpha_channel' | 'border_key' | 'framed';

export interface KeyedCutout {
  /** RGBA PNG trimmed to the product (keyed), or the framed original photo when keying was unreliable. */
  png: Buffer;
  /** Single-channel PNG mask at the normalized photo size (255 = product); all-opaque when not keyed. */
  mask: Buffer;
  keyed: boolean;
  technique: CutoutTechnique;
  /** Share of the frame the product covers. */
  coverage: number;
  /** Share of border pixels far from the background estimate (0 = a perfectly plain background). */
  spread: number;
}

/** The longest edge photos are cut out at. */
const EDGE = 1200;

function dist(a: readonly number[], b: readonly number[]) {
  return Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2);
}

async function normalized(input: Buffer) {
  const base = sharp(input).rotate().resize({ width: EDGE, height: EDGE, fit: 'inside', withoutEnlargement: true });
  const meta = await base.clone().metadata();
  const { data, info } = await base.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { base, hasAlpha: !!meta.hasAlpha, data, width: info.width, height: info.height };
}

/** Median border colour and how much of the border strays from it (a busy background strays a lot). */
function borderEstimate(data: Buffer, w: number, h: number): { med: number[]; spread: number } {
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
  return { med, spread: border.filter((p) => dist(p, med) > 40).length / border.length };
}

/** Soft alpha from the distance to the background colour, and the share of the frame that is product. */
function keyAlpha(data: Buffer, w: number, h: number, bg: readonly number[]): { alpha: Buffer; coverage: number } {
  const alpha = Buffer.alloc(w * h);
  let fg = 0;
  for (let i = 0; i < w * h; i++) {
    const d = dist([data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!], bg);
    const a = d < 28 ? 0 : d > 60 ? 255 : Math.round(((d - 28) / 32) * 255);
    alpha[i] = a;
    if (a > 128) fg++;
  }
  return { alpha, coverage: fg / (w * h) };
}

// Single-channel pipelines must say so: sharp turns a one-channel image into three on output otherwise.
const maskPng = (alpha: Buffer, w: number, h: number) => sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).toColourspace('b-w').png().toBuffer();

/** The box around the opaque pixels (with a small margin), or null when nothing is opaque. */
function opaqueBox(alpha: Buffer, w: number, h: number, margin = 2) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x]! <= 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const left = Math.max(0, x0 - margin);
  const top = Math.max(0, y0 - margin);
  return { left, top, width: Math.min(w, x1 + margin + 1) - left, height: Math.min(h, y1 + margin + 1) - top };
}

async function applyAlpha(rgb: Buffer, alpha: Buffer, w: number, h: number): Promise<{ png: Buffer; mask: Buffer }> {
  const soft = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).blur(1.2).extractChannel(0).raw().toBuffer();
  const img = sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).joinChannel(soft, { raw: { width: w, height: h, channels: 1 } });
  // Trimmed to the product by its alpha (the RGB under transparent pixels is the photo's background, so a
  // colour-based trim would keep the whole frame).
  const box = opaqueBox(soft, w, h);
  const png = await (box ? sharp(await img.png().toBuffer()).extract(box) : img).png().toBuffer();
  return { png, mask: await maskPng(alpha, w, h) };
}

const unreliable = (spread: number, coverage: number) => spread > 0.25 || coverage < 0.03 || coverage > 0.92;

/**
 * Border-colour keying: the background is the median border colour. Busy backgrounds and nearly-empty or
 * nearly-full masks make keying unreliable; then the original photo is returned framed (keyed: false) rather
 * than a damaged cut-out. A photo that already has transparency is trimmed and used as is.
 */
export async function keyBackground(input: Buffer): Promise<KeyedCutout> {
  const n = await normalized(input);
  const { data, width: w, height: h } = n;
  if (n.hasAlpha) {
    const png = await n.base.clone().trim().png().toBuffer();
    const a = await n.base.clone().ensureAlpha().extractChannel(3).raw().toBuffer();
    return { png, mask: await maskPng(a, w, h), keyed: true, technique: 'alpha_channel', coverage: 1, spread: 0 };
  }
  const { med, spread } = borderEstimate(data, w, h);
  const { alpha, coverage } = keyAlpha(data, w, h, med);
  if (unreliable(spread, coverage)) {
    return { png: await n.base.clone().png().toBuffer(), mask: await maskPng(Buffer.alloc(w * h, 255), w, h), keyed: false, technique: 'framed', coverage, spread };
  }
  return { ...(await applyAlpha(data, alpha, w, h)), keyed: true, technique: 'border_key', coverage, spread };
}

/** Flat backdrops a background-removal edit may use: whichever is least like the product is keyed cleanly. */
export const BACKDROPS = [
  { name: 'chroma green', hex: '#00B140', rgb: [0, 177, 64] },
  { name: 'magenta', hex: '#FF00FF', rgb: [255, 0, 255] },
  { name: 'blue', hex: '#0047BB', rgb: [0, 71, 187] },
] as const;
export type Backdrop = (typeof BACKDROPS)[number];

/** The backdrop colour furthest from the photo's subject (its central half), so keying never eats the product. */
export async function backdropFor(input: Buffer): Promise<Backdrop> {
  const { data, width: w, height: h } = await normalized(input);
  const near = BACKDROPS.map(() => 0);
  for (let y = Math.floor(h / 4); y < Math.ceil((h * 3) / 4); y += 3) {
    for (let x = Math.floor(w / 4); x < Math.ceil((w * 3) / 4); x += 3) {
      const o = (y * w + x) * 3;
      const px = [data[o]!, data[o + 1]!, data[o + 2]!];
      BACKDROPS.forEach((b, i) => {
        if (dist(px, b.rgb) < 110) near[i]!++;
      });
    }
  }
  return BACKDROPS[near.indexOf(Math.min(...near))]!;
}

export interface MaskedCutout {
  png: Buffer;
  mask: Buffer;
  coverage: number;
  /**
   * Whether the edit kept the product where it was: the photo's pixels under the mask must match the edit's.
   * An edit that moved, resized or redrew the product is not aligned, and its mask must not be used.
   */
  aligned: boolean;
  /** Mean colour difference between photo and edit inside the mask (0–441). */
  drift: number;
}

/**
 * Cut the product out of `original` using a provider edit that shows the same product on a flat backdrop: the
 * edit is keyed against its own border colour, and the resulting mask is applied to the original photo's pixels.
 */
export async function cutoutFromFlatBackdrop(original: Buffer, edited: Buffer): Promise<MaskedCutout> {
  const o = await normalized(original);
  const { data, width: w, height: h } = o;
  const e = await sharp(edited).rotate().resize({ width: w, height: h, fit: 'fill' }).removeAlpha().raw().toBuffer();
  const { med, spread } = borderEstimate(e, w, h);
  const { alpha, coverage } = keyAlpha(e, w, h, med);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (alpha[i]! < 200) continue;
    sum += dist([data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!], [e[i * 3]!, e[i * 3 + 1]!, e[i * 3 + 2]!]);
    n++;
  }
  const drift = n ? sum / n : 441;
  // A flat backdrop keys cleanly; anything else (or a product that moved or was redrawn) is not trusted.
  const aligned = spread <= 0.1 && !unreliable(spread, coverage) && drift <= 48;
  if (!aligned) return { png: await o.base.clone().png().toBuffer(), mask: await maskPng(alpha, w, h), coverage, aligned, drift };
  return { ...(await applyAlpha(data, alpha, w, h)), coverage, aligned, drift };
}
