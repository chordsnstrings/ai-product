import sharp, { type OverlayOptions } from 'sharp';

/** Arkiv palette (01-design-system §2.1) for generated overlays and placeholders. */
export const PAPER = '#F5F2EC';
export const PAPER_SUNK = '#ECE8E0';
export const INK = '#1A1917';
export const STONE = '#8A857D';
/** Stone deep enough for small legal text on paper (WCAG AA 4.5:1; §25 caption readability). */
export const STONE_TEXT = '#5C5750';

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

/** A rectangle on the frame, in pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The platform safe area of an aspect, in pixels (everything outside it may sit under platform UI). */
export function safeRect(aspect: Aspect): Box {
  const { w, h } = ASPECT_SIZE[aspect];
  const sz = SAFE_ZONE[aspect];
  return { x: Math.round(w * sz.left), y: Math.round(h * sz.top), w: Math.round(w * (1 - sz.left - sz.right)), h: Math.round(h * (1 - sz.top - sz.bottom)) };
}

/**
 * Where a frame of aspect `from` lands in an export of aspect `to`: the composer fits stills and clips by cover
 * (scale to fill, centre crop). Returns the scale and the crop offset in the scaled frame.
 */
export function coverMapping(from: Aspect, to: Aspect): { scale: number; cropX: number; cropY: number } {
  const a = ASPECT_SIZE[from];
  const b = ASPECT_SIZE[to];
  const scale = Math.max(b.w / a.w, b.h / a.h);
  return { scale, cropX: (a.w * scale - b.w) / 2, cropY: (a.h * scale - b.h) / 2 };
}

/** A box on a frame of aspect `from`, as it appears in the export of aspect `to` (possibly partly cropped away). */
export function mapBox(box: Box, from: Aspect, to: Aspect): Box {
  const m = coverMapping(from, to);
  return { x: box.x * m.scale - m.cropX, y: box.y * m.scale - m.cropY, w: box.w * m.scale, h: box.h * m.scale };
}

/**
 * The part of a frame of aspect `from` that stays inside the safe area of every export aspect once centre-cropped:
 * where the exact product is placed so no platform crop cuts it or hides it under platform UI (§25 platform QA).
 */
export function sharedSafeRect(from: Aspect, aspects: readonly Aspect[] = ['9x16', '4x5', '1x1']): Box {
  let x0 = 0;
  let y0 = 0;
  let x1 = ASPECT_SIZE[from].w;
  let y1 = ASPECT_SIZE[from].h;
  for (const to of aspects) {
    const m = coverMapping(from, to);
    const r = safeRect(to);
    x0 = Math.max(x0, (r.x + m.cropX) / m.scale);
    y0 = Math.max(y0, (r.y + m.cropY) / m.scale);
    x1 = Math.min(x1, (r.x + r.w + m.cropX) / m.scale);
    y1 = Math.min(y1, (r.y + r.h + m.cropY) / m.scale);
  }
  const x = Math.ceil(x0);
  const y = Math.ceil(y0);
  return { x, y, w: Math.floor(x1) - x, h: Math.floor(y1) - y };
}

/** Whether `inner` lies inside `outer` (with a pixel of rounding slack). */
export const boxInside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;

/** WCAG 2 contrast ratio of two 6-digit hex colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** How a text element was set: its box, type size and colours (platform readability QA, §25). */
export interface TextLayout {
  box: Box;
  fontSize: number;
  ink: string;
  plate: string;
  lines: string[];
}

