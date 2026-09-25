import type { Tx } from '@arkiv/db';
import { Taxonomy } from '@arkiv/shared';
import type { TenantContext } from './context';
import { emit } from './events';

/**
 * The genome version a new creative is recorded against (standard Appendix A "all taxonomies are versioned"): the
 * current canonical taxonomy — the latest approved version that records its families (plan 05 §19), else the
 * Appendix A version the code ships with. Same rule as canonicalTaxonomy(), as a SQL fragment for inserts.
 */
export const GENOME_VERSION_SQL = (tx: Tx) => tx`select coalesce(max(version), ${Taxonomy.version}) from taxonomy_versions where spec ? 'families'`;

/** A new version of an existing creative: what it is, what it was derived from and what changed. */
export interface CreativeVersion {
  skuId: string;
  parentCreativeId: string;
  projectId: string | null;
  genome: Record<string, unknown>;
  finalAssetIds: string[];
  composition: unknown;
  /** The creative variables this version changed relative to its parent (e.g. ['hook']). */
  changedVariables: string[];
  experimentId?: string | null;
  variantId?: string | null;
  storyboardId?: string | null;
  /** The version's SRT captions asset (plan 06 Phase 3 #6). */
  captionsAssetId?: string | null;
}

/**
 * Record a derived creative (Appendix B Creative: CREATIVE_VERSIONED). Every re-render or recomposition of a
 * delivered creative — a hook variant today — goes through here, so lineage (parent → child, what changed) is
 * written with the row and can be rebuilt from events alone (§36). Runs in the caller's transaction.
 */
export async function versionCreative(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, v: CreativeVersion): Promise<string> {
  // A version keeps its parent's AI-content flags (standard §40): it reuses the parent's media.
  const [parent] = await tx`select ai_generated, synthetic_people from creatives where id = ${v.parentCreativeId} and workspace_id = ${ctx.workspaceId}`;
  const [cr] = await tx`insert into creatives (workspace_id, sku_id, origin, parent_creative_id, project_id, genome, genome_version, final_asset_ids, composition, ai_generated, synthetic_people, captions_asset_id)
                        values (${ctx.workspaceId}, ${v.skuId}, 'generated', ${v.parentCreativeId}, ${v.projectId}, ${tx.json(v.genome as never)}, (${GENOME_VERSION_SQL(tx)}),
                                ${v.finalAssetIds}, ${tx.json((v.composition ?? null) as never)}, ${!!parent?.ai_generated}, ${!!parent?.synthetic_people}, ${v.captionsAssetId ?? null})
                        returning id`;
  const id = cr!.id as string;
  await emit(
    tx,
    ctx,
    'CREATIVE_VERSIONED',
    { type: 'creative', id },
    { parentCreativeId: v.parentCreativeId, changedVariables: v.changedVariables, variantId: v.variantId ?? null, projectId: v.projectId },
    { skuId: v.skuId, projectId: v.projectId, experimentId: v.experimentId ?? null, variantId: v.variantId ?? null, storyboardId: v.storyboardId ?? null },
  );
  return id;
}
