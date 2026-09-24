import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, Taxonomy } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { authorize, settle } from './cost-governor';
import { emit } from './events';
import { Genome } from './intel-schemas';
import { mockGenome } from './mock-intel';
import { holdForReview } from './vision';
import { canonicalTaxonomy, taxonomyRemaps, type TaxonomyFamily } from './taxonomy';
import { llmJson, routedLines } from './model-gateway';
import { enqueue, Queues } from './outbox';
import { evidenceFloor } from './statistics';

/**
 * CreativeGenomeService (§19): every historical or new ad gets a versioned structured genome using the
 * controlled taxonomy (Appendix A). Free-text never silently becomes a canonical category.
 */

export async function importHistoricalCreative(
  tx: Tx,
  ctx: TenantContext,
  input: {
    skuId: string;
    /**
     * Other products this ad also shows (§48 "one ad contains multiple SKUs"): recorded explicitly, while results,
     * learnings and the claims check stay with the primary SKU.
     */
    secondarySkuIds?: string[];
    copy: string;
    platform?: 'meta' | 'tiktok' | null;
    adId?: string | null;
    assetId?: string | null;
    /** The merchant declared that people under 18 appear (§48): the footage waits for compliance review. */
    minorsPresent?: boolean;
  },
) {
  // Import enqueues model spend (genome extraction), so it is a create-level right, not view.
  assertCan(ctx, 'sku.create');
  const secondary = [...new Set(input.secondarySkuIds ?? [])].filter((id) => id !== input.skuId);
  if (secondary.length) {
    // Only this workspace's own products (RLS scopes the lookup; an id from elsewhere simply isn't found).
    const found = await tx`select id from skus where id = any(${secondary}::uuid[]) and workspace_id = ${ctx.workspaceId}`;
    if (found.length !== secondary.length) throw new DomainError('INVALID', 'One of the other products shown isn’t in this workspace.');
  }
  const refs: Record<string, unknown> = input.adId && input.platform ? { [`${input.platform}_ad_ids`]: [input.adId], copy: input.copy } : { copy: input.copy };
  if (input.minorsPresent) refs.minorsDeclared = true;
  const [c] = await tx`
    insert into creatives (workspace_id, sku_id, secondary_sku_ids, origin, platform_refs, final_asset_ids)
    values (${ctx.workspaceId}, ${input.skuId}, ${secondary}, 'imported', ${tx.json(refs as never)}, ${input.assetId ? [input.assetId] : []})
    returning id`;
  // Merchant footage involving minors needs rights and platform/policy review before any use (§48): held until a
  // compliance reviewer decides, and never a production input meanwhile (usableAssetIds).
  if (input.minorsPresent && input.assetId) await holdForReview(tx, [{ assetId: input.assetId, flags: { beforeAfter: false, possibleMinor: true, sources: ['declared'] } }]);
  await emit(tx, ctx, 'CREATIVE_IMPORTED', { type: 'creative', id: c!.id as string }, { platform: input.platform ?? null, secondarySkus: secondary.length, minorsDeclared: !!input.minorsPresent });
  await enqueue(tx, ctx.workspaceId, Queues.extractGenome, { creativeId: c!.id });
  return c!.id as string;
}

export async function extractGenome(ctx: TenantContext, creativeId: string) {
  const ws = ctx.workspaceId;
  const cr = await withTenant(ws, async (tx) => (await tx`select * from creatives where id = ${creativeId}`)[0]);
  if (!cr || cr.genome) return false;
  const copy = String((cr.platform_refs as Record<string, unknown>)?.copy ?? '');
  const auth = await withTenant(ws, async (tx) =>
    authorize(tx, ctx, { purpose: 'storyboard', lines: await routedLines(tx, ws, [{ task: 'genome.extract', kind: 'llm', inputTokens: 3_000, outputTokens: 600 }]), idempotencyKey: `genome:${creativeId}` }),
  );
  try {
    const r = await llmJson({
      ctx,
      token: auth.token,
      task: 'genome.extract',
      subject: { type: 'creative', id: creativeId },
      template: 'genome',
      content: [{ type: 'untrusted', sourceId: 'ad_copy', text: copy.slice(0, 8000) }, { type: 'text', text: `Taxonomy v${Taxonomy.version}.` }],
      schema: Genome,
      mock: () => mockGenome(copy),
      effort: 'low',
      maxTokens: 800,
    });
    await withTenant(ws, async (tx) => {
      // Stored against the current canonical taxonomy: values renamed or deprecated (with a replacement) since
      // Appendix A follow the approved remaps (plan 05 §19).
      const tax = await canonicalTaxonomy(tx);
      const genome = canonicalGenome(r.data, await taxonomyRemaps(tx));
      await tx`update creatives set genome = ${tx.json(genome as never)}, genome_version = ${tax.version} where id = ${creativeId}`;
      await emit(tx, ctx, 'GENOME_EXTRACTED', { type: 'creative', id: creativeId }, { angle: genome.angle, version: tax.version });
      await settle(tx, ctx, auth.authorizationId, 'consumed');
    });
    return true;
  } catch (e) {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
    throw e;
  }
}

