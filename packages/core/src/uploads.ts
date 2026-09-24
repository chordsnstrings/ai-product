/// <reference path="./heic-decode.d.ts" />
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import type { Tx } from '@arkiv/db';
import { DomainError, newId } from '@arkiv/shared';
import { saveAsset, type AssetKind } from './assets';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { actorString } from './context';
import { hit } from './rate-limit';
import { quarantineKey, storage } from './storage';
import { holdForReview, nameReviewFlags } from './vision';

/**
 * Upload pipeline (plan 02 §3 layer 4; standard §48 malicious uploads):
 *   presigned PUT → quarantine prefix → validate magic bytes / size / pixels → re-encode (strips EXIF/GPS)
 *   → tenant prefix. Nothing in quarantine is ever served.
 */

export const UPLOAD_LIMITS = {
  image: { maxBytes: 25 * 1024 * 1024, maxPixels: 40_000_000, maxEdge: 4096 },
  video: { maxBytes: 300 * 1024 * 1024, maxDurationMs: 180_000 },
  pdf: { maxBytes: 20 * 1024 * 1024 },
} as const;

const ALLOWED: Record<string, 'image' | 'video' | 'pdf'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'image/avif': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'application/pdf': 'pdf',
};

export async function createUpload(tx: Tx, ctx: TenantContext, kind: AssetKind, declaredMime: string, bytes: number) {
  assertCan(ctx, 'sku.edit');
  await hit(`upload:ws:${ctx.workspaceId}`, 100, 3600, tx);
  const family = ALLOWED[declaredMime];
  if (!family) throw new DomainError('INVALID', 'That file type isn’t supported. Use JPG, PNG, WebP, MP4 or PDF.');
  if (bytes > UPLOAD_LIMITS[family].maxBytes) throw new DomainError('INVALID', 'That file is too large.', { maxBytes: UPLOAD_LIMITS[family].maxBytes });
  const id = newId();
  const key = quarantineKey(ctx.workspaceId, id);
  await tx`insert into uploads (id, workspace_id, kind, status, quarantine_key, declared_mime, bytes, created_by)
           values (${id}, ${ctx.workspaceId}, ${kind}, 'pending', ${key}, ${declaredMime}, ${bytes}, ${actorString(ctx)})`;
  return { uploadId: id, putUrl: await storage().signedPutUrl(key, declaredMime), key };
}

export interface ValidatedMedia {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'application/pdf';
}

const TOO_SMALL = 'That image is too small to use. Please upload at least 800px.';
const TOO_LARGE = 'That image is too large to process.';
/** Final fallback only: the photo is HEIC but neither decoder could read it. */
const HEIC_UNREADABLE = 'We couldn’t read that iPhone photo. Choose “Most Compatible” in Camera settings, or upload a screenshot.';

/** The prebuilt sharp/libvips decodes AVIF but not HEVC-coded HEIF (iPhone HEIC). */
function sharpDecodesHeic(): boolean {
  const heif = (sharp.format as unknown as Record<string, { input?: { fileSuffix?: string[] } } | undefined>).heif;
  return (heif?.input?.fileSuffix ?? []).includes('.heic');
}

/**
 * iPhone HEIC → display-oriented RGB pixels via libheif compiled to WASM (no native dependency), so the photo
 * is converted server-side like any other upload (plan 03 P2). The pixel limit is checked from the container
 * header before any pixel is decoded (decompression bombs), and again on the decoded raster. libheif applies
 * the container's rotation/mirror itself; the pixels carry no metadata, so the re-encode has no EXIF/GPS.
 * Returns null when this decoder can't read the file (e.g. AV1-coded HEIF, which sharp decodes).
 */
async function decodeHeic(raw: Buffer): Promise<ReturnType<typeof sharp> | null> {
  const { default: heic } = await import('heic-decode');
  let frames: Awaited<ReturnType<typeof heic.all>>;
  try {
    frames = await heic.all({ buffer: raw });
  } catch {
    return null;
  }
  try {
    const primary = frames[0];
    if (!primary) return null;
    if (primary.width * primary.height > UPLOAD_LIMITS.image.maxPixels) throw new DomainError('INVALID', TOO_LARGE);
    const decoded = await primary.decode().catch(() => null);
    if (!decoded) return null;
    const { width, height, data } = decoded;
    if (width * height > UPLOAD_LIMITS.image.maxPixels) throw new DomainError('INVALID', TOO_LARGE);
    if (data.byteLength !== width * height * 4) return null;
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } }).removeAlpha();
  } finally {
    frames.dispose();
  }
}

