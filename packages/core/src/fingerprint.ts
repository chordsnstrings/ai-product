import sharp from 'sharp';
import type { Tx } from '@arkiv/db';
import { DomainError, type EventRefs } from '@arkiv/shared';
import { assetBytes, saveAsset } from './assets';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { DEFAULT_FIDELITY_THRESHOLDS } from './fidelity';
import type { Box, PhotoView } from './intel-schemas';
import { ingestBytes } from './uploads';
import { cutout, dominantColors, usableAssetIds } from './vision';

/**
 * Visual Fingerprint versions (standard §16 "It should be versioned because packaging changes"; §42 "Packaging
 * refresh — create new Visual Fingerprint version; historical creatives remain tied to prior packaging"). Every
 * version is a new row; the previous one is deactivated, never edited. Storyboards pin the version they were drawn
 * for (and scene attempts and creatives record it), so an approved or produced ad keeps the packaging it was made
 * with; a storyboard not yet approved moves to the new version.
 */

/** Why a version was made (visual_fingerprints.reason). */
export type FingerprintReason = 'analysis' | 'added_views' | 'segmented_cutout' | 'packaging_refresh' | 'views_approved' | 'merged';

/** The columns a version carries (anything not given is copied from the version it follows). */
export interface FingerprintFields {
  reference_asset_ids: string[];
  cutout_asset_id: string | null;
  label_text: string | null;
  brand_text: string | null;
  package_type: string | null;
  closure: string | null;
  dominant_colors: string[];
  liquid_color: string | null;
  transparency: string | null;
  critical_regions: CriticalRegion[];
  thresholds: Record<string, unknown>;
  /** Asset id → the view it shows (front, side, back, closure, swatch, in_hand, other). */
  views: Record<string, PhotoView>;
  /** Reference views the merchant approved as showing the current packaging. */
  approved_view_ids: string[];
  label_crop_asset_id: string | null;
  geometry: { silhouette?: string; aspectRatio?: number | null; widthPx?: number; heightPx?: number; measuredAspectRatio?: number };
}

/** A region of a reference photo that must be reproduced exactly (label, closure): §16 "critical regions". */
export interface CriticalRegion {
  kind: 'label' | 'closure' | 'logo';
  assetId: string;
  box: Box;
  cropAssetId?: string | null;
}

/**
 * Write the next Visual Fingerprint version of a SKU: `fields` over the active version (or over nothing, for the
 * first), the old version deactivated, unapproved storyboards re-pinned, VISUAL_FINGERPRINT_VERSIONED emitted.
 * Serialised per SKU by locking the active row. Returns the new version.
 */
export async function versionFingerprint(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  skuId: string,
  fields: Partial<FingerprintFields>,
  opts: { reason: FingerprintReason; payload?: Record<string, unknown>; refs?: EventRefs },
): Promise<{ id: string; version: number; previousId: string | null }> {
  const ws = ctx.workspaceId;
  const [prev] = await tx`select * from visual_fingerprints where sku_id = ${skuId} and workspace_id = ${ws} and active order by version desc limit 1 for update`;
  const [n] = await tx`select coalesce(max(version), 0) + 1 as v from visual_fingerprints where sku_id = ${skuId} and workspace_id = ${ws}`;
  const version = Number(n!.v);
  const base: FingerprintFields = {
    reference_asset_ids: (prev?.reference_asset_ids as string[] | undefined) ?? [],
    cutout_asset_id: (prev?.cutout_asset_id as string | null | undefined) ?? null,
    label_text: (prev?.label_text as string | null | undefined) ?? null,
    brand_text: (prev?.brand_text as string | null | undefined) ?? null,
    package_type: (prev?.package_type as string | null | undefined) ?? null,
    closure: (prev?.closure as string | null | undefined) ?? null,
    dominant_colors: (prev?.dominant_colors as string[] | undefined) ?? [],
    liquid_color: (prev?.liquid_color as string | null | undefined) ?? null,
    transparency: (prev?.transparency as string | null | undefined) ?? null,
    critical_regions: (prev?.critical_regions as CriticalRegion[] | undefined) ?? [],
    thresholds: (prev?.thresholds as Record<string, unknown> | undefined) ?? { ...DEFAULT_FIDELITY_THRESHOLDS },
    views: (prev?.views as Record<string, PhotoView> | undefined) ?? {},
    approved_view_ids: (prev?.approved_view_ids as string[] | undefined) ?? [],
    label_crop_asset_id: (prev?.label_crop_asset_id as string | null | undefined) ?? null,
    geometry: (prev?.geometry as FingerprintFields['geometry'] | undefined) ?? {},
  };
  const row = { ...base, ...fields };
  // Approved views and view tags only ever name this version's own references.
  row.approved_view_ids = row.approved_view_ids.filter((id) => row.reference_asset_ids.includes(id));
  row.views = Object.fromEntries(Object.entries(row.views).filter(([id]) => row.reference_asset_ids.includes(id))) as Record<string, PhotoView>;
  await tx`update visual_fingerprints set active = false where sku_id = ${skuId} and workspace_id = ${ws} and active`;
  const json = (v: unknown) => tx.json(v as never);
  const [fp] = await tx`
    insert into visual_fingerprints (workspace_id, sku_id, version, active, reason, reference_asset_ids, cutout_asset_id, label_text, brand_text,
      package_type, closure, dominant_colors, liquid_color, transparency, critical_regions, thresholds, views, approved_view_ids, label_crop_asset_id, geometry)
    values (${ws}, ${skuId}, ${version}, true, ${opts.reason}, ${row.reference_asset_ids}::uuid[], ${row.cutout_asset_id}, ${row.label_text}, ${row.brand_text},
      ${row.package_type}, ${row.closure}, ${json(row.dominant_colors)}, ${row.liquid_color}, ${row.transparency}, ${json(row.critical_regions)}, ${json(row.thresholds)},
      ${json(row.views)}, ${row.approved_view_ids}::uuid[], ${row.label_crop_asset_id}, ${json(row.geometry)})
    returning id`;
  const id = fp!.id as string;
  // Storyboards not yet approved are drawn and checked against the current packaging; approved and produced ones
  // keep the version they were made for.
  await tx`update storyboards sb set visual_fingerprint_id = ${id}
           from projects p where p.id = sb.project_id and p.workspace_id = sb.workspace_id and p.sku_id = ${skuId}
             and sb.workspace_id = ${ws} and sb.status in ('generating', 'ready')`;
  await emit(tx, ctx, 'VISUAL_FINGERPRINT_VERSIONED', { type: 'sku', id: skuId }, { version, reason: opts.reason, fingerprintId: id, previousId: (prev?.id as string | undefined) ?? null, ...opts.payload }, opts.refs ?? {});
  return { id, version, previousId: (prev?.id as string | undefined) ?? null };
}