/**
 * Creative Map (plan 03 A2): angles × treatments with counts and best signal state. Historical creatives that are
 * visually different but strategically identical collapse into the same cell (§19).
 */
export async function creativeMap(tx: Tx, skuId: string) {
  const rows = await tx`
    with items as (
      select genome->>'angle' as angle, genome->>'treatment' as treatment, null::text as state
      from creatives where sku_id = ${skuId} and origin = 'imported' and genome is not null
      union all
      select genes->>'angle', genes->>'treatment', state from experiments where sku_id = ${skuId}
    )
    select angle, treatment, count(*)::int as n,
           max(case state when 'ACTIONABLE' then 4 when 'DIRECTIONAL' then 3 when 'GATHERING_SIGNAL' then 2 when 'INCONCLUSIVE' then 1 else 0 end) as best
    from items where angle is not null group by 1, 2`;
  const state = (b: number) => (['untested', 'inconclusive', 'gathering', 'directional', 'actionable'] as const)[b] ?? 'untested';
  const tax = await canonicalTaxonomy(tx);
  return {
    angles: tax.families.angle,
    treatments: tax.families.treatment,
    cells: rows.map((r) => ({ angle: r.angle as string, treatment: r.treatment as string, count: r.n as number, state: state(Number(r.best)) })),
  };
}

/** Delivery an ad needs before its territory counts as tested (the small-account CTR evidence floor, §21). */
export const COVERAGE_MIN_IMPRESSIONS = evidenceFloor('ctr', 0).minTrials;

export interface Coverage {
  /** Meaningful tests per angle. */
  angles: Map<string, number>;
  /** Tested cells: `angle|hookMechanism` and `angle|t:treatment`. */
  cells: Set<string>;
}

/**
 * Territory that has genuinely been tested for a SKU (§20 coverage gap; Appendix C "one trivial/under-delivered
 * ad should not mark territory complete"): experiments that reached a readable result (directional, actionable
 * or inconclusive) or delivered past the evidence floor, plus imported historical ads whose linked delivery passed
 * it. Archived, never-launched and still-gathering tests below the floor don't count.
 */
export async function meaningfulCoverage(tx: Tx, skuId: string): Promise<Coverage> {
  const rows = await tx`
    select e.genes->>'angle' as angle, e.genes->>'hookMechanism' as hook, e.genes->>'treatment' as treatment from experiments e
    where e.sku_id = ${skuId}
      and (e.state in ('DIRECTIONAL','ACTIONABLE','INCONCLUSIVE')
           or exists (select 1 from experiment_results r where r.experiment_id = e.id and r.metric = 'ctr' and r.trials >= ${COVERAGE_MIN_IMPRESSIONS}))
    union all
    select c.genome->>'angle', c.genome->>'hookMechanism', c.genome->>'treatment' from creatives c
    where c.sku_id = ${skuId} and c.origin = 'imported' and c.genome is not null
      and (select coalesce(sum(o.impressions), 0) from performance_observations o where o.creative_id = c.id and o.superseded_at is null) >= ${COVERAGE_MIN_IMPRESSIONS}`;
  const angles = new Map<string, number>();
  const cells = new Set<string>();
  for (const r of rows) {
    if (!r.angle) continue;
    const a = r.angle as string;
    angles.set(a, (angles.get(a) ?? 0) + 1);
    if (r.hook) cells.add(`${a}|${r.hook as string}`);
    if (r.treatment) cells.add(`${a}|t:${r.treatment as string}`);
  }
  return { angles, cells };
}

const GENOME_KEYS: [string, TaxonomyFamily][] = [['angle', 'angle'], ['secondaryAngle', 'angle'], ['hookMechanism', 'hook'], ['proofMechanism', 'proof'], ['treatment', 'treatment']];

/** A genome with renamed/deprecated taxonomy values replaced by their canonical successors. */
export function canonicalGenome<G extends Record<string, unknown>>(g: G, remaps: Record<TaxonomyFamily, Record<string, string>>): G {
  const out: Record<string, unknown> = { ...g };
  for (const [key, fam] of GENOME_KEYS) {
    const v = out[key];
    if (typeof v === 'string' && remaps[fam][v]) out[key] = remaps[fam][v];
  }
  return out as G;
}