/** Layout of a caption or overlay plate: inside the safe zone, upper or lower. */
export function captionLayout(text: string, aspect: Aspect, opts: { position?: 'upper' | 'lower'; fontSize?: number; style?: 'overlay' | 'caption' } = {}): TextLayout {
  const { w, h } = ASPECT_SIZE[aspect];
  const sz = SAFE_ZONE[aspect];
  // Spoken-word captions are set smaller and inverted (paper on ink) so they read as a separate track from
  // on-screen overlay text (paper plate, ink text).
  const caption = opts.style === 'caption';
  const fontSize = opts.fontSize ?? Math.round(w * (caption ? 0.042 : 0.05));
  const maxWidth = w * (1 - sz.left - sz.right) - 48;
  const lines = wrap(text, fontSize, maxWidth).slice(0, 4);
  const lineH = Math.round(fontSize * 1.25);
  const plateH = lines.length * lineH + 40;
  const longest = Math.max(...lines.map((l) => l.length));
  const plateW = Math.min(maxWidth + 48, Math.round(longest * fontSize * 0.55) + 56);
  const x = Math.round(w * sz.left);
  const y = opts.position === 'upper' ? Math.round(h * sz.top) : Math.round(h * (1 - sz.bottom)) - plateH;
  return { box: { x, y, w: plateW, h: plateH }, fontSize, ink: caption ? PAPER : INK, plate: caption ? INK : PAPER, lines };
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
  const l = captionLayout(text, aspect, opts);
  const lineH = Math.round(l.fontSize * 1.25);
  const tspans = l.lines
    .map((t, i) => `<text x="${l.box.x + 28}" y="${l.box.y + 20 + l.fontSize + i * lineH}" font-family="Inter Tight, Inter, Helvetica, Arial, sans-serif" font-size="${l.fontSize}" font-weight="500" fill="${l.ink}">${esc(t)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="${l.box.x}" y="${l.box.y}" width="${l.box.w}" height="${l.box.h}" fill="${l.plate}" fill-opacity="${opts.style === 'caption' ? 0.86 : 0.94}"/>
    ${tspans}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A brand colour usable on the end card: a 6-digit hex, else null (never interpolated unchecked into the SVG). */
export function brandAccent(colors: readonly string[] | null | undefined): string | null {
  return (colors ?? []).map((c) => c.trim()).find((c) => /^#[0-9a-f]{6}$/i.test(c)) ?? null;
}

export interface EndCardOptions {
  productName: string;
  cta: string;
  index?: string;
  aspect: Aspect;
  accent?: string | null;
  note?: string | null;
  price?: string | null;
}

/**
 * End-card layout inside the aspect's safe zone (§25 platform QA): the product name, price, CTA bar and the
 * brand's disclosure all sit clear of platform UI. The CTA text takes paper or ink, whichever reads better on the
 * brand's bar colour.
 */
export function endCardLayout(opts: EndCardOptions) {
  const { w, h } = ASPECT_SIZE[opts.aspect];
  const safe = safeRect(opts.aspect);
  const left = Math.max(w * 0.08, safe.x);
  const right = Math.min(w * 0.92, safe.x + safe.w);
  const width = right - left;
  const bottom = safe.y + safe.h;
  const bar = brandAccent(opts.accent ? [opts.accent] : []) ?? INK;
  const ctaInk = contrastRatio(PAPER, bar) >= contrastRatio(INK, bar) ? PAPER : INK;
  const noteSize = w * 0.026;
  const noteStep = w * 0.036;
  const noteGap = w * 0.06;
  const noteLines = (opts.note ?? '').trim() ? wrap(opts.note!.trim(), noteSize, width).slice(0, 3) : [];
  const barH = w * 0.13;
  // The note's last baseline plus its descenders stays above the safe bottom; the bar moves up to make room.
  const noteH = noteLines.length ? noteGap + (noteLines.length - 1) * noteStep + noteSize * 0.3 : 0;
  const barY = Math.min(h * 0.66, bottom - barH - noteH);
  const nameSize = w * 0.075;
  const nameStep = w * 0.09;
  const nameLines = wrap(opts.productName, nameSize, width).slice(0, opts.aspect === '1x1' ? 2 : 3);
  const indexSize = w * 0.028;
  const indexY = Math.max(safe.y + indexSize, h * 0.36);
  const nameTop = Math.max(indexY + h * 0.02 + w * 0.02, h * 0.46 - nameSize);
  const priceSize = w * 0.05;
  const text = (lines: string[], size: number, ink: string, plate: string, box: Box): TextLayout => ({ box, fontSize: Math.round(size), ink, plate, lines });
  return {
    left,
    width,
    bar,
    ctaInk,
    index: { baseline: indexY, size: indexSize, rule: indexY + h * 0.02 },
    name: text(nameLines, nameSize, INK, PAPER, { x: left, y: nameTop, w: width, h: (nameLines.length - 1) * nameStep + nameSize * 1.25 }),
    price: (opts.price ?? '').trim() ? text([opts.price!.trim()], priceSize, INK, PAPER, { x: left, y: barY - w * 0.03 - priceSize, w: width, h: priceSize * 1.25 }) : null,
    cta: text([opts.cta], w * 0.045, ctaInk, bar, { x: left, y: barY, w: width, h: barH }),
    note: noteLines.length ? text(noteLines, noteSize, STONE_TEXT, PAPER, { x: left, y: barY + barH + noteGap - noteSize, w: width, h: (noteLines.length - 1) * noteStep + noteSize * 1.3 }) : null,
  };
}

/**
 * End card: product name + CTA in arkiv style. The brand's colour fills the CTA bar and its mandatory disclosure
 * (Brand Brain, §16) is set under it in small type.
 */
export async function endCard(opts: EndCardOptions): Promise<Buffer> {
  const { w, h } = ASPECT_SIZE[opts.aspect];
  const l = endCardLayout(opts);
  const note = l.note
    ? l.note.lines.map((t, i) => `<text x="${l.left}" y="${l.cta.box.y + l.cta.box.h + w * 0.06 + i * w * 0.036}" font-family="Inter Tight, Inter, Arial, sans-serif" font-size="${w * 0.026}" fill="${STONE_TEXT}">${esc(t)}</text>`).join('')
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="${PAPER}"/>
    <text x="${l.left}" y="${l.index.baseline}" font-family="IBM Plex Mono, monospace" font-size="${l.index.size}" fill="${STONE}" letter-spacing="3">${esc(opts.index ?? 'NO. 001')}</text>
    <line x1="${l.left}" y1="${l.index.rule}" x2="${l.left + l.width}" y2="${l.index.rule}" stroke="${INK}" stroke-width="2"/>
    ${l.name.lines.map((t, i) => `<text x="${l.left}" y="${l.name.box.y + w * 0.075 + i * w * 0.09}" font-family="Instrument Serif, Georgia, serif" font-size="${w * 0.075}" fill="${INK}">${esc(t)}</text>`).join('')}
    ${l.price ? `<text x="${l.left}" y="${l.price.box.y + w * 0.05}" font-family="Inter Tight, Inter, Arial, sans-serif" font-size="${w * 0.05}" fill="${INK}">${esc(l.price.lines[0]!)}</text>` : ''}
    <rect x="${l.left}" y="${l.cta.box.y}" width="${l.width}" height="${l.cta.box.h}" fill="${l.bar}"/>
    <text x="${l.left + l.width / 2}" y="${l.cta.box.y + w * 0.083}" text-anchor="middle" font-family="Inter Tight, Inter, Arial, sans-serif" font-size="${w * 0.045}" fill="${l.ctaInk}">${esc(opts.cta)}</text>
    ${note}
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
 * Where the exact product goes on a frame of `aspect` (§25 safe-zone placement): at most `scale` of the frame's
 * height and always inside the part of the frame every export aspect keeps clear of platform UI after its crop
 * (sharedSafeRect), so no platform variant cuts the product off. Centred in that area, or standing on its lower edge.
 */
export function productPlacement(cutW: number, cutH: number, aspect: Aspect, opts: { scale?: number; anchor?: 'center' | 'lower' } = {}): Box {
  const { h } = ASPECT_SIZE[aspect];
  const area = sharedSafeRect(aspect);
  const maxH = Math.min(Math.round(h * (opts.scale ?? 0.45)), area.h);
  const k = Math.min(area.w / Math.max(1, cutW), maxH / Math.max(1, cutH));
  const pw = Math.max(1, Math.floor(cutW * k));
  const ph = Math.max(1, Math.floor(cutH * k));
  const x = Math.round(area.x + (area.w - pw) / 2);
  const y = opts.anchor === 'lower' ? area.y + area.h - ph : Math.round(area.y + (area.h - ph) / 2);
  return { x, y, w: pw, h: ph };
}

/**
 * Place an exact product cut-out onto a background frame (strict composite mode, §23), inside the area that stays
 * safe in every export aspect (productPlacement). With `shadow`, a soft contact shadow grounds the product.
 */
export async function compositeProduct(
  background: Buffer,
  productCutout: Buffer,
  aspect: Aspect,
  opts: { scale?: number; anchor?: 'center' | 'lower'; shadow?: boolean } = {},
): Promise<Buffer> {
  const { w, h } = ASPECT_SIZE[aspect];
  const bg = await sharp(background).resize(w, h, { fit: 'cover' }).toBuffer();
  const src = await sharp(productCutout).metadata();
  const place = productPlacement(src.width ?? 1, src.height ?? 1, aspect, opts);
  const product = await sharp(productCutout).resize({ width: place.w, height: place.h, fit: 'inside' }).png().toBuffer();
  const meta = await sharp(product).metadata();
  const pw = meta.width ?? 0;
  const ph = meta.height ?? 0;
  const left = place.x + Math.floor((place.w - pw) / 2);
  const top = place.y + (place.h - ph);
  const layers: OverlayOptions[] = [];
  if (opts.shadow && pw > 0 && ph > 0) {
    const sw = Math.round(pw * 1.1);
    const sh = Math.max(12, Math.round(pw * 0.12));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sw * 2}" height="${sh * 4}">
      <ellipse cx="${sw}" cy="${sh * 2}" rx="${sw / 2}" ry="${sh / 2}" fill="${INK}" fill-opacity="0.22"/></svg>`;
    const shadow = await sharp(Buffer.from(svg)).blur(Math.max(4, sh / 3)).png().toBuffer();
    const sLeft = Math.round(left + pw / 2 - sw);
    const sTop = Math.round(top + ph - sh * 2);
    if (sLeft >= 0 && sTop >= 0 && sLeft + sw * 2 <= w && sTop + sh * 4 <= h) layers.push({ input: shadow, left: sLeft, top: sTop });
  }
  layers.push({ input: product, left, top });
  return sharp(bg).composite(layers).png().toBuffer();
}
