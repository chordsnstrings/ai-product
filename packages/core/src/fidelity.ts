import sharp, { type Sharp } from 'sharp';

/**
 * Deterministic product-fidelity signals (standard §16 Visual Fingerprint, §25 check 1, §50 Gate 5; plan 06 Phase 3
 * D5 "label OCR diff + vision compare + hard-fail rules"). They run on every inspected frame next to the vision
 * model and do not depend on its judgement:
 *  - the exact product (the merchant's own cut-out) is located in the frame by masked normalized cross-correlation
 *    of luminance across scales — brightness- and contrast-invariant, so a relit shot still matches;
 *  - where it is found with confidence, the located product's colours are compared with the cut-out's, overall and
 *    region by region, after normalizing brightness: a materially different shade (body, cap, liquid) is a hard
 *    failure regardless of any overall score (§16, §48 "shade materially altered");
 *  - a second confident match of the same size with the product's colours is a wrong package count;
 *  - the label text the inspector read is diffed against the fingerprint's OCR text (labelTextDiff).
 * A frame in which the product can't be located confidently (held at an angle, partly hidden, a scene without the
 * product) gets no pixel verdict: the vision inspector decides alone. So these checks never fail a frame for being
 * different, only for showing the product wrongly.
 */

export interface FidelityThresholds {
  /** Mean colour distance (RGB) from the product's own palette to the located product's; above = wrong shade. */
  paletteDistanceMax: number;
  /** Any product region whose mean colour moved more than this (RGB, brightness-normalized) is a wrong shade. */
  regionColorMax: number;
  /** Masked NCC at or above which the product counts as located (and a second match as a second product). */
  matchMin: number;
  /** Label text read on the frame must agree with the fingerprint's OCR text at least this much (0..1). */
  labelSimilarityMin: number;
}

/** Calibrated on the golden mutation set (qa-fidelity.test.ts): relighting ±20%, 2° rotation and re-crops pass. */
export const DEFAULT_FIDELITY_THRESHOLDS: FidelityThresholds = { paletteDistanceMax: 70, regionColorMax: 60, matchMin: 0.8, labelSimilarityMin: 0.8 };

/** Thresholds from the Visual Fingerprint (`visual_fingerprints.thresholds`), defaults for anything unset or invalid. */
export function fidelityThresholds(raw: unknown): FidelityThresholds {
  const t = (raw ?? {}) as Record<string, unknown>;
  const num = (k: keyof FidelityThresholds) => (typeof t[k] === 'number' && Number.isFinite(t[k]) && (t[k] as number) > 0 ? (t[k] as number) : DEFAULT_FIDELITY_THRESHOLDS[k]);
  return { paletteDistanceMax: num('paletteDistanceMax'), regionColorMax: num('regionColorMax'), matchMin: num('matchMin'), labelSimilarityMin: num('labelSimilarityMin') };
}

export interface FidelitySignals {
  /** Whether the exact product was located confidently in the frame (only then are the checks below decided). */
  located: boolean;
  matchScore: number;
  /** Score of a second copy of the product, 0 when there is none. */
  secondScore: number;
  productCount: 0 | 1 | 2;
  /** Mean distance from the product's palette to the located product's palette. */
  paletteDistance: number | null;
  /** Largest brightness-normalized colour shift of any product region. */
  regionColorDelta: number | null;
  failures: { kind: 'shade' | 'count'; detail: string }[];
}

interface Img {
  w: number;
  h: number;
  /** RGB, 3 values per pixel. */
  rgb: Float32Array;
  lum: Float32Array;
  /** Product mask (templates only): 1 = opaque product pixel. */
  mask?: Uint8Array;
}

type Region = { x0: number; y0: number; x1: number; y1: number };

/** Frame height the product is searched at, and the height the located product is compared at. */
const WORK_H = 128;
const DETAIL_H = 256;
const GRID_COLS = 3;
const GRID_ROWS = 6;
/** Mean luminance step (0–255) a located product must show across its outline. */
const SILHOUETTE_MIN = 8;
/** A second copy correlates with the product about as well as the copy that was located first. */
const SECOND_COPY_MARGIN = 0.03;

async function rgbImage(input: Sharp): Promise<Img> {
  const { data, info } = await input.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const rgb = new Float32Array(n * 3);
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * info.channels]!;
    const g = data[i * info.channels + 1]!;
    const b = data[i * info.channels + 2]!;
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { w: info.width, h: info.height, rgb, lum };
}

/**
 * The cut-out as a template at w×h: its RGB and its mask of opaque pixels. Only opaque pixels are compared — where
 * the cut-out is transparent (including areas keyed out inside the product, such as a white label shot on white) a
 * composite shows its backdrop and a generated frame anything.
 */
