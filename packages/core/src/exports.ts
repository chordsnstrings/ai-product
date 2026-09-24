import type { Tx } from '@arkiv/db';
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
  const [a] = await tx`select a.id, a.lineage, p.id as project_id, p.variant_id, p.experiment_id, p.sku_id
                       from assets a join projects p on p.workspace_id = a.workspace_id and p.id::text = a.lineage->>'projectId'
                       where a.id = ${assetId} and a.workspace_id = ${ctx.workspaceId} and p.id = ${projectId}
                         and a.kind = 'final_export' and a.deleted_at is null`;
  if (!a) return null;
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
