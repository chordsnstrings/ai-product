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

/** Validate untrusted bytes. Throws INVALID with a customer-safe reason. */
export async function validateMedia(raw: Buffer): Promise<ValidatedMedia> {
  const ft = await fileTypeFromBuffer(raw);
  const family = ft ? ALLOWED[ft.mime] : undefined;
  if (!ft || !family) throw new DomainError('INVALID', 'We couldn’t read that file. Try a JPG or PNG.');
  if (raw.length > UPLOAD_LIMITS[family].maxBytes) throw new DomainError('INVALID', 'That file is too large.');
  if (family === 'image') {
    let img: ReturnType<typeof sharp>;
    try {
      // limitInputPixels rejects decompression bombs before decoding the full raster.
      img = sharp(raw, { limitInputPixels: UPLOAD_LIMITS.image.maxPixels, failOn: 'error' });
      const meta = await img.metadata();
      if (!meta.width || !meta.height) throw new Error('no dimensions');
      if (meta.width < 200 || meta.height < 200) throw new DomainError('INVALID', 'That image is too small to use. Please upload at least 800px.');
    } catch (e) {
      if (e instanceof DomainError) throw e;
      if (/heif|heic/i.test(ft.mime))
        throw new DomainError('INVALID', 'iPhone HEIC photos need converting. Choose “Most Compatible” in Camera settings, or upload a screenshot.');
      throw new DomainError('INVALID', 'That image looks damaged or too large to process.');
    }
    // Re-encode: normalizes orientation and strips EXIF/GPS metadata.
    const hasAlpha = (await img.metadata()).hasAlpha;
    const out = img.rotate().resize({ width: UPLOAD_LIMITS.image.maxEdge, height: UPLOAD_LIMITS.image.maxEdge, fit: 'inside', withoutEnlargement: true });
    return hasAlpha
      ? { bytes: await out.png().toBuffer(), mime: 'image/png' }
      : { bytes: await out.jpeg({ quality: 90, mozjpeg: true }).toBuffer(), mime: 'image/jpeg' };
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
  return saveAsset(tx, ctx.workspaceId, { bytes: v.bytes, mime: v.mime, kind, skuId, source: 'upload', origin });
}
