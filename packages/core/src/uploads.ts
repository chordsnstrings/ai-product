/// <reference path="./heic-decode.d.ts" />
import { fileTypeFromBuffer } from 'file-type';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeUntrusted, withTempDir, type UntrustedProbe } from '@arkiv/media';
import { malwareScan } from './malware-scan';
import sharp from 'sharp';
import type { Tx } from '@arkiv/db';
import { DomainError, newId } from '@arkiv/shared';
import { saveAsset, type AssetKind } from './assets';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { actorString } from './context';
import { allowKey } from './allowlist';
import { hit } from './rate-limit';
import { quarantineKey, storage } from './storage';
import { holdForReview, uploadReviewFlags } from './vision';

/**
 * Upload pipeline (plan 02 §3 layer 4; standard §48 malicious uploads):
 *   presigned PUT → quarantine prefix → validate magic bytes / size / pixels → re-encode (strips EXIF/GPS)
 *   → tenant prefix. Nothing in quarantine is ever served.
 */

export const UPLOAD_LIMITS = {
  image: { maxBytes: 25 * 1024 * 1024, maxPixels: 40_000_000, maxEdge: 4096 },
  video: { maxBytes: 300 * 1024 * 1024, maxDurationMs: 180_000, maxEdge: 4096, maxStreams: 4 },
  pdf: { maxBytes: 20 * 1024 * 1024, maxPages: 300 },
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
  // Counted in its own short transaction, committed before validation: a rejected (malformed, malicious) upload
  // still spends the budget, and the counter row is not locked across decoding and storage I/O.
  await hit(`upload:ws:${ctx.workspaceId}`, 100, 3600, undefined, { subject: [allowKey.ws(ctx.workspaceId)] });
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
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'video/quicktime' | 'application/pdf';
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
  if (family === 'video') {
    await validateVideo(raw);
    await malwareScan(raw);
    // Stored as what it is: a QuickTime file is never relabelled as MP4.
    return { bytes: raw, mime: ft.mime === 'video/quicktime' ? 'video/quicktime' : 'video/mp4' };
  }
  validatePdf(raw);
  await malwareScan(raw);
  return { bytes: raw, mime: 'application/pdf' };
}

const VIDEO_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'prores']);
const VIDEO_UNREADABLE = 'We couldn’t read that video. Export it again as an MP4 (H.264) and try once more.';

/**
 * Standard §48 "Malicious or malformed upload": the container is parsed by ffprobe in a child process under kernel
 * resource limits (never in the app process), and must hold one playable video track within the duration, dimension
 * and stream-count caps.
 */
async function validateVideo(raw: Buffer): Promise<void> {
  const L = UPLOAD_LIMITS.video;
  let p: UntrustedProbe;
  try {
    p = await withTempDir(async (dir) => {
      const f = path.join(dir, 'upload');
      await writeFile(f, raw);
      return probeUntrusted(f);
    });
  } catch {
    throw new DomainError('INVALID', VIDEO_UNREADABLE);
  }
  const videos = p.streams.filter((s) => s.type === 'video');
  if (videos.length !== 1 || !p.width || !p.height || !p.videoCodec || !VIDEO_CODECS.has(p.videoCodec)) throw new DomainError('INVALID', VIDEO_UNREADABLE);
  if (p.streams.length > L.maxStreams) throw new DomainError('INVALID', 'That video has more tracks than we accept. Export a single video with one audio track.');
  if (p.width > L.maxEdge || p.height > L.maxEdge) throw new DomainError('INVALID', `That video is larger than ${L.maxEdge} pixels on a side. Export it at 1080p or 4K.`);
  if (!(p.durationMs > 0)) throw new DomainError('INVALID', VIDEO_UNREADABLE);
  if (p.durationMs > L.maxDurationMs) throw new DomainError('INVALID', `Videos can be up to ${Math.round(L.maxDurationMs / 60_000)} minutes long.`);
}

/**
 * PDF evidence documents: a real PDF (header and end-of-file marker), a page count within the cap, and no active
 * content (JavaScript, launch or embedded-file actions) — evidence is read by people, never executed.
 */
