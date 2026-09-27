import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { backdropFor, cutoutFromFlatBackdrop, keyBackground } from './index';

const STRIPES = ['#D94F30', '#2E7D32', '#1565C0', '#F9A825', '#6A1B9A', '#00838F'];

/** A bottle on a plain background, a busy striped one, or a flat backdrop (what a background-removal edit returns). */
async function photo(opts: { bg?: 'plain' | 'busy' | string; dx?: number; body?: string } = {}): Promise<Buffer> {
  const bg = opts.bg ?? 'plain';
  const back =
    bg === 'busy'
      ? STRIPES.map((c, i) => `<rect x="0" y="0" width="1000" height="1250" fill="${c}" transform="rotate(${i * 30} 500 625) translate(${i * 37} 0) scale(0.18 4)"/>`).join('') +
        Array.from({ length: 25 }, (_, i) => `<rect x="${i * 40}" y="0" width="40" height="1250" fill="${STRIPES[i % 6]}"/>`).join('')
      : `<rect width="1000" height="1250" fill="${bg === 'plain' ? '#FAFAF8' : bg}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1250">${back}
    <g transform="translate(${opts.dx ?? 0} 0)">
      <rect x="455" y="170" width="90" height="90" rx="40" fill="#111"/>
      <rect x="420" y="250" width="160" height="120" rx="12" fill="#222"/>
      <rect x="330" y="360" width="340" height="620" rx="36" fill="${opts.body ?? '#C9A27E'}"/>
      <rect x="360" y="560" width="280" height="200" fill="#FFFFFF"/>
    </g></svg>`;
  return sharp(Buffer.from(svg)).removeAlpha().png().toBuffer();
}

/** RGB of the pixel at the centre of an image (after flattening any transparency onto black). */
async function centre(png: Buffer) {
  const { data, info } = await sharp(png).flatten({ background: '#000000' }).raw().toBuffer({ resolveWithObject: true });
  const o = (Math.floor(info.height * 0.3) * info.width + Math.floor(info.width / 2)) * info.channels;
  return [data[o]!, data[o + 1]!, data[o + 2]!];
}

describe('product cut-out (design M3, plan 06 Phase 1 #6)', () => {
  it('keys a plain background and frames a busy one instead of damaging it', async () => {
    const plain = await keyBackground(await photo());
    expect(plain).toMatchObject({ keyed: true, technique: 'border_key' });
    expect(plain.spread).toBeLessThan(0.05);
    // The alpha lines up with the bottle: trimmed to it, transparent beside the cap, opaque in the body.
    const { data, info } = await sharp(plain.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBeGreaterThan(330);
    expect(info.width).toBeLessThan(360);
    expect(data[3]).toBe(0);
    expect(data[(Math.floor(info.height * 0.4) * info.width + Math.floor(info.width / 2)) * 4 + 3]).toBe(255);
    const busy = await keyBackground(await photo({ bg: 'busy' }));
    expect(busy).toMatchObject({ keyed: false, technique: 'framed' });
    expect(busy.spread).toBeGreaterThan(0.25);
    expect((await sharp(busy.mask).metadata()).channels).toBe(1);
  });

  it('cuts the product out of the original photo with the mask of a flat-backdrop edit', async () => {
    const original = await photo({ bg: 'busy' });
    // The edit's product is a little off in colour: the cut-out must carry the photo's pixels, not the edit's.
    const edited = await photo({ bg: '#00B140', body: '#D2AA86' });
    const cut = await cutoutFromFlatBackdrop(original, edited);
    expect(cut.aligned).toBe(true);
    expect(cut.coverage).toBeGreaterThan(0.1);
    expect(cut.coverage).toBeLessThan(0.3);
    const meta = await sharp(cut.png).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBeLessThan(400); // trimmed to the bottle, not the whole frame
    const [r, g, b] = await centre(cut.png);
    expect(Math.abs(r! - 0xc9) + Math.abs(g! - 0xa2) + Math.abs(b! - 0x7e)).toBeLessThan(12);
  });

  it('refuses an edit that moved or redrew the product', async () => {
    const original = await photo({ bg: 'busy' });
    const moved = await cutoutFromFlatBackdrop(original, await photo({ bg: '#00B140', dx: 180 }));
    expect(moved.aligned).toBe(false);
    expect(moved.drift).toBeGreaterThan(48);
    // An edit that isn't a flat backdrop can't be keyed reliably either.
    expect((await cutoutFromFlatBackdrop(original, original)).aligned).toBe(false);
  });

  it('chooses a backdrop colour unlike the product', async () => {
    expect((await backdropFor(await photo({ body: '#2E9D4A' }))).name).not.toBe('chroma green');
    expect((await backdropFor(await photo({ body: '#C9A27E' }))).name).toBe('chroma green');
  });
});
