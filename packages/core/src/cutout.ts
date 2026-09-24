import { withTenant, type Tx } from '@arkiv/db';
import { logger } from '@arkiv/shared/log';
import { assetBytes, saveAsset } from './assets';
import type { TenantContext } from './context';
import { emit } from './events';
import { CUTOUT_TASK, removeBackground } from './model-gateway';
import { dominantColors } from './vision';

/**
 * Background removal for the product cut-out (plan 06 Phase 1 #6, design M3). Analysis keys the photo for free;
 * when keying couldn't separate the product (a lifestyle or busy background) or only just could (a busy border),
 * the background-removal route gets one paid try, where the cut-out is first used: the storyboard's frames, under
 * that storyboard's Cost Governor authorization (the free preview's $0.20 cap is already spent on extraction and
 * concepts). A clean result versions the Visual Fingerprint, so frames and production use it from then on; an
 * answer that isn't usable is not paid for twice for the same photo. Any failure keeps the keyed or framed cut-out.
 */

/** Border spread above which even a keyed cut-out gets a provider pass (keying may have eaten into the product). */
export const SEGMENT_SPREAD = 0.15;

export interface CutoutState {
  fingerprintId: string;
  cutoutAssetId: string | null;
  /** The photo the cut-out was made from. */
  photoAssetId: string | null;
  keyed: boolean;
  spread: number;
  technique: string | null;
  /** The route already answered for this photo (successfully or not usable): never paid for again. */
  attempted: boolean;
  /** Staff keep the task routed; without a route there is nothing to call. */
  routed: boolean;
}

export async function cutoutState(tx: Tx, skuId: string): Promise<CutoutState | null> {
  const [fp] = await tx`select f.id, f.cutout_asset_id, f.reference_asset_ids, a.lineage
                        from visual_fingerprints f left join assets a on a.id = f.cutout_asset_id and a.workspace_id = f.workspace_id
                        where f.sku_id = ${skuId} and f.active`;
  if (!fp) return null;
  const lineage = (fp.lineage as { from?: string; keyed?: boolean; spread?: number; technique?: string } | null) ?? {};
  const photo = lineage.from ?? ((fp.reference_asset_ids as string[] | null) ?? [])[0] ?? null;
  const [done] = photo
    ? await tx`select 1 from provider_jobs where task = ${CUTOUT_TASK} and subject_type = 'sku' and subject_id = ${skuId}
                 and input_refs->>'photoAssetId' = ${photo} and status = 'succeeded' limit 1`
    : [];
  const [routed] = await tx`select 1 from model_routes where task = ${CUTOUT_TASK}`;
  return {
    fingerprintId: fp.id as string,
    cutoutAssetId: (fp.cutout_asset_id as string | null) ?? null,
    photoAssetId: photo,
    keyed: lineage.keyed !== false,
    spread: Number(lineage.spread ?? 0),
    technique: lineage.technique ?? null,
    attempted: !!done,
    routed: !!routed,
  };
}

/** Whether the cut-out is worth one background-removal call (and a Cost Governor line for it). */
export function wantsSegmentation(s: CutoutState | null): boolean {
  if (!s || !s.routed || !s.photoAssetId || s.attempted || s.technique === 'segmentation' || s.technique === 'alpha_channel') return false;
  return !s.keyed || s.spread > SEGMENT_SPREAD;
}

const log = logger('cutout');

export type SegmentOutcome = { status: 'skipped' } | { status: 'failed'; error: string } | { status: 'not_aligned'; jobId: string } | { status: 'segmented'; jobId: string; cutoutAssetId: string; version: number };

/**
 * Try the background-removal route for the SKU's cut-out under `token` (whose authorization carries the line).
 * On a clean, aligned result the Visual Fingerprint gets a new version with the segmented cut-out.
 */
export async function segmentCutout(opts: { ctx: TenantContext; token: string; skuId: string }): Promise<SegmentOutcome> {
  const { ctx, token, skuId } = opts;
  const ws = ctx.workspaceId;
  const s = await withTenant(ws, (tx) => cutoutState(tx, skuId));
  if (!wantsSegmentation(s)) return { status: 'skipped' };
  const photoAssetId = s!.photoAssetId!;
  const photo = await withTenant(ws, (tx) => assetBytes(tx, photoAssetId));
  let r: Awaited<ReturnType<typeof removeBackground>>;
  try {
    r = await removeBackground({ ctx, token, task: CUTOUT_TASK, subject: { type: 'sku', id: skuId }, inputRefs: { photoAssetId, cutoutAssetId: s!.cutoutAssetId }, image: photo });
  } catch (e) {
    // Outage, kill switch, budget or provider refusal: the keyed or framed cut-out stays (never blocks the work).
    log.warn('background removal failed; keeping the keyed cut-out', { workspaceId: ws, skuId, error: (e as Error).message.slice(0, 200) });
    return { status: 'failed', error: (e as Error).message };
  }
  if (!r.aligned) return { status: 'not_aligned', jobId: r.jobId };
  const colors = await dominantColors(r.png);
  return withTenant(ws, async (tx) => {
    const [fp] = await tx`select * from visual_fingerprints where id = ${s!.fingerprintId} and active for update`;
    // The product was re-analysed meanwhile: its new fingerprint has its own cut-out.
    if (!fp) return { status: 'not_aligned' as const, jobId: r.jobId };
    const c = await saveAsset(tx, ws, {
      bytes: r.png,
      mime: 'image/png',
      kind: 'cutout',
      skuId,
      source: 'generated',
      lineage: { from: photoAssetId, keyed: true, technique: 'segmentation', segmentation: r.technique, model: r.modelVersion, providerJobId: r.jobId, promptVersion: r.promptVersion, coverage: Math.round(r.coverage * 1000) / 1000, replaces: s!.cutoutAssetId },
    });
    const [v] = await tx`select coalesce(max(version), 0) + 1 as v from visual_fingerprints where sku_id = ${skuId}`;
    await tx`update visual_fingerprints set active = false where sku_id = ${skuId}`;
    await tx`insert into visual_fingerprints (workspace_id, sku_id, version, reference_asset_ids, cutout_asset_id, label_text, brand_text, package_type, closure,
               dominant_colors, liquid_color, transparency, critical_regions, thresholds)
             values (${ws}, ${skuId}, ${v!.v}, ${fp.reference_asset_ids}, ${c.id}, ${fp.label_text}, ${fp.brand_text}, ${fp.package_type}, ${fp.closure},
               ${tx.json(colors)}, ${fp.liquid_color}, ${fp.transparency}, ${tx.json(fp.critical_regions as never)}, ${tx.json(fp.thresholds as never)})`;
    await emit(tx, ctx, 'VISUAL_FINGERPRINT_VERSIONED', { type: 'sku', id: skuId }, { version: v!.v, keyed: true, technique: 'segmentation' }, { providerJobId: r.jobId });
    return { status: 'segmented' as const, jobId: r.jobId, cutoutAssetId: c.id, version: Number(v!.v) };
  });
}