/** Validate untrusted bytes. Throws INVALID with a customer-safe reason. */
export async function validateMedia(raw: Buffer): Promise<ValidatedMedia> {
  const ft = await fileTypeFromBuffer(raw);
  const family = ft ? ALLOWED[ft.mime] : undefined;
  if (!ft || !family) throw new DomainError('INVALID', 'We couldn’t read that file. Try a JPG or PNG.');
  if (raw.length > UPLOAD_LIMITS[family].maxBytes) throw new DomainError('INVALID', 'That file is too large.');
  if (family === 'image') {
    const heif = ft.mime === 'image/heic' || ft.mime === 'image/heif';
    const unreadable = heif ? HEIC_UNREADABLE : 'That image looks damaged or too large to process.';
    // Our sharp build reads HEIC headers but can't decode HEVC pixels, so HEIC goes to the WASM decoder first.
    let img = heif && !sharpDecodesHeic() ? await decodeHeic(raw) : null;
    let hasAlpha = false;
    if (img) {
      const meta = await img.metadata();
      if ((meta.width ?? 0) < 200 || (meta.height ?? 0) < 200) throw new DomainError('INVALID', TOO_SMALL);
    } else {
      try {
        // limitInputPixels rejects decompression bombs before decoding the full raster.
        const s = sharp(raw, { limitInputPixels: UPLOAD_LIMITS.image.maxPixels, failOn: 'error' });
        const meta = await s.metadata();
        if (!meta.width || !meta.height) throw new Error('no dimensions');
        if (meta.width < 200 || meta.height < 200) throw new DomainError('INVALID', TOO_SMALL);
        hasAlpha = !!meta.hasAlpha;
        img = s.rotate(); // apply EXIF orientation before the metadata is dropped
      } catch (e) {
        if (e instanceof DomainError) throw e;
        throw new DomainError('INVALID', unreadable);
      }
    }
    // Re-encode: strips EXIF/GPS metadata. Pixels are only decoded here, so a codec failure surfaces here too.
    const out = img.resize({ width: UPLOAD_LIMITS.image.maxEdge, height: UPLOAD_LIMITS.image.maxEdge, fit: 'inside', withoutEnlargement: true });
    try {
      return hasAlpha
        ? { bytes: await out.png().toBuffer(), mime: 'image/png' }
        : { bytes: await out.jpeg({ quality: 90, mozjpeg: true }).toBuffer(), mime: 'image/jpeg' };
    } catch {
      throw new DomainError('INVALID', unreadable);
    }
  }
  if (family === 'video') return { bytes: raw, mime: 'video/mp4' };
  return { bytes: raw, mime: 'application/pdf' };
}

/** Worker step: move a quarantined upload into the tenant prefix as an asset. */
export async function processUpload(tx: Tx, ctx: TenantContext, uploadId: string, skuId: string | null) {
  const [u] = await tx`select * from uploads where id = ${uploadId} for update`;
  if (!u) throw new DomainError('NOT_FOUND', 'Upload not found');
  if (u.status === 'accepted') return { assetId: u.asset_id as string, replayed: true };
  if (u.status === 'rejected') throw new DomainError('INVALID', u.reject_reason as string);
  let raw: Buffer;
  try {
    raw = await storage().get(u.quarantine_key as string);
  } catch {
    throw new DomainError('INVALID', 'The upload didn’t finish. Please try again.');
  }
  try {
    const v = await validateMedia(raw);
    const asset = await saveAsset(tx, ctx.workspaceId, { bytes: v.bytes, mime: v.mime, kind: u.kind as AssetKind, skuId, source: 'upload', origin: { uploadId, declaredMime: u.declared_mime } });
    await tx`update uploads set status = 'accepted', asset_id = ${asset.id} where id = ${uploadId}`;
    await storage().delete(u.quarantine_key as string);
    return { assetId: asset.id, replayed: false };
  } catch (e) {
    const reason = e instanceof DomainError ? e.message : 'We couldn’t process that file.';
    await tx`update uploads set status = 'rejected', reject_reason = ${reason} where id = ${uploadId}`;
    await storage().delete(u.quarantine_key as string);
    throw e;
  }
}

/** Direct server-side upload path (small files posted to our API rather than presigned PUT). */
export async function ingestBytes(tx: Tx, ctx: TenantContext, raw: Buffer, kind: AssetKind, skuId: string | null, origin: Record<string, unknown> = {}) {
  // Provisional visitors carry an OWNER context on their own PROVISIONAL workspace, so they pass; Viewers and
  // held workspaces do not.
  assertCan(ctx, 'sku.edit');
  await hit(`upload:ws:${ctx.workspaceId}`, 100, 3600, tx);
  const v = await validateMedia(raw);
  const asset = await saveAsset(tx, ctx.workspaceId, { bytes: v.bytes, mime: v.mime, kind, skuId, source: 'upload', origin });
  // Merchant media named as a before/after or showing children waits for compliance review (plan 05 §14).
  if (REVIEWABLE_KINDS.has(kind)) {
    const named = nameReviewFlags(JSON.stringify(origin));
    await holdForReview(tx, [{ assetId: asset.id, flags: { ...named, sources: ['name'] } }]);
  }
  return asset;
}

/** Merchant-supplied media that can end up in an ad (and so in the before/after and minors review). */
const REVIEWABLE_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>(['product_photo', 'reference_view', 'creator_footage', 'historical_creative']);
