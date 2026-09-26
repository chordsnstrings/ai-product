import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, Taxonomy } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { authorize, settle } from './cost-governor';
import { emit } from './events';
import { BODY_BEATS, FUNNEL_INTENTS, Genome, POLISH_STYLES, type Proposal } from './intel-schemas';
import { brandBrainFor } from './brand';
import { currentClaimVersions } from './claims';
import { RULES_VERSION } from './compliance';
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
      inputRefs: { creativeId, taxonomyVersion: Taxonomy.version },
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
      const [lin] = await tx`select parent_creative_id, final_asset_ids, secondary_sku_ids from creatives where id = ${creativeId}`;
      await tx`update creatives set genome = ${tx.json(importedGenome(genome, { sourceAssetIds: (lin?.final_asset_ids as string[] | undefined) ?? [], parentCreativeId: (lin?.parent_creative_id as string | null | undefined) ?? null, promptVersion: r.promptVersion, model: r.model }) as never)}, genome_version = ${tax.version} where id = ${creativeId}`;
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

// ───────────── Genomes of the ads we make (standard §19 genome families) ─────────────

/** The genome's own schema version (genome_version stays the taxonomy version its values come from). */
export const GENOME_SCHEMA_VERSION = 2;
/** Version of the production pipeline a generated genome records (composition manifest + claims rules). */
export const PRODUCTION_VERSION = `composition@1+${RULES_VERSION}`;

const PROOF_BEAT: Record<string, (typeof BODY_BEATS)[number]> = {
  TEXTURE_DEMO: 'texture_demo',
  APPLICATION_DEMO: 'application',
  INGREDIENT_EXPLANATION: 'ingredient_education',
  CUSTOMER_TESTIMONIAL: 'testimonial',
  CREATOR_TESTIMONIAL: 'testimonial',
  FOUNDER_EXPLANATION: 'ingredient_education',
  EXPERT_EXPLANATION: 'ingredient_education',
  PRODUCT_COMPARISON: 'comparison',
};
const PURPOSE_BEAT: Record<string, (typeof BODY_BEATS)[number] | null> = {
  hook: null,
  problem: 'problem',
  product_reveal: 'product_reveal',
  demonstration: 'application',
  proof: null, // the concept's proof mechanism says which kind
  benefit: 'benefit',
  routine: 'routine',
  cta: 'cta',
};
const POLISH: Record<string, (typeof POLISH_STYLES)[number]> = { RAW_UGC: 'raw_ugc', POLISHED_UGC: 'polished_ugc', CREATOR: 'polished_ugc', FOUNDER: 'raw_ugc', PRODUCT_ONLY: 'studio', PREMIUM_STUDIO: 'studio', MOTION_GRAPHICS: 'studio', AI_TALENT: 'polished_ugc', AI_PRODUCT: 'studio', HYBRID: 'mixed' };
const INTENT: Record<string, (typeof FUNNEL_INTENTS)[number]> = { performance: 'conversion', ugc_review: 'consideration', explainer: 'consideration', premium: 'awareness' };

export interface GeneratedGenomeInput {
  durationMs: number;
  hasVoiceover: boolean;
  hasCaptions: boolean;
  syntheticVoice?: boolean;
  hookText?: string | null;
  /** A version of a delivered creative (a hook variant, a bonus hook): its parent and what changed. */
  parentCreativeId?: string | null;
  changedVariables?: string[];
  variantId?: string | null;
  /** Extra lineage kept with the genome (e.g. the statement map). */
  extraLineage?: Record<string, unknown>;
}

/**
 * The genome of an ad we produced (§19), built deterministically from what made it — the concept, the storyboard and
 * its scenes, each scene's accepted version (technique, model, prompt version), the claims its lines use (with the
 * claim version each was at), the Visual Fingerprint and Brand Brain versions it was made with, and its experiment
 * and variant. Top-level keys keep the canonical taxonomy genes (angle, hookMechanism, proofMechanism, treatment) that
 * coverage, the Creative Map and taxonomy remaps read; the families hold the rest.
 */
