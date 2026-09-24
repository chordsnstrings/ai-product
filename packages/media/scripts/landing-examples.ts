/**
 * Builds the landing pages' built-in example media (plan 03 P1 §7, plan 04 L1): a demo product's photo (the input)
 * and one finished-ad frame per ad archetype (the output), plus a short muted loop of the frames for the desktop
 * hero. Everything is drawn here from shapes and text — a demo product, never a customer's — and is shown with the
 * "Example, made for a demo product" label. Run from the repo root after changing it:
 *
 *   pnpm --filter @arkiv/media exec tsx scripts/landing-examples.ts
 *
 * Output: apps/web/public/examples/*.jpg, loop.mp4 (committed; the files are small).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/web/public/examples');
const W = 540;
const H = 960;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The demo product: a dropper bottle with a plain label (the same shape the test fixtures use). */
function bottle(x: number, y: number, scale: number, color = '#C9A27E') {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <rect x="90" y="80" width="160" height="120" rx="12" fill="#222"/>
    <rect x="125" y="0" width="90" height="90" rx="40" fill="#111"/>
    <rect x="0" y="190" width="340" height="620" rx="36" fill="${color}"/>
    <rect x="30" y="390" width="280" height="200" fill="#FFFFFF"/>
    <text x="170" y="480" text-anchor="middle" font-family="DejaVu Sans, Arial" font-size="34" fill="#111">SERUM No. 3</text>
    <text x="170" y="530" text-anchor="middle" font-family="DejaVu Sans, Arial" font-size="22" fill="#444">30 ml</text>
  </g>`;
}

interface Frame {
  key: string;
  bg: [string, string];
  line: string;
  sub: string;
  extra?: string;
}

const FRAMES: Frame[] = [
  // Texture demonstration: the product and a swatch of its texture.
  { key: 'texture', bg: ['#EFE6DA', '#D9C7B1'], line: 'The finish, up close', sub: 'Texture demo', extra: '<ellipse cx="400" cy="760" rx="95" ry="40" fill="#F6EFE6" stroke="#C9A27E" stroke-width="3"/><ellipse cx="385" cy="752" rx="40" ry="14" fill="#FFFFFF" opacity="0.8"/>' },
  // Serum launch: the reveal.
  { key: 'serum-launch', bg: ['#1F2A2E', '#3C4F55'], line: 'Meet Serum No. 3', sub: 'Launch reveal', extra: '<circle cx="270" cy="560" r="230" fill="#FFFFFF" opacity="0.06"/>' },
  // Creator-style (UGC): a routine shot framed like a phone video.
  { key: 'ugc', bg: ['#F3E3E0', '#E2C3BE'], line: 'My 30-second morning step', sub: 'Creator-style', extra: '<rect x="24" y="24" width="492" height="912" rx="28" fill="none" stroke="#FFFFFF" stroke-width="4" opacity="0.7"/><circle cx="470" cy="70" r="10" fill="#D94F30"/>' },
  // Founder story.
  { key: 'founder', bg: ['#E7E9E2', '#C8CEC0'], line: 'Why we made it', sub: 'Founder story', extra: '<rect x="40" y="690" width="220" height="10" rx="5" fill="#7A8570"/><rect x="40" y="712" width="160" height="10" rx="5" fill="#7A8570" opacity="0.6"/>' },
  // Creative-fatigue replacement: a new angle for a tired winner.
  { key: 'fatigue', bg: ['#E4ECF2', '#BFD0DD'], line: 'A new way to show it', sub: 'Creative refresh', extra: '<path d="M60 820 L160 740 L240 790 L340 700" stroke="#1565C0" stroke-width="6" fill="none" opacity="0.5"/>' },
];

function frameSvg(f: Frame) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${f.bg[0]}"/><stop offset="1" stop-color="${f.bg[1]}"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    ${f.extra ?? ''}
    ${bottle(185, 300, 0.5)}
    <rect x="0" y="120" width="${W}" height="110" fill="#000000" opacity="0.35"/>
    <text x="${W / 2}" y="190" text-anchor="middle" font-family="DejaVu Sans, Arial" font-weight="bold" font-size="36" fill="#FFFFFF">${esc(f.line)}</text>
    <text x="${W / 2}" y="${H - 60}" text-anchor="middle" font-family="DejaVu Sans Mono, monospace" font-size="18" fill="#111111" opacity="0.6">${esc(f.sub.toUpperCase())}</text>
  </svg>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // The input: a plain product photo, as a merchant would upload it.
  const input = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round(W * 1.25)}"><rect width="100%" height="100%" fill="#FAFAF8"/>${bottle(185, 110, 0.5)}</svg>`;
  await sharp(Buffer.from(input)).jpeg({ quality: 82 }).toFile(path.join(OUT, 'input.jpg'));
  const tmp = mkdtempSync(path.join(tmpdir(), 'examples-'));
  try {
    for (const [i, f] of FRAMES.entries()) {
      const jpg = await sharp(Buffer.from(frameSvg(f))).jpeg({ quality: 80 }).toBuffer();
      writeFileSync(path.join(OUT, `${f.key}.jpg`), jpg);
      writeFileSync(path.join(tmp, `f${i}.jpg`), jpg);
    }
    // A muted loop of the frames (2s each) for the desktop hero.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1/2', '-i', path.join(tmp, 'f%d.jpg'), '-vf', 'fps=24,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-movflags', '+faststart', '-an', path.join(OUT, 'loop.mp4')]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`wrote ${FRAMES.length + 1} images and loop.mp4 to ${OUT}`);
}

void main();