export function validatePdf(raw: Buffer): void {
  const head = raw.subarray(0, 1024).toString('latin1');
  const tail = raw.subarray(Math.max(0, raw.length - 2048)).toString('latin1');
  if (!/^%PDF-\d\.\d/.test(head) || !tail.includes('%%EOF')) throw new DomainError('INVALID', 'That PDF looks damaged. Export it again and upload the new file.');
  const text = raw.toString('latin1');
  if (/\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction\s*<<[^>]*\/S\s*\/JavaScript)\b/.test(text)) throw new DomainError('INVALID', 'That PDF contains scripts or embedded files. Print it to a plain PDF and upload that.');
  const pages = (text.match(/\/Type\s*\/Page(?!s)\b/g) ?? []).length;
  if (pages > UPLOAD_LIMITS.pdf.maxPages) throw new DomainError('INVALID', `PDFs can have up to ${UPLOAD_LIMITS.pdf.maxPages} pages. Upload the relevant pages.`);
}

/** Worker step: move a quarantined upload into the tenant prefix as an asset. */
export async function processUpload(tx: Tx, ctx: TenantContext, uploadId: string, skuId: string | null, origin: Record<string, unknown> = {}) {
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
    const asset = await saveAsset(tx, ctx.workspaceId, { bytes: v.bytes, mime: v.mime, kind: u.kind as AssetKind, skuId, source: 'upload', origin: { ...origin, uploadId, declaredMime: u.declared_mime } });
    // Same review as a direct upload: media named as a before/after or showing children waits for compliance.
    if (REVIEWABLE_KINDS.has(u.kind as AssetKind)) await holdForReview(tx, [{ assetId: asset.id, flags: uploadReviewFlags(origin) }]);
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
  // Counted in its own short transaction, committed before validation: a rejected (malformed, malicious) upload
  // still spends the budget, and the counter row is not locked across decoding and storage I/O.
  await hit(`upload:ws:${ctx.workspaceId}`, 100, 3600, undefined, { subject: [allowKey.ws(ctx.workspaceId)] });
  const v = await validateMedia(raw);
  const asset = await saveAsset(tx, ctx.workspaceId, { bytes: v.bytes, mime: v.mime, kind, skuId, source: 'upload', origin });
  // Merchant media named or declared as a before/after, or showing children, waits for compliance review (plan 05
  // §14, standard §43). A declared before/after carries the merchant's provenance/permission attestation.
  if (REVIEWABLE_KINDS.has(kind)) await holdForReview(tx, [{ assetId: asset.id, flags: uploadReviewFlags(origin) }]);
  return asset;
}

/** Merchant-supplied media that can end up in an ad (and so in the before/after and minors review). */
const REVIEWABLE_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>(['product_photo', 'reference_view', 'creator_footage', 'historical_creative']);

/** Photos a visitor can add to one preview (the upload module's own limit). */
export const MAX_PREVIEW_PHOTOS = 6;
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif']);

/**
 * Plan 03 P2 "starts uploading the moment a file is chosen (presigned PUT to quarantine)": one quarantined upload
 * per chosen product photo, each with its own short-lived PUT URL. Browsers that report HEIC with no type send
 * image/heic; the bytes are checked on completion regardless of what is declared.
 */
export async function startPhotoUploads(tx: Tx, ctx: TenantContext, files: { mime: string; bytes: number }[]) {
  if (!files.length || files.length > MAX_PREVIEW_PHOTOS) throw new DomainError('INVALID', `Add 1 to ${MAX_PREVIEW_PHOTOS} photos.`);
  const out: { uploadId: string; putUrl: string }[] = [];
  for (const f of files) {
    const mime = f.mime || 'image/heic';
    if (!PHOTO_MIMES.has(mime)) throw new DomainError('INVALID', 'Choose a photo (JPG, PNG, WebP or HEIC).');
    const u = await createUpload(tx, ctx, 'product_photo', mime, f.bytes);
    out.push({ uploadId: u.uploadId, putUrl: u.putUrl });
  }
  return out;
}

/**
 * The browser finished its PUT: validate the quarantined bytes and turn them into an (unattached) product photo.
 * A rejected file is recorded as rejected and reported back — the transaction still commits, so the reason and the
 * quarantine clean-up stick. Completing twice returns the same asset.
 */
export async function completePhotoUpload(tx: Tx, ctx: TenantContext, uploadId: string, filename?: string | null): Promise<{ assetId: string } | { error: string }> {
  assertCan(ctx, 'sku.edit');
  const [u] = await tx`select kind, status from uploads where id = ${uploadId}`;
  if (!u || u.kind !== 'product_photo') throw new DomainError('NOT_FOUND', 'Upload not found. Please add the photo again.');
  try {
    return { assetId: (await processUpload(tx, ctx, uploadId, null, filename ? { filename: filename.slice(0, 200) } : {})).assetId };
  } catch (e) {
    if (e instanceof DomainError && e.code === 'INVALID') return { error: e.message };
    throw e;
  }
}