export async function genomeForGenerated(tx: Tx, projectId: string, input: GeneratedGenomeInput): Promise<Record<string, unknown>> {
  const [p] = await tx`select p.id, p.sku_id, p.goal, p.experiment_id, p.variant_id, p.selected_concept_id, p.storyboard_id,
                              c.proposal, c.prompt_version as concept_prompt, c.model as concept_model, c.brand_brain_version_id as concept_brand,
                              sb.hook_text, sb.cta_text, sb.visual_fingerprint_id, sb.brand_brain_version_id
                       from projects p
                       left join concepts c on c.id = p.selected_concept_id and c.workspace_id = p.workspace_id
                       left join storyboards sb on sb.id = p.storyboard_id and sb.workspace_id = p.workspace_id
                       where p.id = ${projectId}`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  const proposal = (p.proposal ?? {}) as Partial<Proposal>;
  const scenes = p.storyboard_id
    ? await tx`select s.id, s.position, s.purpose, s.duration_ms, s.production_mode, s.shows_human_skin, s.claim_ids,
                      v.technique, v.model, v.prompt_version, v.asset_id, v.lineage
               from scenes s left join scene_versions v on v.id = s.current_version_id and v.workspace_id = s.workspace_id
               where s.storyboard_id = ${p.storyboard_id} order by s.position`
    : [];
  const total = Math.max(1, scenes.reduce((n, s) => n + Number(s.duration_ms), 0));
  const starts: number[] = [];
  scenes.reduce((t, s) => (starts.push(t), t + Number(s.duration_ms)), 0);
  const share = (pred: (s: Record<string, unknown>) => boolean) => Math.round((scenes.filter(pred).reduce((n, s) => n + Number(s.duration_ms), 0) / total) * 100) / 100;
  const firstAt = (pred: (s: Record<string, unknown>) => boolean) => {
    const i = scenes.findIndex(pred);
    return i < 0 ? null : Math.round(starts[i]! / 100) / 10;
  };
  const productScene = (s: Record<string, unknown>) => ['STRICT_COMPOSITE', 'HYBRID', 'REAL_ASSET_REMIX'].includes(s.production_mode as string) || s.purpose === 'product_reveal';
  const synthetic = (s: Record<string, unknown>) => ['GENERATIVE_INTERACTION', 'HYBRID'].includes(s.production_mode as string);
  const claimIds = [...new Set(scenes.flatMap((s) => (s.claim_ids as string[] | null) ?? []))];
  const claimRows = claimIds.length ? await tx`select id, mandatory_qualifier from claims where id = any(${claimIds}::uuid[])` : [];
  const [fp] = p.visual_fingerprint_id ? await tx`select reference_asset_ids, cutout_asset_id from visual_fingerprints where id = ${p.visual_fingerprint_id}` : [];
  const brand = await brandBrainFor(tx, p.sku_id as string);
  const first = scenes[0];
  const beats = scenes
    .slice(1)
    .map((s) => (s.purpose === 'proof' ? (PROOF_BEAT[proposal.proofMechanism ?? ''] ?? 'social_proof') : PURPOSE_BEAT[s.purpose as string] ?? null))
    .filter((b): b is (typeof BODY_BEATS)[number] => !!b);
  const hookText = input.hookText ?? (p.hook_text as string | null) ?? null;
  const [ingredient] = proposal.angle === 'INGREDIENT_EDUCATION'
    ? await tx`select value_text from product_facts where sku_id = ${p.sku_id} and normalized_key = 'key_ingredients' and status <> 'SUPERSEDED' order by (state = 'DECIDED') desc, observed_at desc limit 1`
    : [];
  const promptVersions = Object.fromEntries(
    [
      ['concepts', p.concept_prompt as string | null],
      ...scenes.filter((s) => s.prompt_version).map((s) => [`scene${Number(s.position) + 1}`, s.prompt_version as string] as const),
    ].filter(([, v]) => !!v),
  );
  const models = [...new Set([p.concept_model as string | null, ...scenes.map((s) => s.model as string | null)].filter((m): m is string => !!m && m !== 'n/a'))];
  const durationSec = Math.round(input.durationMs / 1000);
  return {
    schemaVersion: GENOME_SCHEMA_VERSION,
    // Canonical taxonomy genes (Appendix A), where coverage, the Creative Map and remaps read them.
    angle: proposal.angle ?? null,
    secondaryAngle: null,
    hookMechanism: proposal.hookMechanism ?? null,
    proofMechanism: proposal.proofMechanism ?? null,
    treatment: proposal.treatment ?? null,
    hookText,
    customerProblem: proposal.customerTension ?? null,
    durationSec,
    hasCaptions: input.hasCaptions,
    hasVoiceover: input.hasVoiceover,
    offer: null,
    strategy: {
      angle: proposal.angle ?? null,
      secondaryAngle: null,
      customerProblem: proposal.customerTension ?? null,
      desiredOutcome: proposal.hypothesis ?? null,
      objection: proposal.angle === 'OBJECTION_HANDLING' ? (proposal.customerTension ?? null) : null,
      benefit: proposal.claimWordings?.[0] ?? null,
      ingredientProposition: (ingredient?.value_text as string | undefined)?.split(',')[0]?.trim() || null,
      offer: null,
      funnelIntent: INTENT[(p.goal as string) ?? 'performance'] ?? 'conversion',
      emotionalFrame: null,
      primaryVariable: proposal.primaryVariable ?? null,
    },
    hook: {
      text: hookText,
      mechanism: proposal.hookMechanism ?? null,
      firstFrameSubject: !first ? null : first.shows_human_skin ? 'hands' : productScene(first) ? 'product' : 'lifestyle',
      productRevealSec: firstAt(productScene),
      faceRevealSec: firstAt((s) => !!s.shows_human_skin),
      firstMotion: first ? ((first.technique as string | null) ?? null) : null,
    },
    body: { sequence: beats, proof: proposal.proofMechanism ?? null, strategy: proposal.bodyStrategy ?? null, cta: (p.cta_text as string | null) ?? null },
    production: {
      durationSec,
      sceneCount: scenes.length,
      cutsPerMinute: scenes.length > 1 ? Math.round(((scenes.length - 1) / (total / 60_000)) * 10) / 10 : 0,
      humanScreenRatio: share((s) => !!s.shows_human_skin),
      productScreenRatio: share(productScene),
      syntheticRatio: share(synthetic),
      captions: input.hasCaptions,
      voice: !input.hasVoiceover ? 'none' : input.syntheticVoice === false ? 'voiceover_human' : 'voiceover_synthetic',
      music: 'none',
      polish: POLISH[proposal.treatment ?? ''] ?? null,
      modes: scenes.map((s) => s.production_mode as string),
      techniques: scenes.map((s) => (s.technique as string | null) ?? null),
    },
    compliance: {
      claimIds,
      claimVersionIds: await currentClaimVersions(tx, claimIds),
      qualifiers: [...new Set(claimRows.map((c) => c.mandatory_qualifier as string | null).filter((q): q is string => !!q))],
      disclosures: [brand?.brain.disclosures ?? null].filter((d): d is string => !!d),
      impliedClaimFlags: [],
      beforeAfter: false,
      creatorConnection: 'none',
    },
    lineage: {
      sourceAssetIds: [...new Set([...((fp?.reference_asset_ids as string[] | undefined) ?? []), ...(fp?.cutout_asset_id ? [fp.cutout_asset_id as string] : [])])],
      parentCreativeId: input.parentCreativeId ?? null,
      experimentId: (p.experiment_id as string | null) ?? null,
      variantId: input.variantId ?? (p.variant_id as string | null) ?? null,
      variantRole: input.parentCreativeId ? 'variant' : p.experiment_id ? 'master' : 'single',
      changedVariables: input.changedVariables ?? [],
      conceptId: (p.selected_concept_id as string | null) ?? null,
      storyboardId: (p.storyboard_id as string | null) ?? null,
      promptVersions,
      models,
      productionVersion: PRODUCTION_VERSION,
      visualFingerprintId: (p.visual_fingerprint_id as string | null) ?? null,
      brandBrainVersionId: (p.brand_brain_version_id as string | null) ?? (p.concept_brand as string | null) ?? null,
      ...(input.extraLineage ?? {}),
    },
  };
}

