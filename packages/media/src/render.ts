import sharp, { type OverlayOptions } from 'sharp';

/** Arkiv palette (01-design-system §2.1) for generated overlays and placeholders. */
export const PAPER = '#F5F2EC';
export const PAPER_SUNK = '#ECE8E0';
export const INK = '#1A1917';
export const STONE = '#8A857D';

export type Aspect = '9x16' | '4x5' | '1x1';
export const ASPECT_SIZE: Record<Aspect, { w: number; h: number }> = {
  '9x16': { w: 1080, h: 1920 },
  '4x5': { w: 1080, h: 1350 },
  '1x1': { w: 1080, h: 1080 },
};

/**
 * Platform safe zones (fraction of height/width kept clear of platform UI). TikTok/Reels place captions,
 * buttons and the handle at the bottom ~20% and right ~12%; key elements stay inside (§25 platform QA).
 */
export const SAFE_ZONE: Record<Aspect, { top: number; bottom: number; left: number; right: number }> = {
  '9x16': { top: 0.1, bottom: 0.22, left: 0.06, right: 0.14 },
  '4x5': { top: 0.06, bottom: 0.1, left: 0.06, right: 0.06 },
  '1x1': { top: 0.06, bottom: 0.08, left: 0.06, right: 0.06 },
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Greedy word wrap by approximate glyph width (0.55em for the sans stack). */
export function wrap(text: string, fontSize: number, maxWidth: number): string[] {
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * 0.55)));
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((cur + ' ' + word).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = word;
    } else cur = (cur + ' ' + word).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Transparent caption/overlay PNG positioned inside the safe zone. Ink text on a paper plate: legible on any
 * footage without drop shadows (design system bans shadows).
 */