/**
 * The fingerprint a piece of work is checked against: the version it pinned (when given and still on file), else the
 * SKU's active version.
 */
export async function fingerprintFor(tx: Tx, skuId: string, pinnedId?: string | null): Promise<Record<string, unknown> | null> {
  if (pinnedId) {
    const [fp] = await tx`select * from visual_fingerprints where id = ${pinnedId} and sku_id = ${skuId}`;
    if (fp) return fp;
  }
  const [fp] = await tx`select * from visual_fingerprints where sku_id = ${skuId} and active order by version desc limit 1`;
  return fp ?? null;
}

/** The fingerprint version a project's current storyboard is pinned to, if any. */
export async function pinnedFingerprintId(tx: Tx, projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  const [r] = await tx`select sb.visual_fingerprint_id from projects p join storyboards sb on sb.id = p.storyboard_id and sb.workspace_id = p.workspace_id where p.id = ${projectId}`;
  return (r?.visual_fingerprint_id as string | null | undefined) ?? null;
}

/**
 * Crop a region of a photo (fractions of the photo, EXIF-rotated) to a PNG. Null when the region is too small to be
 * useful (under 24 px either way) or can't be cut.
 */
export async function cropRegion(photo: Buffer, box: Box): Promise<{ png: Buffer; width: number; height: number } | null> {
  try {
    const meta = await sharp(photo).rotate().metadata();
    const W = meta.autoOrient?.width ?? meta.width ?? 0;
    const H = meta.autoOrient?.height ?? meta.height ?? 0;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const x0 = clamp(box.x);
    const y0 = clamp(box.y);
    const x1 = clamp(box.x + box.w);
    const y1 = clamp(box.y + box.h);
    const region = { left: Math.round(x0 * W), top: Math.round(y0 * H), width: Math.round((x1 - x0) * W), height: Math.round((y1 - y0) * H) };
    if (region.width < 24 || region.height < 24 || region.left + region.width > W || region.top + region.height > H) return null;
    const png = await sharp(photo).rotate().extract(region).png().toBuffer();
    return { png, width: region.width, height: region.height };
  } catch {
    return null;
  }
}

/** The package's measured geometry from a keyed cut-out: the bounding box of its opaque pixels. */
export async function measuredGeometry(cut: Buffer): Promise<{ widthPx: number; heightPx: number; aspectRatio: number } | null> {
  try {
    const trimmed = await sharp(cut).ensureAlpha().trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
    const { width, height } = trimmed.info;
    if (!width || !height) return null;
    return { widthPx: width, heightPx: height, aspectRatio: Math.round((height / width) * 100) / 100 };
  } catch {
    return null;
  }
}

/**
 * The merchant approves which reference photos show the product as it is sold now (standard §16 "approved
 * front/side/back views"). A new version records the approval; ids that aren't references of the active version
 * are refused.
 */