/**
 * The stored genome of an imported ad (§19): the analyst's reading of it with the families nested the same way as
 * a generated ad's (strategy, hook, body, production, compliance, lineage), taxonomy genes kept at the top level.
 */
export function importedGenome(g: Genome, lineage: { sourceAssetIds: string[]; parentCreativeId: string | null; promptVersion: string; model: string }): Record<string, unknown> {
  return {
    ...g,
    schemaVersion: GENOME_SCHEMA_VERSION,
    strategy: {
      angle: g.angle,
      secondaryAngle: g.secondaryAngle,
      customerProblem: g.customerProblem,
      desiredOutcome: g.desiredOutcome ?? null,
      objection: g.objection ?? null,
      benefit: g.benefit ?? null,
      ingredientProposition: g.ingredientProposition ?? null,
      offer: g.offer,
      funnelIntent: g.funnelIntent ?? null,
      emotionalFrame: g.emotionalFrame ?? null,
    },
    hook: { text: g.hookText, mechanism: g.hookMechanism, firstFrameSubject: g.firstFrameSubject ?? null, productRevealSec: g.productRevealSec, faceRevealSec: g.faceRevealSec, firstMotion: g.firstMotion ?? null },
    body: { sequence: g.bodySequence ?? [], proof: g.proofMechanism },
    production: {
      durationSec: g.durationSec,
      sceneCount: g.sceneCount ?? null,
      cutsPerMinute: g.cutsPerMinute ?? null,
      humanScreenRatio: g.humanScreenRatio ?? null,
      productScreenRatio: g.productScreenRatio ?? null,
      syntheticRatio: null,
      captions: g.hasCaptions,
      voice: g.voice ?? (g.hasVoiceover ? 'voiceover_human' : 'none'),
      music: g.music ?? null,
      polish: g.polish ?? null,
    },
    compliance: { claimIds: [], claimVersionIds: {}, qualifiers: [], disclosures: [], impliedClaimFlags: g.impliedClaimFlags ?? [], beforeAfter: g.beforeAfter ?? false, creatorConnection: g.creatorConnection ?? null },
    lineage: { sourceAssetIds: lineage.sourceAssetIds, parentCreativeId: lineage.parentCreativeId, experimentId: null, variantRole: 'imported', changedVariables: [], promptVersions: { genome: lineage.promptVersion }, models: [lineage.model] },
  };
}