export async function captionOverlay(
  text: string,
  aspect: Aspect,
  opts: { position?: 'upper' | 'lower'; fontSize?: number; style?: 'overlay' | 'caption' } = {},
): Promise<Buffer> {
  const { w, h } = ASPECT_SIZE[aspect];
  const sz = SAFE_ZONE[aspect];
  // Spoken-word captions are set smaller and inverted (paper on ink) so they read as a separate track from
  // on-screen overlay text (paper plate, ink text).
  const caption = opts.style === 'caption';
  const fontSize = opts.fontSize ?? Math.round(w * (caption ? 0.042 : 0.05));
  const plate = caption ? INK : PAPER;
  const ink = caption ? PAPER : INK;
  const maxWidth = w * (1 - sz.left - sz.right) - 48;
  const lines = wrap(text, fontSize, maxWidth).slice(0, 4);
  const lineH = Math.round(fontSize * 1.25);
  const plateH = lines.length * lineH + 40;
  const longest = Math.max(...lines.map((l) => l.length));
  const plateW = Math.min(maxWidth + 48, Math.round(longest * fontSize * 0.55) + 56);
  const x = Math.round(w * sz.left);
  const y =
    opts.position === 'upper' ? Math.round(h * sz.top) : Math.round(h * (1 - sz.bottom)) - plateH;
  const tspans = lines
    .map((l, i) => `<text x="${x + 28}" y="${y + 20 + fontSize + i * lineH}" font-family="Inter Tight, Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="500" fill="${ink}">${esc(l)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="${x}" y="${y}" width="${plateW}" height="${plateH}" fill="${plate}" fill-opacity="${caption ? 0.86 : 0.94}"/>
    ${tspans}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** End card: product name + CTA in arkiv style. */
export async function endCard(opts: { productName: string; cta: string; index?: string; aspect: Aspect }): Promise<Buffer> {
  const { w, h } = ASPECT_SIZE[opts.aspect];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="${PAPER}"/>
    <text x="${w * 0.08}" y="${h * 0.36}" font-family="IBM Plex Mono, monospace" font-size="${w * 0.028}" fill="${STONE}" letter-spacing="3">${esc(opts.index ?? 'NO. 001')}</text>
    <line x1="${w * 0.08}" y1="${h * 0.38}" x2="${w * 0.92}" y2="${h * 0.38}" stroke="${INK}" stroke-width="2"/>
    ${wrap(opts.productName, w * 0.075, w * 0.84)
      .slice(0, 3)
      .map((l, i) => `<text x="${w * 0.08}" y="${h * 0.46 + i * w * 0.09}" font-family="Instrument Serif, Georgia, serif" font-size="${w * 0.075}" fill="${INK}">${esc(l)}</text>`)
      .join('')}
    <rect x="${w * 0.08}" y="${h * 0.66}" width="${w * 0.84}" height="${w * 0.13}" fill="${INK}"/>
    <text x="${w * 0.5}" y="${h * 0.66 + w * 0.083}" text-anchor="middle" font-family="Inter Tight, Inter, Arial, sans-serif" font-size="${w * 0.045}" fill="${PAPER}">${esc(opts.cta)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Deterministic placeholder frame with visible debug marks. For mock providers and tests only — never a
 * production background (use productionBackdrop).
 */
export async function placeholderFrame(label: string, aspect: Aspect, seed = 0): Promise<Buffer> {
  const { w, h } = ASPECT_SIZE[aspect];
  const tones = ['#ECE8E0', '#E4DED3', '#DCD5C8', '#EFEAE2'];
  const bg = tones[seed % tones.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="${bg}"/>
    <rect x="${w * 0.3}" y="${h * 0.3}" width="${w * 0.4}" height="${h * 0.4}" fill="none" stroke="${STONE}" stroke-width="2" stroke-dasharray="8 8"/>
    ${wrap(label, 40, w * 0.8)
      .slice(0, 5)
      .map((l, i) => `<text x="${w / 2}" y="${h * 0.78 + i * 52}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="36" fill="${INK}">${esc(l)}</text>`)
      .join('')}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Mix a hex colour toward paper: brand tints stay quiet enough for the product to carry the frame. */
function tint(hex: string, amount: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const p = [1, 3, 5].map((i) => parseInt(PAPER.slice(i, i + 2), 16));
  return '#' + c.map((v, i) => Math.round(v * amount + p[i]! * (1 - amount)).toString(16).padStart(2, '0')).join('');
}

/**
 * Production background for strict product composites (§23): a seamless paper sweep, tinted from the product's
 * own palette when known, with no marks of any kind. Used when no generated environment plate is available.
 */
export async function productionBackdrop(aspect: Aspect, palette: readonly string[] = []): Promise<Buffer> {
  const { w, h } = ASPECT_SIZE[aspect];
  const base = palette.find((c) => HEX.test(c));
  const top = base ? tint(base, 0.12) : PAPER;
  const floor = base ? tint(base, 0.24) : PAPER_SUNK;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="sweep" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset="0.62" stop-color="${top}"/><stop offset="1" stop-color="${floor}"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#sweep)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A photo shown full-bleed (cover) at the aspect: used when a product can't be cut out cleanly. */
export async function fullBleedFrame(photo: Buffer, aspect: Aspect): Promise<Buffer> {
  const { w, h } = ASPECT_SIZE[aspect];
  return sharp(photo).rotate().resize(w, h, { fit: 'cover' }).png().toBuffer();
}

/**
 * Place an exact product cut-out onto a background frame (strict composite mode, §23). With `shadow`, a soft
 * contact shadow grounds the product on the surface.
 */
export async function compositeProduct(
  background: Buffer,
  productCutout: Buffer,
  aspect: Aspect,
  opts: { scale?: number; anchor?: 'center' | 'lower'; shadow?: boolean } = {},
): Promise<Buffer> {
  const { w, h } = ASPECT_SIZE[aspect];
  const bg = await sharp(background).resize(w, h, { fit: 'cover' }).toBuffer();
  const targetH = Math.round(h * (opts.scale ?? 0.45));
  const product = await sharp(productCutout).resize({ width: Math.round(w * 0.86), height: targetH, fit: 'inside' }).png().toBuffer();
  const meta = await sharp(product).metadata();
  const pw = meta.width ?? 0;
  const ph = meta.height ?? 0;
  const left = Math.round((w - pw) / 2);
  const top = opts.anchor === 'lower' ? Math.round(h * 0.42) : Math.round((h - ph) / 2);
  const layers: OverlayOptions[] = [];
  if (opts.shadow && pw > 0 && ph > 0) {
    const sw = Math.round(pw * 1.1);
    const sh = Math.max(12, Math.round(pw * 0.12));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sw * 2}" height="${sh * 4}">
      <ellipse cx="${sw}" cy="${sh * 2}" rx="${sw / 2}" ry="${sh / 2}" fill="${INK}" fill-opacity="0.22"/></svg>`;
    const shadow = await sharp(Buffer.from(svg)).blur(Math.max(4, sh / 3)).png().toBuffer();
    const sLeft = Math.round(w / 2 - sw);
    const sTop = Math.round(top + ph - sh * 2);
    if (sLeft >= 0 && sTop >= 0 && sLeft + sw * 2 <= w && sTop + sh * 4 <= h) layers.push({ input: shadow, left: sLeft, top: sTop });
  }
  layers.push({ input: product, left, top });
  return sharp(bg).composite(layers).png().toBuffer();
}
