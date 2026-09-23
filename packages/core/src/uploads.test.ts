import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { DomainError } from '@arkiv/shared';
import { assetBytes } from './assets';
import { ctxFor } from './testing';
import { ingestBytes, validateMedia } from './uploads';

/**
 * Plan 03 P2 / edge case: iPhone photos arrive as HEIC and are converted server-side (not rejected).
 * iphone-photo.heic is 400x520 pixels stored with a 90° rotation (display 520x400) and carries EXIF with GPS.
 * oversized.heic is a tiny file whose header declares 8192x5120 (41.9 MP), over the 40 MP pixel limit.
 */
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

beforeEach(truncateAll);
afterAll(closeAll);

describe('HEIC uploads', () => {
  it('converts an iPhone HEIC photo to an upright JPEG with no EXIF or GPS', async () => {
    const out = await validateMedia(fixture('iphone-photo.heic'));
    expect(out.mime).toBe('image/jpeg');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([520, 400]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.bytes.includes(Buffer.from('Apple'))).toBe(false);
  });

  it('rejects a HEIC whose header exceeds the pixel limit before decoding it', async () => {
    const raw = fixture('oversized.heic');
    expect(raw.length).toBeLessThan(64 * 1024);
    const err = await validateMedia(raw).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('INVALID');
    expect((err as DomainError).message).toMatch(/too large/);
  });

  it('still converts AV1-coded HEIF (which the WASM decoder lacks) through sharp', async () => {
    const avif = await sharp({ create: { width: 300, height: 240, channels: 3, background: '#c9a27e' } }).avif().toBuffer();
    avif.write('mif1', 8, 'latin1'); // generic HEIF brand: detected as image/heif, not image/avif
    const out = await validateMedia(avif);
    expect(out.mime).toBe('image/jpeg');
    expect(await sharp(out.bytes).metadata()).toMatchObject({ format: 'jpeg', width: 300, height: 240 });
  });

  it('keeps the friendly message only for HEIC files nothing can decode', async () => {
    const raw = Buffer.from(fixture('iphone-photo.heic'));
    raw.fill(0, 400); // header intact (still detected as HEIC), coded image data destroyed
    const err = await validateMedia(raw).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).message).toMatch(/iPhone photo/);
  });

  it('turns a decode failure after a readable header into a customer-safe error', async () => {
    const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#336699' } }).png({ compressionLevel: 0 }).toBuffer();
    const broken = Buffer.from(png);
    broken.fill(0xff, 200, 2000); // header intact, pixel data corrupted
    const err = await validateMedia(broken).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).message).toMatch(/damaged/);
  });

  it('stores the converted JPEG when a HEIC is ingested', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, (tx) => ingestBytes(tx, ctx, fixture('iphone-photo.heic'), 'product_photo', null, { filename: 'IMG_0001.HEIC' }));
    expect([asset.width, asset.height]).toEqual([520, 400]);
    expect(asset.key).toMatch(/\.jpg$/);
    const [row] = await withTenant(t.workspaceId, (tx) => tx`select mime from assets where id = ${asset.id}`);
    expect(row!.mime).toBe('image/jpeg');
    const stored = await withTenant(t.workspaceId, (tx) => assetBytes(tx, asset.id));
    expect((await sharp(stored).metadata()).format).toBe('jpeg');
  });
});
