import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Tx } from '@arkiv/db';
import { DomainError, newId, notFound } from '@arkiv/shared';
import { probe, withTempDir } from '@arkiv/media';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { storage, tenantKey } from './storage';

export type AssetKind =
  | 'product_photo'
  | 'cutout'
  | 'reference_view'
  | 'label_crop'
  | 'storyboard_frame'
  | 'scene_render'
  | 'voiceover'
  | 'final_export'
  | 'creator_footage'
  | 'evidence_doc'
  | 'brand_logo'
  | 'historical_creative'
  | 'thumbnail';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip',
};

export interface SaveAssetInput {
  bytes: Buffer;
  mime: string;
  kind: AssetKind;
  skuId?: string | null;
  source: 'upload' | 'generated' | 'import' | 'composed';
  origin?: Record<string, unknown>;
  lineage?: Record<string, unknown>;
  rightsAttestedBy?: string | null;
}

/**
 * Persist bytes to owned storage *immediately* (§39: provider URLs are never durable) and register the asset
 * with checksum and media metadata (§25 final asset integrity).
 */
export async function saveAsset(tx: Tx, workspaceId: string, a: SaveAssetInput) {
  const id = newId();
  const checksum = createHash('sha256').update(a.bytes).digest('hex');
  const key = tenantKey(workspaceId, a.skuId ?? '_', a.kind, `${id}.${EXT[a.mime] ?? 'bin'}`);
  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;
  if (a.mime.startsWith('image/')) {
    const m = await sharp(a.bytes).metadata();
    width = m.width ?? null;
    height = m.height ?? null;
  } else if (a.mime.startsWith('video/') || a.mime.startsWith('audio/')) {
    await withTempDir(async (dir) => {
      const f = path.join(dir, `m.${EXT[a.mime] ?? 'bin'}`);
      await writeFile(f, a.bytes);
      const p = await probe(f);
      width = p.width;
      height = p.height;
      durationMs = p.durationMs;
    });
  }
  await storage().put(key, a.bytes, a.mime);
  await tx`
    insert into assets (id, workspace_id, sku_id, kind, storage_key, mime, bytes, width, height, duration_ms,
      checksum_sha256, source, origin, lineage, rights_attested_by, rights_attested_at)
    values (${id}, ${workspaceId}, ${a.skuId ?? null}, ${a.kind}, ${key}, ${a.mime}, ${a.bytes.length}, ${width},
      ${height}, ${durationMs}, ${checksum}, ${a.source}, ${tx.json((a.origin ?? {}) as never)},
      ${tx.json((a.lineage ?? {}) as never)}, ${a.rightsAttestedBy ?? null}, ${a.rightsAttestedBy ? new Date() : null})`;
  return { id, key, checksum, width, height, durationMs };
}

export async function getAsset(tx: Tx, assetId: string) {
  const [a] = await tx`select * from assets where id = ${assetId} and deleted_at is null`;
  if (!a) throw notFound('Asset not found');
  return a;
}

export async function assetBytes(tx: Tx, assetId: string): Promise<Buffer> {
  const a = await getAsset(tx, assetId);
  return storage().get(a.storage_key as string);
}

/** Authorization happens by reading the row under RLS first; the key is never taken from client input. */
export async function assetUrl(tx: Tx, assetId: string, ttlSeconds = 600, downloadName?: string): Promise<string> {
  const a = await getAsset(tx, assetId);
  return storage().signedGetUrl(a.storage_key as string, ttlSeconds, downloadName);
}

/** Verify stored bytes still match the recorded checksum (Launch Gate: final asset integrity). */
export async function verifyAssetIntegrity(tx: Tx, assetId: string): Promise<boolean> {
  const a = await getAsset(tx, assetId);
  if (!(await storage().exists(a.storage_key as string))) return false;
  const bytes = await storage().get(a.storage_key as string);
  return createHash('sha256').update(bytes).digest('hex') === a.checksum_sha256;
}

export async function storageUsedBytes(tx: Tx): Promise<number> {
  const [r] = await tx`select coalesce(sum(bytes), 0)::bigint as n from assets where deleted_at is null`;
  return Number(r!.n);
}

/** Asset kinds a customer supplied and may delete themselves (standard §40). Generated work is not deleted here. */
const CUSTOMER_DELETABLE = new Set<AssetKind>(['product_photo', 'reference_view', 'creator_footage', 'evidence_doc', 'brand_logo', 'historical_creative']);

/**
 * Delete an uploaded asset (standard §40 "delete uploaded assets … subject to legitimate retention obligations").
 * The asset disappears from the workspace at once. Its stored bytes are deleted too, unless it is retained as
 * evidence behind a claim or is part of a delivered ad — then it is only hidden. The photo a product's current
 * Visual Fingerprint was built from cannot be deleted until the product is catalogued from another photo.
 */
export async function deleteAsset(tx: Tx, ctx: TenantContext, assetId: string): Promise<{ purged: boolean }> {
  assertCan(ctx, 'sku.edit');
  const [a] = await tx`select id, kind, sku_id, storage_key from assets where id = ${assetId} and deleted_at is null for update`;
  if (!a) throw notFound('File not found');
  if (!CUSTOMER_DELETABLE.has(a.kind as AssetKind)) throw new DomainError('FORBIDDEN', 'Only files you uploaded can be deleted here.');
  const [fp] = await tx`select 1 from visual_fingerprints where active and (${assetId} = any(reference_asset_ids) or cutout_asset_id = ${assetId}) limit 1`;
  if (fp) throw new DomainError('CONFLICT', 'This photo is the one we catalogued your product from. Add another photo and re-analyse before deleting it.');
  const [kept] = await tx`
    select exists (select 1 from claim_evidence where source_asset_id = ${assetId}) as evidence,
           exists (select 1 from creatives where ${assetId} = any(final_asset_ids)) as delivered`;
  const retained = !!kept!.evidence || !!kept!.delivered;
  await tx`update assets set deleted_at = now() where id = ${assetId}`;
  if (!retained) await storage().delete(a.storage_key as string);
  await emit(tx, ctx, 'ASSET_DELETED', { type: 'asset', id: assetId }, { kind: a.kind, skuId: a.sku_id ?? null, purged: !retained, retainedFor: retained ? (kept!.evidence ? 'claim_evidence' : 'delivered_creative') : null });
  return { purged: !retained };
}
