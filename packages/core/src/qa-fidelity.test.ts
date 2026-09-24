import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { compositeProduct, keyBackground, placeholderFrame, productionBackdrop } from '@arkiv/media';
import { fidelitySignals, fidelityThresholds, labelTextSimilarity } from './fidelity';

/**
 * Fidelity QA regression with known product mutations (standard §51 "Fidelity QA regression with known product
 * mutations", §50 Gate 5 "hard product-identity failures are caught in the regression set"). Frames are built from
 * the serum fixture: the exact product composited as production does, then mutated the way a generative model
 * drifts (recoloured body or cap, a duplicated bottle, a misread label). The deterministic checks must catch each
 * mutation on their own (the vision inspector's verdict is not consulted), and must not fail honest variation
 * (relighting ±20%, a slight rotation, a re-crop) or a frame without the product.
 */

const FIXTURE = path.resolve(__dirname, '../../../tests/e2e/fixtures/serum.jpg');
let photo: Buffer;
let cutout: Buffer;
let backdrop: Buffer;

/** The fixture's cap, in photo pixels. */
const CAP = { left: 420, top: 170, width: 160, height: 190 };

async function frameFrom(product: Buffer): Promise<Buffer> {
  const cut = await keyBackground(product);
  return compositeProduct(backdrop, cut.png, '9x16', { scale: 0.5, anchor: 'center', shadow: true });
}

async function paint(region: { left: number; top: number; width: number; height: number }, svgBody: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${region.width}" height="${region.height}">${svgBody}</svg>`;
  return sharp(photo).composite([{ input: Buffer.from(svg), left: region.left, top: region.top }]).jpeg({ quality: 95 }).toBuffer();
}

beforeAll(async () => {
  photo = await readFile(FIXTURE);
  cutout = (await keyBackground(photo)).png;
  backdrop = await productionBackdrop('9x16', ['#e8dcc8']);
});

describe('deterministic fidelity checks (mutation regression set)', () => {
  it('the exact product composite passes and is located once', async () => {
    const s = await fidelitySignals(await frameFrom(photo), cutout);
    expect(s.located).toBe(true);
    expect(s.productCount).toBe(1);
    expect(s.failures).toEqual([]);
  });

  it('honest variation passes: brightness ±20%, a slight rotation, a re-crop, a generated setting', async () => {
    const exact = await frameFrom(photo);
    const variants = {
      brighter: await sharp(exact).modulate({ brightness: 1.2 }).png().toBuffer(),
      darker: await sharp(exact).modulate({ brightness: 0.8 }).png().toBuffer(),
      rotated: await sharp(exact).rotate(2, { background: '#f2ede4' }).resize(1080, 1920, { fit: 'cover' }).png().toBuffer(),
      recropped: await sharp(exact).extract({ left: 40, top: 80, width: 1000, height: 1780 }).resize(1080, 1920).png().toBuffer(),
      plate: await compositeProduct(await placeholderFrame('marble bathroom shelf', '9x16', 1), cutout, '9x16', { scale: 0.5, shadow: true }),
    };
    for (const [name, f] of Object.entries(variants)) {
      const s = await fidelitySignals(f, cutout);
      expect(s.located, name).toBe(true);
      expect(s.failures, name).toEqual([]);
    }
  });

  it('a frame without the product gets no verdict (the inspector decides)', async () => {
    const s = await fidelitySignals(await placeholderFrame('hands apply serum at a sink', '9x16', 2), cutout);
    expect(s.located).toBe(false);
    expect(s.failures).toEqual([]);
  });

  it('a recoloured body is a materially wrong shade', async () => {
    const recoloured = await sharp(photo).modulate({ hue: 150, saturation: 3 }).jpeg().toBuffer();
    const s = await fidelitySignals(await frameFrom(recoloured), cutout);
    expect(s.located).toBe(true);
    expect(s.failures.map((f) => f.kind)).toContain('shade');
  });

  it('a recoloured cap is a materially wrong shade', async () => {
    const s = await fidelitySignals(await frameFrom(await paint(CAP, `<rect x="35" y="0" width="90" height="90" rx="40" fill="#c0282d"/><rect x="0" y="80" width="160" height="110" rx="8" fill="#b02428"/>`)), cutout);
    expect(s.failures.map((f) => f.kind)).toContain('shade');
  });

  it('a duplicated product is a wrong package count', async () => {
    const small = await sharp(cutout).resize({ height: 760 }).png().toBuffer();
    const frame = await sharp(backdrop).composite([{ input: small, left: 40, top: 560 }, { input: small, left: 560, top: 560 }]).png().toBuffer();
    const s = await fidelitySignals(frame, cutout);
    expect(s.productCount).toBe(2);
    expect(s.failures.map((f) => f.kind)).toEqual(['count']);
  });

  it('label OCR diff: a mutated label reads differently; case, spacing and punctuation do not count', () => {
    expect(labelTextSimilarity('DEW SERUM 30 ml', 'Dew  serum — 30ml')).toBeGreaterThan(0.9);
    expect(labelTextSimilarity('DEW SERUM 30 ml', 'DEW SERUMM 30 ml')).toBeGreaterThan(0.8);
    expect(labelTextSimilarity('DEW SERUM 30 ml', 'GLOW TONIC 100 ml')).toBeLessThan(0.5);
    expect(labelTextSimilarity('DEW SERUM 30 ml', 'DEW 30 ml')).toBeLessThan(0.8);
    expect(labelTextSimilarity('雪肌精 化粧水', '雪肌精 化粧水')).toBe(1);
  });

  it('thresholds come from the fingerprint, with defaults for anything unset or invalid', () => {
    expect(fidelityThresholds({ paletteDistanceMax: 50, matchMin: 'x' })).toMatchObject({ paletteDistanceMax: 50, matchMin: 0.8, regionColorMax: 60 });
    expect(fidelityThresholds(null).paletteDistanceMax).toBe(70);
  });
});
