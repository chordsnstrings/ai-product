import { withTenant, type Tx } from '@arkiv/db';
import { Taxonomy } from '@arkiv/shared';
import type { TenantContext } from './context';
import { authorize, settle } from './cost-governor';
import { emit } from './events';
import { Genome } from './intel-schemas';
import { mockGenome } from './mock-intel';
import { llmJson } from './model-gateway';
import { enqueue, Queues } from './outbox';
import { GENOME_SYSTEM } from './prompts';

/**
 * CreativeGenomeService (§19): every historical or new ad gets a versioned structured genome using the
 * controlled taxonomy (Appendix A). Free-text never silently becomes a canonical category.
 */

export async function importHistoricalCreative(
  tx: Tx,
  ctx: TenantContext,
  input: { skuId: string; secondarySkuIds?: string[]; copy: string; platform?: 'meta' | 'tiktok' | null; adId?: string | null; assetId?: string | null },
) {
  const [c] = await tx`
    insert into creatives (workspace_id, sku_id, secondary_sku_ids, origin, platform_refs, final_asset_ids)
    values (${ctx.workspaceId}, ${input.skuId}, ${input.secondarySkuIds ?? []}, 'imported',
            ${tx.json(input.adId && input.platform ? { [`${input.platform}_ad_ids`]: [input.adId], copy: input.copy } : { copy: input.copy })},
            ${input.assetId ? [input.assetId] : []})
    returning id`;
  await emit(tx, ctx, 'CREATIVE_IMPORTED', { type: 'creative', id: c!.id as string }, { platform: input.platform ?? null });
  await enqueue(tx, ctx.workspaceId, Queues.extractGenome, { creativeId: c!.id });
  return c!.id as string;
}

export async function extractGenome(ctx: TenantContext, creativeId: string) {
  const ws = ctx.workspaceId;
  const cr = await withTenant(ws, async (tx) => (await tx`select * from creatives where id = ${creativeId}`)[0]);
  if (!cr || cr.genome) return false;
  const copy = String((cr.platform_refs as Record<string, unknown>)?.copy ?? '');
  const auth = await withTenant(ws, (tx) =>
    authorize(tx, ctx, { purpose: 'storyboard', lines: [{ kind: 'llm', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 3_000, outputTokens: 600 }], idempotencyKey: `genome:${creativeId}` }),
  );
  try {
    const r = await llmJson({
      ctx,
      token: auth.token,
      task: 'genome.extract',
      subject: { type: 'creative', id: creativeId },
      system: GENOME_SYSTEM,
      content: [{ type: 'untrusted', sourceId: 'ad_copy', text: copy.slice(0, 8000) }, { type: 'text', text: `Taxonomy v${Taxonomy.version}.` }],
      schema: Genome,
      mock: () => mockGenome(copy),
      effort: 'low',
      maxTokens: 800,
    });
    await withTenant(ws, async (tx) => {
      await tx`update creatives set genome = ${tx.json(r.data as never)}, genome_version = ${Taxonomy.version} where id = ${creativeId}`;
      await emit(tx, ctx, 'GENOME_EXTRACTED', { type: 'creative', id: creativeId }, { angle: r.data.angle, version: Taxonomy.version });
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
  return {
    angles: Taxonomy.angle,
    treatments: Taxonomy.treatment,
    cells: rows.map((r) => ({ angle: r.angle as string, treatment: r.treatment as string, count: r.n as number, state: state(Number(r.best)) })),
  };
}