export async function approveFingerprintViews(tx: Tx, ctx: TenantContext, skuId: string, assetIds: readonly string[]) {
  assertCan(ctx, 'sku.edit');
  const [fp] = await tx`select id, reference_asset_ids, approved_view_ids from visual_fingerprints where sku_id = ${skuId} and active for update`;
  if (!fp) throw new DomainError('CONFLICT', 'This product has no packaging fingerprint yet.');
  const refs = (fp.reference_asset_ids as string[]) ?? [];
  const ids = [...new Set(assetIds)];
  if (ids.some((id) => !refs.includes(id))) throw new DomainError('INVALID', 'Choose photos of this product’s current packaging.');
  // Photos held for compliance review, or rejected, can't be approved as references.
  const usable = await usableAssetIds(tx, ids);
  if (usable.length !== ids.length) throw new DomainError('CONFLICT', 'One of these photos is waiting for review and can’t be approved yet.');
  const current = [...((fp.approved_view_ids as string[]) ?? [])].sort();
  if (JSON.stringify(current) === JSON.stringify([...ids].sort())) return { version: null, approved: ids.length };
  const v = await versionFingerprint(tx, ctx, skuId, { approved_view_ids: ids }, { reason: 'views_approved', payload: { approvedViews: ids.length } });
  return { version: v.version, approved: ids.length };
}

/**
 * Packaging refresh (standard §42): new photos of the new packaging become the references of a new fingerprint
 * version, with a new cut-out, colours, geometry and label text (the merchant's, when the label changed). Ads
 * already made — and storyboards already approved — stay tied to the version they were made with.
 */
export async function refreshPackaging(
  tx: Tx,
  ctx: TenantContext,
  skuId: string,
  files: readonly { bytes: Buffer; filename?: string | null }[],
  opts: { labelText?: string | null; note?: string | null } = {},
): Promise<{ version: number | null; added: number; held: number }> {
  assertCan(ctx, 'sku.edit');
  if (!files.length) throw new DomainError('INVALID', 'Add at least one photo of the new packaging.');
  if (files.length > 6) throw new DomainError('INVALID', 'Add up to 6 photos at a time.');
  const [sku] = await tx`select status from skus where id = ${skuId} for update`;
  if (!sku) throw new DomainError('NOT_FOUND', 'Product not found');
  if (!['active', 'out_of_stock'].includes(sku.status as string)) throw new DomainError('CONFLICT', sku.status === 'analyzing' ? 'We’re still reading this product.' : 'This product can’t be updated.');
  const [fp] = await tx`select id, thresholds from visual_fingerprints where sku_id = ${skuId} and active`;
  if (!fp) throw new DomainError('CONFLICT', 'This product has no packaging fingerprint yet — add a photo first.');
  const ids: string[] = [];
  for (const f of files) ids.push((await ingestBytes(tx, ctx, f.bytes, 'reference_view', skuId, { filename: f.filename ?? null, packagingRefresh: true })).id);
  const usable = await usableAssetIds(tx, ids);
  if (!usable.length) return { version: null, added: ids.length, held: ids.length };
  const front = await assetBytes(tx, usable[0]!);
  const cut = await cutout(front);
  const c = await saveAsset(tx, ctx.workspaceId, {
    bytes: cut.png,
    mime: 'image/png',
    kind: 'cutout',
    skuId,
    source: 'generated',
    lineage: { from: usable[0], keyed: cut.keyed, technique: cut.technique, coverage: Math.round(cut.coverage * 1000) / 1000, spread: Math.round(cut.spread * 1000) / 1000, packagingRefresh: true },
  });
  const labelText = opts.labelText?.trim() || undefined;
  const geometry = cut.keyed ? await measuredGeometry(cut.png) : null;
  const v = await versionFingerprint(
    tx,
    ctx,
    skuId,
    {
      // Only the new packaging: the old photos no longer show what is sold.
      reference_asset_ids: usable,
      cutout_asset_id: c.id,
      dominant_colors: await dominantColors(cut.png),
      views: { [usable[0]!]: 'front' },
      approved_view_ids: [],
      critical_regions: [],
      label_crop_asset_id: null,
      geometry: geometry ? { widthPx: geometry.widthPx, heightPx: geometry.heightPx, measuredAspectRatio: geometry.aspectRatio } : {},
      ...(labelText ? { label_text: labelText, thresholds: { ...((fp.thresholds as Record<string, unknown>) ?? {}), labelMustMatch: true } } : {}),
    },
    { reason: 'packaging_refresh', payload: { keyed: cut.keyed, technique: cut.technique, photos: usable.length, note: opts.note?.trim() || null, labelChanged: !!labelText } },
  );
  return { version: v.version, added: ids.length, held: ids.length - usable.length };
}

/** SQL fragment: the active fingerprint of a project's SKU — what a new storyboard is pinned to. */
export const projectFingerprintSql = (tx: Tx, projectId: string) =>
  tx`(select f.id from visual_fingerprints f join projects p on p.sku_id = f.sku_id and p.workspace_id = f.workspace_id where p.id = ${projectId} and f.active limit 1)`;

/** SQL fragment: the fingerprint a scene's storyboard is pinned to — what a scene attempt is checked against. */
export const sceneFingerprintSql = (tx: Tx, sceneId: string) =>
  tx`(select sb.visual_fingerprint_id from scenes s join storyboards sb on sb.id = s.storyboard_id and sb.workspace_id = s.workspace_id where s.id = ${sceneId})`;