async function template(cutout: Buffer, w: number, h: number): Promise<Img> {
  // Resized with its alpha (premultiplied), so edge pixels keep the product's colour.
  const rgba = await sharp(cutout).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer();
  const rgb = new Float32Array(w * h * 3);
  const lum = new Float32Array(w * h);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    mask[i] = rgba[i * 4 + 3]! > 160 ? 1 : 0;
  }
  return { w, h, rgb, lum, mask };
}

/**
 * Mean luminance step across the product's outline at (x, y): each opaque edge pixel of the template against the
 * frame pixel two steps outside it. A product in a frame differs from what surrounds it somewhere along its outline;
 * a stretch of wall or floor that merely correlates with the product's interior does not.
 */
function silhouetteContrast(f: Img, t: Img, x: number, y: number): number {
  let n = 0;
  let sum = 0;
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < t.w && j < t.h && t.mask![j * t.w + i] === 1;
  for (let j = 0; j < t.h; j++) {
    for (let i = 0; i < t.w; i++) {
      if (!inside(i, j)) continue;
      for (const [dx, dy] of DIRS) {
        if (inside(i + dx, j + dy)) continue;
        const ox = x + i + 2 * dx;
        const oy = y + j + 2 * dy;
        const fx = x + i;
        const fy = y + j;
        if (ox < 0 || oy < 0 || ox >= f.w || oy >= f.h || fx < 0 || fy < 0 || fx >= f.w || fy >= f.h) continue;
        sum += Math.abs(f.lum[fy * f.w + fx]! - f.lum[oy * f.w + ox]!);
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Masked NCC of the template's luminance at (x, y) in the frame (0 when either side is flat). */
function ncc(f: Img, t: Img, x: number, y: number): number {
  let n = 0;
  let st = 0;
  let sf = 0;
  let stt = 0;
  let sff = 0;
  let stf = 0;
  for (let j = 0; j < t.h; j++) {
    const fy = y + j;
    if (fy < 0 || fy >= f.h) continue;
    for (let i = 0; i < t.w; i++) {
      const ti = j * t.w + i;
      const fx = x + i;
      if (!t.mask![ti] || fx < 0 || fx >= f.w) continue;
      const a = t.lum[ti]!;
      const b = f.lum[fy * f.w + fx]!;
      n++;
      st += a;
      sf += b;
      stt += a * a;
      sff += b * b;
      stf += a * b;
    }
  }
  if (n < 16) return 0;
  const vt = stt - (st * st) / n;
  const vf = sff - (sf * sf) / n;
  if (vt < n * 4 || vf < n * 4) return 0; // flat (std < 2 levels): no structure to correlate
  return (stf - (st * sf) / n) / Math.sqrt(vt * vf);
}

/**
 * Mean colour difference between the template's opaque pixels (in `region`) and the frame under them at (x, y), the
 * frame scaled by `gain` (default: the region's own luminance ratio, so relighting is not a colour change).
 */
function regionColor(f: Img, t: Img, x: number, y: number, region?: Region, gain?: number): { delta: number; gain: number; n: number } {
  const r = region ?? { x0: 0, y0: 0, x1: t.w, y1: t.h };
  let n = 0;
  let lt = 0;
  let lf = 0;
  const tc = [0, 0, 0];
  const fc = [0, 0, 0];
  for (let j = r.y0; j < r.y1; j++) {
    const fy = y + j;
    if (fy < 0 || fy >= f.h) continue;
    for (let i = r.x0; i < r.x1; i++) {
      const ti = j * t.w + i;
      const fx = x + i;
      if (!t.mask![ti] || fx < 0 || fx >= f.w) continue;
      const fi = fy * f.w + fx;
      n++;
      lt += t.lum[ti]!;
      lf += f.lum[fi]!;
      for (let c = 0; c < 3; c++) {
        tc[c]! += t.rgb[ti * 3 + c]!;
        fc[c]! += f.rgb[fi * 3 + c]!;
      }
    }
  }
  if (!n) return { delta: 0, gain: 1, n: 0 };
  const g = gain ?? lt / Math.max(1, lf);
  return { delta: dist3(tc.map((v) => v / n), fc.map((v) => Math.min(255, (v / n) * g))), gain: g, n };
}

interface Match {
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Brightness-normalized colour distance of the match from the product (0 = the product's own colours). */
  colorDelta: number;
}

/**
 * Best matches per scale of the template over the frame (coarse stride, then refined), best first. Only matches whose
 * outline stands out from their surroundings count (see silhouetteContrast).
 */
async function search(frame: Img, cutout: Buffer, aspect: number): Promise<Match[]> {
  const out: Match[] = [];
  for (let frac = 0.22; frac <= 1.0001; frac *= 1.12) {
    const th = Math.round(frame.h * frac);
    const tw = Math.max(4, Math.round(th * aspect));
    if (tw > frame.w || th > frame.h || th < 12) continue;
    const t = await template(cutout, tw, th);
    const cand: { score: number; x: number; y: number }[] = [];
    for (let y = 0; y <= frame.h - th; y += 2) for (let x = 0; x <= frame.w - tw; x += 2) cand.push({ score: ncc(frame, t, x, y), x, y });
    cand.sort((a, b) => b.score - a.score);
    // Refine the few best distinct coarse positions at stride 1.
    const seeds: typeof cand = [];
    for (const c of cand) {
      if (seeds.length >= 4) break;
      if (seeds.every((s) => iou({ ...s, w: tw, h: th }, { ...c, w: tw, h: th }) < 0.3)) seeds.push(c);
    }
    for (const s of seeds) {
      let best = s;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = s.x + dx;
          const y = s.y + dy;
          if (x < 0 || y < 0 || x > frame.w - tw || y > frame.h - th) continue;
          const sc = ncc(frame, t, x, y);
          if (sc > best.score) best = { score: sc, x, y };
        }
      }
      // A match must also stand out from its surroundings along the product's outline: inside a flat or
      // two-tone area (a floor under a shadow) the interior correlates, the outline doesn't.
      if (silhouetteContrast(frame, t, best.x, best.y) < SILHOUETTE_MIN) continue;
      const colorDelta = regionColor(frame, t, best.x, best.y).delta;
      out.push({ ...best, w: tw, h: th, colorDelta });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Quantized palette (top k colours) of the given pixels. */
function palette(n: number, include: (i: number) => boolean, rgbAt: (i: number) => number[], k = 4): number[][] {
  const counts = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (!include(i)) continue;
    const px = rgbAt(i);
    const key = [0, 1, 2].map((c) => Math.min(255, Math.round(Math.min(255, px[c]!) / 32) * 32)).join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([c]) => c.split(',').map(Number));
}

const dist3 = (a: number[], b: number[]) => Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2);
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Deterministic fidelity signals for one frame against the product's cut-out (an RGBA PNG trimmed to the product). */
export async function fidelitySignals(frameBytes: Buffer, cutoutPng: Buffer, th: FidelityThresholds = DEFAULT_FIDELITY_THRESHOLDS): Promise<FidelitySignals> {
  const meta = await sharp(cutoutPng).metadata();
  const aspect = (meta.width ?? 1) / (meta.height ?? 1);
  const fm = await sharp(frameBytes).rotate().metadata();
  const fw = fm.width ?? 1;
  const fh = fm.height ?? 1;
  const workW = Math.max(8, Math.round((fw / fh) * WORK_H));
  const source = () => sharp(frameBytes).rotate().flatten({ background: '#808080' });
  const frame = await rgbImage(source().resize(workW, WORK_H, { fit: 'fill' }));
  const matches = await search(frame, cutoutPng, aspect);
  const best = matches[0];
  const none: FidelitySignals = { located: false, matchScore: round3(best?.score ?? 0), secondScore: 0, productCount: 0, paletteDistance: null, regionColorDelta: null, failures: [] };
  if (!best || best.score < th.matchMin) return none;

  // A second copy: another match of about the same size, apart from the first, as good structurally as the first and
  // with the product's colours (a bare two-tone edge — a shadow, a backdrop tinted from the product's palette —
  // correlates with a simple package's silhouette too, but not as well as the package itself).
  const second = matches.find(
    (m) => m !== best && iou(m, best) < 0.05 && m.h >= best.h * 0.75 && m.h <= best.h * 1.34 && m.score >= Math.max(th.matchMin, best.score - SECOND_COPY_MARGIN) && m.colorDelta <= th.regionColorMax,
  );
  const secondScore = second?.score ?? 0;
  const failures: FidelitySignals['failures'] = [];
  const productCount = second ? 2 : 1;
  if (second) failures.push({ kind: 'count', detail: `A second copy of the product appears in the frame (match ${secondScore.toFixed(2)})` });

  // Detail pass: the located product (with a margin) at a higher resolution, the cut-out aligned to it by a finer
  // search over scale and position.
  const sx = fw / workW;
  const sy = fh / WORK_H;
  const mx = best.w * 0.15;
  const my = best.h * 0.15;
  const left = clamp(Math.round((best.x - mx) * sx), 0, fw - 8);
  const top = clamp(Math.round((best.y - my) * sy), 0, fh - 8);
  const cw = clamp(Math.round((best.w + 2 * mx) * sx), 8, fw - left);
  const ch = clamp(Math.round((best.h + 2 * my) * sy), 8, fh - top);
  const k = DETAIL_H / (best.h * sy);
  const crop = await rgbImage(source().extract({ left, top, width: cw, height: ch }).resize(Math.max(8, Math.round(cw * k)), Math.max(8, Math.round(ch * k)), { fit: 'fill' }));
  let al: { t: Img; s: number; x: number; y: number; score: number } | null = null;
  for (let s = 0.91; s <= 1.0901; s += 0.03) {
    const h = Math.round(DETAIL_H * s);
    const w = Math.max(8, Math.round(h * aspect));
    if (w > crop.w || h > crop.h) continue;
    const t = await template(cutoutPng, w, h);
    for (let y = 0; y <= crop.h - h; y += 3) {
      for (let x = 0; x <= crop.w - w; x += 3) {
        const v = ncc(crop, t, x, y);
        if (!al || v > al.score) al = { t, s, x, y, score: v };
      }
    }
  }
  if (!al) return none;
  const coarse = al;
  for (let s = coarse.s - 0.02; s <= coarse.s + 0.0201; s += 0.01) {
    const h = Math.round(DETAIL_H * s);
    const w = Math.max(8, Math.round(h * aspect));
    if (w > crop.w || h > crop.h) continue;
    const t = Math.abs(s - coarse.s) < 1e-6 ? coarse.t : await template(cutoutPng, w, h);
    const cx = coarse.x + Math.round((coarse.t.w - w) / 2);
    const cy = coarse.y + Math.round((coarse.t.h - h) / 2);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const v = ncc(crop, t, cx + dx, cy + dy);
        if (v > al.score) al = { t, s, x: cx + dx, y: cy + dy, score: v };
      }
    }
  }
  const { t, x: ax, y: ay } = al;
  // Colour of the whole product and of each region (cap, shoulder, label band, body, base), brightness-normalized:
  // a relit product is the same product, a recoloured cap is not.
  const whole = regionColor(crop, t, ax, ay);
  let regionColorDelta = 0;
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      const region = { x0: Math.floor((gx * t.w) / GRID_COLS), x1: Math.floor(((gx + 1) * t.w) / GRID_COLS), y0: Math.floor((gy * t.h) / GRID_ROWS), y1: Math.floor(((gy + 1) * t.h) / GRID_ROWS) };
      const c = regionColor(crop, t, ax, ay, region, whole.gain);
      // Judged on regions mostly covered by the product (an edge sliver says little about its colour).
      if (c.n >= (region.x1 - region.x0) * (region.y1 - region.y0) * 0.4) regionColorDelta = Math.max(regionColorDelta, c.delta);
    }
  }
  const inMask = (i: number) => t.mask![i] === 1;
  const pt = palette(t.w * t.h, inMask, (i) => [t.rgb[i * 3]!, t.rgb[i * 3 + 1]!, t.rgb[i * 3 + 2]!]);
  const pf = palette(t.w * t.h, inMask, (i) => {
    const o = ((ay + Math.floor(i / t.w)) * crop.w + ax + (i % t.w)) * 3;
    return [crop.rgb[o]! * whole.gain, crop.rgb[o + 1]! * whole.gain, crop.rgb[o + 2]! * whole.gain];
  });
  const paletteDistance = pt.reduce((s, c) => s + Math.min(...pf.map((d) => dist3(c, d))), 0) / Math.max(1, pt.length);
  if (paletteDistance > th.paletteDistanceMax || regionColorDelta > th.regionColorMax) {
    const overPalette = paletteDistance > th.paletteDistanceMax;
    failures.push({ kind: 'shade', detail: `Materially wrong shade: the product’s colours moved by ${Math.round(overPalette ? paletteDistance : regionColorDelta)} (limit ${overPalette ? th.paletteDistanceMax : th.regionColorMax})` });
  }
  return { located: true, matchScore: round3(best.score), secondScore: round3(secondScore), productCount, paletteDistance: Math.round(paletteDistance), regionColorDelta: Math.round(regionColorDelta), failures };
}

const normText = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%.]+/gu, ' ')
    .trim();

/**
 * Label OCR diff (plan 06 Phase 3 D5): how much of the reference label text (the fingerprint's OCR) the text read on
 * the frame preserves, 0..1 — the character-level similarity of the two normalized strings (1 − edit distance /
 * longer length). Unicode is preserved (§48 "preserve Unicode text"); case and punctuation are not significant.
 */
export function labelTextSimilarity(reference: string, read: string): number {
  const a = normText(reference);
  const b = normText(read);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const A = [...a];
  const B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[B.length]! / Math.max(A.length, B.length);
}
