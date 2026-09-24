import type { Tx } from '@arkiv/db';
import { compositeProduct, fullBleedFrame, productionBackdrop, type Aspect } from '@arkiv/media';
import { assetBytes } from './assets';
import { usableAssetIds } from './vision';

/**
 * Exact-product stills (§23 strict product composite; §44 "repair once then composite exact product"). The product
 * pixels always come from the merchant's own photo: a clean cut-out placed on a production backdrop (or a generated
 * environment plate), or — when the photo couldn't be cut out reliably — the reference photo itself, full-bleed.
 * Never a debug placeholder.
 */

export interface ProductImagery {
  cutout: { assetId: string; bytes: Buffer; keyed: boolean } | null;
  reference: { assetId: string; bytes: Buffer } | null;
  palette: string[];
}

/** The active Visual Fingerprint's cut-out (with whether keying succeeded), first reference photo and palette. */
export async function productImagery(tx: Tx, skuId: string): Promise<ProductImagery> {
  const [fp] = await tx`select f.cutout_asset_id, f.reference_asset_ids, f.dominant_colors, a.lineage->>'keyed' as keyed, a.lineage->>'from' as cut_from
                        from visual_fingerprints f left join assets a on a.id = f.cutout_asset_id and a.workspace_id = f.workspace_id
                        where f.sku_id = ${skuId} and f.active`;
  if (!fp) return { cutout: null, reference: null, palette: [] };
  // Media held for compliance review or rejected, or whose rights expired or are frozen by a takedown case, is never
  // drawn into a frame (plan 05 §14–§15) — nor is a cut-out made from such a photo.
  const refId = (await usableAssetIds(tx, (fp.reference_asset_ids as string[] | null) ?? []))[0] ?? null;
  const cutFrom = typeof fp.cut_from === 'string' && /^[0-9a-f-]{36}$/i.test(fp.cut_from) ? fp.cut_from : null;
  const cutSources = fp.cutout_asset_id ? [fp.cutout_asset_id as string, ...(cutFrom ? [cutFrom] : [])] : [];
  const cutUsable = cutSources.length > 0 && (await usableAssetIds(tx, cutSources)).length === cutSources.length;
  return {
    // Cut-outs recorded before keying was tracked were keyed ones (the unkeyed fallback always records keyed=false).
    cutout: fp.cutout_asset_id && cutUsable ? { assetId: fp.cutout_asset_id as string, bytes: await assetBytes(tx, fp.cutout_asset_id as string), keyed: fp.keyed !== 'false' } : null,
    reference: refId ? { assetId: refId, bytes: await assetBytes(tx, refId) } : null,
    palette: ((fp.dominant_colors as string[] | null) ?? []).filter((c) => typeof c === 'string'),
  };
}

export interface ExactFrame {
  bytes: Buffer;
  technique: 'exact_product_composite' | 'reference_photo';
  lineage: Record<string, unknown>;
}

/**
 * An exact-product frame for a scene. A keyed cut-out is composited (with a contact shadow) onto the plate when
 * given, else onto the production backdrop. An unkeyed cut-out is never composited — its photo background would
 * be pasted in as a rectangle — so the reference photo is shown full-bleed instead. Null when there is no
 * product imagery at all.
 */
export async function exactProductFrame(img: ProductImagery, opts: { purpose?: string; plate?: { assetId: string; bytes: Buffer } | null; aspect?: Aspect } = {}): Promise<ExactFrame | null> {
  const aspect = opts.aspect ?? '9x16';
  if (img.cutout?.keyed) {
    const bg = opts.plate?.bytes ?? (await productionBackdrop(aspect, img.palette));
    return {
      bytes: await compositeProduct(bg, img.cutout.bytes, aspect, { scale: opts.purpose === 'cta' ? 0.3 : 0.5, anchor: 'center', shadow: true }),
      technique: 'exact_product_composite',
      lineage: { cutoutAssetId: img.cutout.assetId, ...(opts.plate ? { plateAssetId: opts.plate.assetId } : { backdrop: 'production' }) },
    };
  }
  if (img.reference) return { bytes: await fullBleedFrame(img.reference.bytes, aspect), technique: 'reference_photo', lineage: { referenceAssetId: img.reference.assetId } };
  if (img.cutout) return { bytes: await fullBleedFrame(img.cutout.bytes, aspect), technique: 'reference_photo', lineage: { cutoutAssetId: img.cutout.assetId } };
  return null;
}

/** Shown when a product photo couldn't be cut out: exact composites need a clean shot. */
export const CLEAN_PHOTO_TIP = 'Tip: add a product photo on a plain background and we can place your exact product in more shots.';
