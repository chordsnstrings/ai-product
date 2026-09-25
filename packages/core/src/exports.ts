import type { Tx } from '@arkiv/db';
import { zipSync } from 'fflate';
import { assetBytes } from './assets';
import type { TenantContext } from './context';
import { emit } from './events';
import { projectVisitor, recordFunnel } from './funnel';

export interface ExportedAsset {
  assetId: string;
  projectId: string;
  variantId: string | null;
  experimentId: string | null;
  aspect: string | null;
}

/**
 * A customer downloaded a finished ad (plan 04 L9 activation; Appendix B VARIANT_EXPORTED). The asset must be a
 * final export of the given project — the project is what the caller checked access and refunds against. Records
 * ASSET_EXPORTED with the project and variant it belongs to (so churn and COGS projections can key on the project),
 * plus VARIANT_EXPORTED when the ad is an experiment variant: a hook variant carries its own variantId in lineage;
 * an experiment's master export is its control variant (projects.variant_id). Returns null when the asset is not
 * one of the project's exports.
 */
export async function recordAssetExport(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, assetId: string, projectId: string): Promise<ExportedAsset | null> {
  const [a] = await tx`select a.id, a.kind, a.lineage, p.id as project_id, p.variant_id, p.experiment_id, p.sku_id
                       from assets a join projects p on p.workspace_id = a.workspace_id and p.id::text = a.lineage->>'projectId'
                       where a.id = ${assetId} and a.workspace_id = ${ctx.workspaceId} and p.id = ${projectId}
                         and a.kind in ('final_export', 'captions') and a.deleted_at is null`;
  if (!a) return null;
  // The SRT captions file (plan 06 Phase 3 #6) is a download of the ad's text: recorded, never counted as a video export.
  if (a.kind === 'captions') {
    await emit(tx, ctx, 'ASSET_EXPORTED', { type: 'asset', id: assetId }, { aspect: null, projectId, variantId: null, captions: true }, { projectId, skuId: a.sku_id as string });
    return { assetId, projectId, variantId: null, experimentId: (a.experiment_id as string | null) ?? null, aspect: null };
  }
  const lineage = (a.lineage ?? {}) as { aspect?: string; variantId?: string };
  const variantId = lineage.variantId ?? (a.variant_id as string | null) ?? null;
  const experimentId = (a.experiment_id as string | null) ?? null;
  const out: ExportedAsset = { assetId, projectId, variantId, experimentId, aspect: lineage.aspect ?? null };
  const refs = { projectId, skuId: a.sku_id as string, variantId, experimentId };
  await emit(tx, ctx, 'ASSET_EXPORTED', { type: 'asset', id: assetId }, { aspect: out.aspect, projectId, variantId }, refs);
  if (variantId) await emit(tx, ctx, 'VARIANT_EXPORTED', { type: 'variant', id: variantId }, { assetId, aspect: out.aspect, projectId, experimentId }, { ...refs, assetId });
  const visitorId = await projectVisitor(tx, ctx.workspaceId, projectId);
  await recordFunnel('ASSET_EXPORTED', { workspaceId: ctx.workspaceId, visitorId, props: { aspect: out.aspect, projectId, variantId } }, tx);
  return out;
}

/**
 * P10 "Download all" (plan 03 P10): every finished export of the project — the ad in each format, plus the offer's
 * bonus hook versions — in one zip (stored, not re-compressed: MP4 is compressed already). Each file counts as an
 * export like a single download. Null when the project has nothing delivered.
 */
export async function deliveryBundle(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, projectId: string): Promise<{ zip: Uint8Array; files: number } | null> {
  const [p] = await tx`select p.final_creative_id, p.bonus_hook_creative_id, s.name as sku_name from projects p join skus s on s.id = p.sku_id
                       where p.id = ${projectId} and p.workspace_id = ${ctx.workspaceId} and p.state = 'COMPLETE'`;
  if (!p?.final_creative_id) return null;
  const creatives = await tx`select id, final_asset_ids, captions_asset_id from creatives where workspace_id = ${ctx.workspaceId}
                             and id = any(${[p.final_creative_id as string, ...(p.bonus_hook_creative_id ? [p.bonus_hook_creative_id as string] : [])]}::uuid[])`;
  const base = String(p.sku_name).replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '') || 'arkiv-ad';
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const c of creatives) {
    const bonus = c.id === p.bonus_hook_creative_id;
    for (const assetId of (c.final_asset_ids as string[]) ?? []) {
      const exported = await recordAssetExport(tx, ctx, assetId, projectId);
      if (!exported) continue;
      const name = `${base}${bonus ? '-alt-hook' : ''}-${exported.aspect ?? assetId.slice(0, 8)}.mp4`;
      files[name] = [new Uint8Array(await assetBytes(tx, assetId)), { level: 0 }];
    }
    // The master's SRT captions travel with it (the bonus hook has its own opening line, so its own SRT).
    if (c.captions_asset_id && (await recordAssetExport(tx, ctx, c.captions_asset_id as string, projectId))) {
      files[`${base}${bonus ? '-alt-hook' : ''}.srt`] = [new Uint8Array(await assetBytes(tx, c.captions_asset_id as string)), { level: 0 }];
    }
  }
  const count = Object.keys(files).length;
  return count ? { zip: zipSync(files), files: count } : null;
}
