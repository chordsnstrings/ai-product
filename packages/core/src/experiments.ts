import { withTenant, type Tx } from '@arkiv/db';
import { assertAssetUsable, creativeSourceAssets } from './asset-rights';
import { DomainError, measurementContextPlatform, newId, type ExperimentState, type MeasurementContext, type SignalState } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { actorString } from './context';
import { emit } from './events';
import { confoundRunning, CONTEXT_CHANGE_KINDS, LIVE_STATES, recordExperimentApproval, setExperimentState, weakenLearnings } from './experiment-state';
import { authorizeFromQuote, renderQuote } from './render-quotes';
import { available, lockEntitlement } from './ledger';
import type { Proposal } from './intel-schemas';
import { enqueue, priorityFor, queueFor, Queues } from './outbox';
import { recordFatigue } from './fatigue';
import { FRESHNESS_DAYS } from './performance';
import { approveForProduction } from './production';
import { planSteps } from './progress';
import { transition } from './projects';
import { STORYBOARD_STEPS } from './storyboard';
import { assertStockCleared } from './stock';
import {
  baselineFrom,
  compareVariants,
  DEFAULT_BASELINES,
  nextLearningState,
  posterior,
  probAbove,
  toRate,
  type BaselinePool,
  type ComparisonResult,
  type RateMetric,
  type VariantEvidence,
} from './statistics';

export { setExperimentState, EXPERIMENT_NEXT, canExperimentTransition, onMaterialProductChange, weakenLearnings, sweepStaleLearnings, CONTEXT_CHANGE_KINDS, LEARNING_REVALIDATION_DAYS } from './experiment-state';

/**
 * Experiment Engine (§20) + learning (§21). CONTROLLED experiments change a limited set of variables and keep
 * the rest stable; EXPLORATORY ones may change many, and the system never claims to know which variable caused
 * the result. Results are computed per measurement context and attribution window — never averaged across
 * platforms or measurement bases (§30, §48).
 */

const HELD_DEFAULT = ['body', 'offer', 'cta', 'product', 'duration'];

/**
 * Variant code for ad names (auto-linking, §30): AK-<catalogue no>-<letter> for a SKU's first experiment and
 * AK-<catalogue no>-<n><letter> for its n-th, so codes never repeat within a workspace (unique index).
 */
export function variantCode(catalogueNo: number, index: number, seq = 1) {
  return `AK-${String(catalogueNo).padStart(3, '0')}-${seq > 1 ? seq : ''}${String.fromCharCode(65 + index)}`;
}
/** Finds a variant code in an ad name: 3+ digit catalogue numbers, optional experiment sequence. */
export const VARIANT_CODE_RE = /AK-\d{3,}-\d*[A-Z]/;

/** Proposal variable → the experiment gene that carries its value (hook text lives on the variant's label). */
const GENE_OF: Record<string, string> = { angle: 'angle', proof: 'proofMechanism', format: 'treatment' };

/**
 * Turn an accepted recommendation (or a merchant-chosen concept) into an experiment + creative-test project.
 * The storyboard is generated immediately; spend happens only when the merchant approves it in Studio
 * (approveExperiment), so the experiment starts as RECOMMENDED (from a recommendation) or DRAFT (§35).
 *
 * The variants are the master plus up to two hook variants that change only the opening (and, with a control, the
 * merchant's current ad). Without a control only the hook is compared, so the hook is the experiment's primary
 * variable: a proposal about an angle, proof or format keeps it as its declared variable and the experiment is
 * EXPLORATORY for it — a result never claims the declared variable caused anything (§20).
 */
export async function createExperiment(
  tx: Tx,
  ctx: TenantContext,
  input: { skuId: string; proposal: Proposal; recommendationId?: string | null; slot?: 'EXPLOIT' | 'EXPAND' | 'EXPLORE' | null; controlCreativeId?: string | null },
) {
  assertCan(ctx, 'experiment.create');
  const p = input.proposal;
  const projectId = newId();
  const x = await insertExperiment(tx, ctx, { ...input, projectId });
  await tx`insert into projects (id, workspace_id, sku_id, experiment_id, variant_id, kind, state, created_by)
           values (${projectId}, ${ctx.workspaceId}, ${input.skuId}, ${x.experimentId}, ${x.masterVariantId}, 'creative_test', 'CONCEPTS_READY', ${actorString(ctx)})`;
  const [concept] = await tx`insert into concepts (workspace_id, sku_id, project_id, batch, idx, proposal, is_pick, prompt_version, model)
                             values (${ctx.workspaceId}, ${input.skuId}, ${projectId}, 1, 'A', ${tx.json(p as never)}, true, 'recommendation', 'n/a') returning id`;
  // Storyboard straight away (the approval boundary before expensive production, §13).
  const [sb] = await tx`insert into storyboards (workspace_id, project_id, concept_id, status) values (${ctx.workspaceId}, ${projectId}, ${concept!.id}, 'generating') returning id`;
  await transition(tx, ctx, projectId, 'CONCEPT_SELECTED', { patch: { selected_concept_id: concept!.id, storyboard_id: sb!.id } });
  await planSteps(tx, ctx.workspaceId, sb!.id as string, STORYBOARD_STEPS);
  await enqueue(tx, ctx.workspaceId, queueFor(Queues.generateStoryboard, ctx), { projectId, storyboardId: sb!.id, conceptId: concept!.id, actor: ctx.actor, experiment: true }, { priority: priorityFor(ctx) });
  const expRefs = { experimentId: x.experimentId, skuId: input.skuId, projectId, variantId: x.masterVariantId, storyboardId: sb!.id as string, recommendationId: input.recommendationId ?? null };
  await emit(tx, ctx, 'EXPERIMENT_CREATED', { type: 'experiment', id: x.experimentId }, { mode: x.mode, slot: input.slot, primaryVariable: x.primaryVariable, declaredVariable: p.primaryVariable }, expRefs);
  if (input.recommendationId) {
    await tx`update recommendations set status = 'accepted', experiment_id = ${x.experimentId} where id = ${input.recommendationId}`;
    await emit(tx, ctx, 'RECOMMENDATION_ACCEPTED', { type: 'recommendation', id: input.recommendationId }, { experimentId: x.experimentId }, expRefs);
  }
  return { experimentId: x.experimentId, projectId, storyboardId: sb!.id as string };
}

/**
 * The experiment rows for a proposal whose master is `projectId`: the experiment, an optional control, the master
 * variant (the project) and up to two hook variants. Shared by a new test (createExperiment) and a product added
 * through the free preview that a subscriber makes with one of their Creative Tests (produceWithCreativeTest).
 */
async function insertExperiment(
  tx: Tx,
  ctx: TenantContext,
  input: { skuId: string; proposal: Proposal; projectId: string; recommendationId?: string | null; slot?: 'EXPLOIT' | 'EXPAND' | 'EXPLORE' | null; controlCreativeId?: string | null },
) {
  const p = input.proposal;
  // §48: an ad whose creator rights ended (or that is frozen or held) can't be re-run as a control — the merchant is
  // told why and offered replacement footage; its past results are untouched.
  if (input.controlCreativeId) await assertAssetUsable(tx, await creativeSourceAssets(tx, input.controlCreativeId), 'Your current ad');
  const declared = p.primaryVariable;
  const primaryVariable = input.controlCreativeId ? declared : 'hook';
  const controlled = declared === 'hook' || !!input.controlCreativeId;
  const mode = controlled && p.riskProfile !== 'exploratory' ? 'CONTROLLED' : 'EXPLORATORY';
  // Locked: the SKU's experiment sequence (and so its variant codes) can't be taken twice by concurrent creates.
  const [sku] = await tx`select catalogue_no from skus where id = ${input.skuId} for update`;
  if (!sku) throw new DomainError('NOT_FOUND', 'Product not found');
  const [count] = await tx`select count(*)::int as n from experiments where sku_id = ${input.skuId}`;
  const seq = Number(count!.n) + 1;
  const code = (i: number) => variantCode(sku.catalogue_no as number, i, seq);
  const expId = newId();
  const genes = { angle: p.angle, hookMechanism: p.hookMechanism, proofMechanism: p.proofMechanism, treatment: p.treatment, declaredVariable: declared };
  await tx`
    insert into experiments (id, workspace_id, sku_id, hypothesis, rationale, primary_variable, controlled_variables, primary_metric,
      expected_learning, if_test_fails, mode, state, portfolio_slot, recommendation_id, genes, created_by)
    values (${expId}, ${ctx.workspaceId}, ${input.skuId}, ${p.hypothesis}, ${p.whyNow}, ${primaryVariable},
      ${mode === 'CONTROLLED' ? HELD_DEFAULT : []}, ${primaryVariable === 'hook' ? 'hold_rate' : 'ctr'}, ${p.expectedLearning},
      ${p.ifTestFails}, ${mode}, ${input.recommendationId ? 'RECOMMENDED' : 'DRAFT'}, ${input.slot ?? null}, ${input.recommendationId ?? null},
      ${tx.json(genes as never)}, ${actorString(ctx)})`;
  // Variants: optional control (existing creative) + master + up to two economical hook variants (§5).
  let i = 0;
  if (input.controlCreativeId) {
    const [cid] = await tx`insert into variants (workspace_id, experiment_id, label, code, role, creative_id, changed_variables, held_constant)
                           values (${ctx.workspaceId}, ${expId}, 'Current control', ${code(i++)}, 'control',
                                   ${input.controlCreativeId}, '{}', ${HELD_DEFAULT}) returning id`;
    await tx`update experiments set control_variant_id = ${cid!.id} where id = ${expId}`;
  }
  const [master] = await tx`
    insert into variants (workspace_id, experiment_id, label, code, role, project_id, changed_variables, held_constant, genes)
    values (${ctx.workspaceId}, ${expId}, ${p.hookOptions[0]!}, ${code(i++)}, 'variant', ${input.projectId},
            ${input.controlCreativeId ? [declared] : []}, ${mode === 'CONTROLLED' ? HELD_DEFAULT : []}, ${tx.json({ ...genes, hook: p.hookOptions[0] } as never)})
    returning id`;
  for (const hook of p.hookOptions.slice(1, 3)) {
    await tx`insert into variants (workspace_id, experiment_id, label, code, role, changed_variables, held_constant, genes)
             values (${ctx.workspaceId}, ${expId}, ${hook}, ${code(i++)}, 'variant', ${['hook']},
                     ${[...HELD_DEFAULT, 'scenes_2_plus', 'voiceover']}, ${tx.json({ ...genes, hook } as never)})`;
  }
  return { experimentId: expId, masterVariantId: master!.id as string, mode, primaryVariable };
}

/** Project states in which a project is already being (or has been) produced. */
const PRODUCTION_OR_DONE = ['STORYBOARD_APPROVED', 'RENDER_RESERVED', 'RENDERING', 'QA_RUNNING', 'COMPOSING', 'PLATFORM_VARIANTS', 'FINAL_QA', 'COMPLETE'];

/**
 * A subscriber made a storyboard through the product funnel (/start → ideas → storyboard) and produces it with one of
 * their plan's Creative Tests instead of paying the standalone price (§5: Standalone is "one standard finished ad
 * outside a subscription"). The funnel project becomes the master of a new experiment for its chosen idea, then the
 * test's spend is approved exactly as in Studio: a render quote priced against this storyboard, the Cost Governor
 * authorization made from it in this transaction (the Creative Test is reserved there), and the approval recorded
 * once. A replay (double click, retried request) returns the experiment without spending again.
 */
export async function produceWithCreativeTest(tx: Tx, ctx: TenantContext, projectId: string): Promise<{ experimentId: string; projectId: string; replayed: boolean }> {
  assertCan(ctx, 'spend.creative_test');
  const [p] = await tx`select id, state, kind, sku_id, experiment_id, storyboard_id, selected_concept_id, entitlement_unit, revision_free from projects
                       where id = ${projectId} and workspace_id = ${ctx.workspaceId} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  // A free re-plan ("Not right?", §48) is made at no cost; it never spends one of the plan's Creative Tests.
  if (p.revision_free && !PRODUCTION_OR_DONE.includes(p.state as string)) throw new DomainError('CONFLICT', 'This re-plan is free — no Creative Test needed. Go back to the storyboard to make it.');
  if (PRODUCTION_OR_DONE.includes(p.state as string)) {
    if (p.entitlement_unit === 'creative_test' && p.experiment_id) return { experimentId: p.experiment_id as string, projectId, replayed: true };
    throw new DomainError('CONFLICT', 'This ad is already in production.');
  }
  if (p.state !== 'STORYBOARD_READY' || !p.storyboard_id) throw new DomainError('CONFLICT', 'The storyboard isn’t ready yet.');
  // Reopened after a blocked line: it was already paid for or already used a test, so it is finished, not bought again.
  if (p.entitlement_unit) throw new DomainError('CONFLICT', 'This ad is already paid for — finish it from the storyboard.');
  const [paid] = await tx`select 1 from purchases where project_id = ${projectId} and workspace_id = ${ctx.workspaceId} and status = 'paid'`;
  if (paid) throw new DomainError('CONFLICT', 'Already paid — production is starting.');
  await lockEntitlement(tx, ctx.workspaceId);
  if ((await available(tx, 'creative_test', ctx.workspaceId)) < 1) {
    throw new DomainError('PAYMENT_REQUIRED', 'No Creative Tests left this period. Upgrade, wait for your plan to renew, or make this ad outside your plan.');
  }
  let experimentId = p.experiment_id as string | null;
  if (!experimentId) {
    const [c] = await tx`select proposal from concepts where id = ${p.selected_concept_id} and project_id = ${projectId}`;
    if (!c) throw new DomainError('CONFLICT', 'Choose an idea first.');
    const proposal = c.proposal as Proposal;
    const x = await insertExperiment(tx, ctx, { skuId: p.sku_id as string, proposal, projectId });
    experimentId = x.experimentId;
    // The funnel project becomes the test's master: its production is a Creative Test from here on.
    await tx`update projects set experiment_id = ${experimentId}, variant_id = ${x.masterVariantId}, kind = 'creative_test' where id = ${projectId}`;
    await emit(tx, ctx, 'EXPERIMENT_CREATED', { type: 'experiment', id: experimentId }, { mode: x.mode, slot: null, primaryVariable: x.primaryVariable, declaredVariable: proposal.primaryVariable, source: 'funnel' }, {
      experimentId,
      skuId: p.sku_id as string,
      projectId,
      variantId: x.masterVariantId,
      storyboardId: p.storyboard_id as string,
    });
  }
  const q = await renderQuote(tx, ctx, experimentId);
  if (q.blockedReason) throw new DomainError(q.entitlementAvailable ? 'CONFLICT' : 'PAYMENT_REQUIRED', q.blockedReason);
  await approveExperiment(tx, ctx, experimentId, { quoteId: q.quoteId });
  return { experimentId, projectId, replayed: false };
}

/**
 * The merchant approves a test's spend (§35 → APPROVED → PRODUCING; Appendix B EXPERIMENT_APPROVED): the master
 * production is approved against a Creative Test and the approval is recorded and evented once — a replay (double
 * click, retried request) changes nothing and emits nothing.
 */
export async function approveExperiment(tx: Tx, ctx: TenantContext, experimentId: string, opts: { quoteId?: string } = {}): Promise<{ changed: boolean; projectId: string }> {
  assertCan(ctx, 'spend.creative_test');
  const [e] = await tx`select id, state, sku_id, approved_at from experiments where id = ${experimentId} for update`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const [v] = await tx`select project_id from variants where experiment_id = ${experimentId} and project_id is not null order by code limit 1`;
  if (!v) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const projectId = v.project_id as string;
  if (e.approved_at) return { changed: false, projectId };
  if (!['DRAFT', 'RECOMMENDED', 'APPROVED'].includes(e.state as string)) throw new DomainError('CONFLICT', 'This test has already moved past approval.');
  // §42: an out-of-stock product is flagged before production; it goes ahead once the merchant says what for.
  await assertStockCleared(tx, e.sku_id as string);
  // With a render quote (the customer app always sends one, §38): the Cost Governor authorization is made now, in
  // this transaction, against the storyboard and rates the merchant was shown; a refusal rolls the approval back.
  if (opts.quoteId) await authorizeFromQuote(tx, ctx, experimentId, opts.quoteId);
  // The project's transition to STORYBOARD_APPROVED records the approval (syncExperimentWithProject); a project
  // approved earlier (a replay) is recorded here. Either way it happens once.
  await approveForProduction(tx, ctx, projectId, 'creative_test');
  await recordExperimentApproval(tx, ctx, experimentId, projectId);
  return { changed: true, projectId };
}

/** Link a platform ad to a variant (manual, or automatic from the variant code in the ad name). */
export async function linkAdToVariant(tx: Tx, ctx: TenantContext, platform: 'meta' | 'tiktok', adId: string, variantId: string) {
  // Rewrites performance attribution, so it needs the same right as creating the experiment.
  assertCan(ctx, 'experiment.create');
  const [v] = await tx`select id, creative_id from variants where id = ${variantId}`;
  if (!v) throw new DomainError('NOT_FOUND', 'Variant not found');
  await tx`update performance_observations set variant_id = ${variantId}, creative_id = ${v.creative_id ?? null}
           where platform = ${platform} and ad_id = ${adId}`;
  if (v.creative_id) {
    await tx`update creatives set platform_refs = jsonb_set(coalesce(platform_refs, '{}'), ${`{${platform}_ad_ids}`},
               coalesce(platform_refs->${platform + '_ad_ids'}, '[]'::jsonb) || to_jsonb(${adId}::text)) where id = ${v.creative_id}`;
  }
  // Re-attribution of existing observations: no integration subject; the variant and creative are refs.
  await emit(tx, ctx, 'PERFORMANCE_INGESTED', null, { linkedAd: adId, platform }, { variantId, creativeId: (v.creative_id as string | null) ?? null });
}

/**
 * Link an ad to the variant whose code its name carries. Codes are unique per workspace, and only an experiment
 * that can be running (ready to run, or gathering signal onward) receives results — never an archived or
 * pre-launch one.
 */
export async function autoLinkByCode(tx: Tx, platform: 'meta' | 'tiktok', adId: string, adName: string | null): Promise<string | null> {
  const m = adName ? VARIANT_CODE_RE.exec(adName.toUpperCase()) : null;
  if (!m) return null;
  const [v] = await tx`select v.id, v.creative_id from variants v join experiments e on e.id = v.experiment_id and e.workspace_id = v.workspace_id
                       where v.code = ${m[0]} and e.state in ${tx(LIVE_STATES as ExperimentState[])}
                       order by e.created_at desc limit 1`;
  if (!v) return null;
  await tx`update performance_observations set variant_id = ${v.id}, creative_id = ${v.creative_id ?? null} where platform = ${platform} and ad_id = ${adId}`;
  return v.id as string;
}

interface ObsAgg {
  variant_id: string;
  measurement_context: MeasurementContext;
  attribution_window: string;
  impressions: number;
  clicks: number;
  purchases: number;
  video_starts: number;
  video_75: number;
  spend_micros: number;
  purchase_value_micros: number;
  days: number;
  optimization_event: string;
  campaign_type: string;
  /** Distinct native currencies in the sum; money is read in the reporting currency (§47). */
  currencies: number;
  unconverted: number;
}

export interface VariantRow {
  id: string;
  role: string;
  label: string;
  code?: string;
  genes?: Record<string, unknown> | null;
}

/**
 * A result that would be actionable or directional while an operational confounder (stock-out, site outage,
 * price change…) overlapped the test is OPERATIONALLY_CONFOUNDED instead (§45): it must not create or strengthen a
 * learning.
 */
export function withConfounders(state: ExperimentState, confounders: number): ExperimentState {
  return confounders > 0 && (state === 'ACTIONABLE' || state === 'DIRECTIONAL') ? 'OPERATIONALLY_CONFOUNDED' : state;
}

/** A platform-scoped learning never carries to the other platform (§21); a blended one only to other SKUs. */
export const doNotGeneralizeTo = (platform: 'meta' | 'tiktok' | 'blended'): string[] =>
  platform === 'meta' ? ['tiktok', 'other_skus'] : platform === 'tiktok' ? ['meta', 'other_skus'] : ['other_skus'];

/** Stands for the merchant's existing ad in a learning; it is never matched across experiments. */
export const CONTROL_VALUE = 'current control';

/** From the context the observations were measured in — a CSV import is scoped to the platform it came from. */
const platformOf = measurementContextPlatform;
const platformLabel = (p: string) => (p === 'meta' ? 'Meta' : p === 'tiktok' ? 'TikTok' : 'blended data');
const metricLabel = (m: string) => m.replace('_', ' ');
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The value a variant carries for `variable`: its hook text for a hook, the gene for angle / proof / format. A
 * control's value isn't comparable across experiments (null); `variable` without a gene has no value either.
 */
export function geneValue(v: VariantRow, variable: string, experimentGenes: Record<string, unknown> = {}): string | null {
  if (v.role === 'control') return null;
  if (variable === 'hook') return v.label;
  const g = GENE_OF[variable];
  const val = g ? (v.genes?.[g] ?? experimentGenes[g]) : null;
  return typeof val === 'string' && val ? val : null;
}

export interface LearningDraft {
  variable: string;
  winnerGenes: Record<string, string>;
  loserGenes: Record<string, string[]>;
  relevantGenes: Record<string, unknown>;
  statement: string;
}

/**
 * What a comparison actually shows (§20 "must not pretend it identified which variable caused the result"): the
 * compared variants differ only by hook unless the merchant's control is among them, in which case the master
 * differs from it on the experiment's primary variable. The learning is worded, and keyed, on that difference —
 * the winning hook over the other hooks, or the tested variable over the control — never on the shared angle.
 */
export function describeLearning(input: {
  variants: VariantRow[];
  comparedIds: string[];
  leaderId: string;
  primaryVariable: string;
  mode: string;
  experimentGenes: Record<string, unknown>;
  state: 'ACTIONABLE' | 'DIRECTIONAL';
  metric: string;
  context: string;
}): LearningDraft {
  const compared = input.variants.filter((v) => input.comparedIds.includes(v.id));
  const leader = compared.find((v) => v.id === input.leaderId)!;
  const others = compared.filter((v) => v.id !== input.leaderId);
  const withControl = compared.some((v) => v.role === 'control');
  const variable = withControl ? input.primaryVariable : 'hook';
  const valueOf = (v: VariantRow) => (v.role === 'control' ? CONTROL_VALUE : (geneValue(v, variable, input.experimentGenes) ?? `the tested ${variable}`));
  const winner = valueOf(leader);
  const losers = [...new Set(others.map(valueOf))].filter((x) => !same(x, winner));
  const where = `For this SKU on ${platformLabel(platformOf(input.context))}`;
  const firm = input.state === 'ACTIONABLE';
  const metric = metricLabel(input.metric);
  const quote = (x: string) => `“${x}”`;
  let statement: string;
  if (variable === 'hook') {
    statement = `${where}, the hook ${quote(winner)} ${firm ? 'is' : 'looks'} stronger on ${metric} than ${losers.map(quote).join(' and ') || 'the other hooks'}.`;
    // Everything but the opening is shared, so this says nothing about the experiment's wider direction.
    if (input.mode === 'EXPLORATORY') statement += ' Only the hook differed between these ads, so the wider direction is still untested.';
  } else if (leader.role === 'control') {
    statement = `${where}, the current control ${firm ? 'beat' : 'is ahead of'} the new ${variable} (${losers.join(', ')}) on ${metric}.`;
  } else {
    statement = `${where}, the new ${variable} (${winner}) ${firm ? 'beat' : 'is ahead of'} ${losers.includes(CONTROL_VALUE) ? 'the current control' : losers.map(quote).join(' and ')} on ${metric}.`;
    if (input.mode === 'EXPLORATORY') statement += ' Exploratory: more than one thing changed, so the cause is not isolated.';
  }
  const relevantGenes = leader.role === 'control' ? { variable } : { ...input.experimentGenes, ...(leader.genes ?? {}), hook: leader.label, variable };
  return { variable, winnerGenes: { [variable]: winner }, loserGenes: { [variable]: losers }, relevantGenes, statement };
}

/**
 * An observation day inside an active confounder window of the SKU (or the whole workspace). Windows are
 * timestamps; an observation's date is a day in its source's reporting timezone (§47), so the window is converted
 * into that timezone before the days are compared. Candidates awaiting confirmation and dismissed ones never count.
 */
const CONFOUNDED_DAY = (tx: Tx, skuId: unknown) => tx`exists (
  select 1 from confounders c where c.status = 'active' and (c.sku_id is null or c.sku_id = ${skuId as string})
    and o.date >= (c.starts_at at time zone coalesce(o.source_timezone, 'UTC'))::date
    and o.date <= (coalesce(c.ends_at, now()) at time zone coalesce(o.source_timezone, 'UTC'))::date)`;

/** The campaign context a comparison is computed under (§45 "aggregate only under compatible context"). */
export interface CompatScope {
  optimizationEvent: string;
  campaignType: string;
}

/**
 * Pick the compatible context for one measurement context × window: variants are compared only on observations
 * sharing an optimization event and campaign type (a purchase-optimized and a traffic-optimized campaign are
 * different auctions). The scope covering the most variants wins, then the most impressions; rows outside it are
 * left out and reported.
 */
export function compatibleScope<T extends { variant_id: string; optimization_event: string; campaign_type: string; impressions: number | string }>(rows: T[]): { scope: CompatScope | null; kept: T[]; excluded: T[] } {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const k = `${r.optimization_event}\u0000${r.campaign_type}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const ranked = [...by.entries()].sort(([, a], [, b]) => {
    const va = new Set(a.map((r) => r.variant_id)).size;
    const vb = new Set(b.map((r) => r.variant_id)).size;
    if (va !== vb) return vb - va;
    return b.reduce((n, r) => n + Number(r.impressions), 0) - a.reduce((n, r) => n + Number(r.impressions), 0);
  });
  if (!ranked.length) return { scope: null, kept: [], excluded: [] };
  const [key, kept] = ranked[0]!;
  const [optimizationEvent, campaignType] = key.split('\u0000') as [string, string];
  return { scope: { optimizationEvent, campaignType }, kept, excluded: ranked.slice(1).flatMap(([, r]) => r) };
}

/**
 * Recent SKU and account volume in one measurement context and attribution window (last 60 days, current
 * revisions, outside confounder windows, excluding this experiment's own variants) — the shrinkage baseline (§21).
 */
async function baselinePools(tx: Tx, skuId: string, variantIds: string[], context: string, window: string, accounts: string[]): Promise<Record<RateMetric, BaselinePool[]>> {
  const [r] = await tx`
    with obs as (
      select o.impressions, o.clicks, o.purchases, coalesce(o.video_starts, 0) as vs, coalesce(o.video_75, 0) as v75,
             (exists (select 1 from variants v join experiments x on x.id = v.experiment_id and x.workspace_id = v.workspace_id
                      where v.id = o.variant_id and x.sku_id = ${skuId})
              or exists (select 1 from creatives c where c.id = o.creative_id and c.sku_id = ${skuId})) as sku
      from performance_observations o
      where o.measurement_context = ${context} and o.attribution_window = ${window} and o.superseded_at is null
        and o.date > (now() - interval '60 days')::date
        and (o.variant_id is null or not (o.variant_id = any(${variantIds}::uuid[])))
        and (${accounts.length === 0} or o.account_id = any(${accounts}::text[]))
        and not ${CONFOUNDED_DAY(tx, skuId)})
    select coalesce(sum(impressions) filter (where sku), 0)::float8 as s_imp, coalesce(sum(clicks) filter (where sku), 0)::float8 as s_clk,
           coalesce(sum(purchases) filter (where sku), 0)::float8 as s_pur, coalesce(sum(vs) filter (where sku), 0)::float8 as s_vs,
           coalesce(sum(v75) filter (where sku), 0)::float8 as s_v75,
           coalesce(sum(impressions), 0)::float8 as a_imp, coalesce(sum(clicks), 0)::float8 as a_clk, coalesce(sum(purchases), 0)::float8 as a_pur,
           coalesce(sum(vs), 0)::float8 as a_vs, coalesce(sum(v75), 0)::float8 as a_v75
    from obs`;
  const n = (k: string) => Number(r?.[k] ?? 0);
  const pools = (s: string, a: string, ss: string, as: string): BaselinePool[] => [
    { level: 'sku', successes: n(s), trials: n(ss) },
    { level: 'account', successes: n(a), trials: n(as) },
  ];
  return {
    ctr: pools('s_clk', 'a_clk', 's_imp', 'a_imp'),
    hold_rate: pools('s_v75', 'a_v75', 's_vs', 'a_vs'),
    cvr: pools('s_pur', 'a_pur', 's_clk', 'a_clk'),
  };
}

/** Result states worth a midweek signal update (§11: only when thresholds change). */
const THRESHOLD_STATES: ReadonlySet<string> = new Set(['DIRECTIONAL', 'ACTIONABLE', 'INCONCLUSIVE', 'OPERATIONALLY_CONFOUNDED']);

/**
 * The midweek window a signal update belongs to (§11 "Midweek: receive signal updates only when thresholds
 * change"): Wednesday 15:00 UTC of this week — or next week's, from Friday on. A change on Wednesday or Thursday
 * goes out straight away; at most one update per workspace per window.
 */
export function signalUpdateWindow(now = new Date()): { key: string; startsAt: Date; runAt: Date } {
  const day = 86400_000;
  const dow = (now.getUTCDay() + 6) % 7; // Monday = 0
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - dow * day;
  let wed = monday + 2 * day + 15 * 3600_000;
  if (dow >= 4) wed += 7 * day;
  return { key: new Date(wed).toISOString().slice(0, 10), startsAt: new Date(wed), runAt: new Date(Math.max(wed, now.getTime())) };
}

/**
 * Compute results for an experiment (job `compute-results`). Excludes merchant/auto confounder windows from
 * causal interpretation (§45). Writes experiment_results per measurement context and attribution window, moves a
 * running experiment's state, and creates or revises learnings.
 */
export async function computeResults(tx: Tx, ctx: TenantContext, experimentId: string) {
  const [e] = await tx`select * from experiments where id = ${experimentId}`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const variants = (await tx`select id, role, label, code, genes from variants where experiment_id = ${experimentId}`) as unknown as VariantRow[];
  const variantIds = variants.map((v) => v.id);
  const ids = variantIds.concat(['00000000-0000-0000-0000-000000000000']);
  // Money is summed in the workspace's reporting currency, never raw across currencies (§47); rows without a rate
  // are counted as unconverted instead of being added in their native currency.
  const allAgg = (await tx`
    select o.variant_id, o.measurement_context, o.attribution_window,
      coalesce(o.optimization_event, '') as optimization_event, coalesce(o.campaign_type, '') as campaign_type,
      sum(o.impressions)::bigint as impressions, sum(o.clicks)::bigint as clicks, sum(o.purchases)::bigint as purchases,
      sum(coalesce(o.video_starts,0))::bigint as video_starts, sum(coalesce(o.video_75,0))::bigint as video_75,
      coalesce(sum(o.spend_reporting_micros), 0)::bigint as spend_micros, coalesce(sum(o.value_reporting_micros), 0)::bigint as purchase_value_micros,
      count(distinct o.currency)::int as currencies, count(*) filter (where o.spend_reporting_micros is null)::int as unconverted,
      count(distinct o.date)::int as days
    from performance_observations o
    where o.variant_id in ${tx(ids)}
      and o.superseded_at is null
      and not ${CONFOUNDED_DAY(tx, e.sku_id)}
    group by 1, 2, 3, 4, 5`) as unknown as ObsAgg[];
  // The experiment's observed span and source accounts (all current rows, confounded days included): confounders
  // are matched by overlap with this span, and baselines and volume come from these accounts only (§47 "keep
  // observations scoped to source account").
  const [span] = await tx`select min(date)::text as first, max(date)::text as last, coalesce(array_agg(distinct account_id), '{}') as accounts,
                                 mode() within group (order by source_timezone) as tz
                          from performance_observations where variant_id in ${tx(ids)} and superseded_at is null`;
  const accounts = ((span?.accounts as string[]) ?? []).filter(Boolean);
  const [vol] = await tx`select coalesce(sum(impressions) / nullif(count(distinct date), 0), 0)::bigint as daily from performance_observations
                         where date > now() - interval '30 days' and superseded_at is null and (${accounts.length === 0} or account_id = any(${accounts}::text[]))`;
  const daily = Number(vol!.daily);
  // Confounder windows overlapping the test's span (§45): from its first observation to its last — or to today while
  // it can still be running, since an ongoing change affects the days still to come. One that ended before the test's
  // first observation, or starts after it stopped, does not confound it; one that overlaps does, however long ago
  // it started.
  const live = LIVE_STATES.includes(e.state as ExperimentState);
  const windows = span?.first
    ? ((await tx`select id, kind, source, note, starts_at, ends_at from confounders
                 where status = 'active' and (sku_id is null or sku_id = ${e.sku_id})
                   and (starts_at at time zone ${(span.tz as string) ?? 'UTC'})::date
                       <= (case when ${live} then greatest(${span.last as string}::date, (now() at time zone ${(span.tz as string) ?? 'UTC'})::date) else ${span.last as string}::date end)
                   and (coalesce(ends_at, now()) at time zone ${(span.tz as string) ?? 'UTC'})::date >= ${span.first as string}::date
                 order by starts_at`) as unknown as { id: string; kind: string; source: string; note: string | null; starts_at: Date; ends_at: Date | null }[])
    : [];
  const confounderWindows = windows.map((w) => ({ id: w.id, kind: w.kind, source: w.source, note: w.note, startsAt: new Date(w.starts_at).toISOString(), endsAt: w.ends_at ? new Date(w.ends_at).toISOString() : null }));
  // One compatible campaign context per measurement context × window (§45).
  const scopes = new Map<string, { scope: CompatScope | null; excluded: number }>();
  const agg: ObsAgg[] = [];
  for (const key of new Set(allAgg.map((a) => `${a.measurement_context}|${a.attribution_window}`))) {
    const pick = compatibleScope(allAgg.filter((a) => `${a.measurement_context}|${a.attribution_window}` === key));
    scopes.set(key, { scope: pick.scope, excluded: pick.excluded.reduce((n, r) => n + Number(r.impressions), 0) });
    agg.push(...pick.kept);
  }
  const expGenes = (e.genes ?? {}) as Record<string, unknown>;
  // One comparison per measurement context × attribution window: a 7-day-click and a 1-day-view reading are
  // different measurements and are never summed together (§30).
  const groups = [...new Map(agg.map((a) => [`${a.measurement_context}|${a.attribution_window}`, { context: a.measurement_context, window: a.attribution_window }])).values()];
  const metrics: RateMetric[] = e.primary_metric === 'hold_rate' ? ['hold_rate', 'ctr', 'cvr'] : ['ctr', 'hold_rate', 'cvr'];
  interface Summary {
    context: MeasurementContext;
    window: string;
    metric: RateMetric;
    state: ComparisonResult['state'];
    leader: string | null;
    explanation: string;
    cmp: ComparisonResult;
  }
  const summary: Summary[] = [];

  for (const g of groups) {
    const pools = await baselinePools(tx, e.sku_id as string, variantIds, g.context, g.window, accounts);
    const sc = scopes.get(`${g.context}|${g.window}`);
    const scope = { ...(sc?.scope ?? {}), excludedImpressions: sc?.excluded ?? 0 };
    const rows = agg.filter((a) => a.measurement_context === g.context && a.attribution_window === g.window);
    for (const metric of metrics) {
      const ev: VariantEvidence[] = rows.map((r) => ({ variantId: r.variant_id, obs: toRate(metric, r), days: Number(r.days) })).filter((x) => x.obs.trials > 0);
      if (!ev.length) continue;
      // Shrink toward this SKU's (else the account's) recent baseline in the same context and window (§21).
      const base = baselineFrom(metric, pools[metric], DEFAULT_BASELINES[metric]);
      const cmp = ev.length > 1 ? compareVariants(metric, ev, base, daily, (e.control_variant_id as string) ?? null) : null;
      for (const r of ev) {
        const post = posterior(r.obs, base);
        const row = cmp?.variants.find((x) => x.variantId === r.variantId);
        await tx`
          insert into experiment_results (workspace_id, experiment_id, variant_id, measurement_context, attribution_window, metric, successes, trials, raw_rate,
            posterior_mean, ci_low, ci_high, prob_best, state, confounder_windows, scope)
          values (${ctx.workspaceId}, ${experimentId}, ${r.variantId}, ${g.context}, ${g.window}, ${metric}, ${r.obs.successes}, ${r.obs.trials}, ${post.raw},
            ${post.mean}, ${post.ciLow}, ${post.ciHigh}, ${row?.probBest ?? null}, ${cmp?.state ?? 'GATHERING_SIGNAL'},
            ${tx.json(confounderWindows as never)}, ${tx.json(scope as never)})
          on conflict (workspace_id, experiment_id, variant_id, measurement_context, attribution_window, metric) do update set
            successes = excluded.successes, trials = excluded.trials, raw_rate = excluded.raw_rate, posterior_mean = excluded.posterior_mean,
            ci_low = excluded.ci_low, ci_high = excluded.ci_high, prob_best = excluded.prob_best, state = excluded.state,
            confounder_windows = excluded.confounder_windows, scope = excluded.scope, computed_at = now()`;
      }
      if (cmp) summary.push({ context: g.context, window: g.window, metric, state: cmp.state, leader: cmp.leader, explanation: cmp.explanation, cmp });
    }
  }

  const primary = summary.filter((s) => s.metric === e.primary_metric);
  const best = primary.find((s) => s.state === 'ACTIONABLE') ?? primary.find((s) => s.state === 'DIRECTIONAL') ?? primary.find((s) => s.state === 'INCONCLUSIVE');
  let resultState: ExperimentState = agg.length ? 'GATHERING_SIGNAL' : (e.state as ExperimentState);
  if (best) resultState = best.state as ExperimentState;
  resultState = withConfounders(resultState, confounderWindows.length);
  const prev = e.state as ExperimentState;
  // Only a test that can be running moves with its results; a pre-launch, archived or invalidated one keeps its state.
  const running = LIVE_STATES.includes(prev);
  const moved = running && agg.length ? await setExperimentState(tx, ctx, experimentId, resultState, 'results') : false;
  if (moved) {
    await emit(tx, ctx, 'CONFIDENCE_CHANGED', { type: 'experiment', id: experimentId }, { from: prev, to: resultState }, { skuId: e.sku_id as string });
    if (THRESHOLD_STATES.has(resultState)) {
      const w = signalUpdateWindow();
      await enqueue(tx, ctx.workspaceId, Queues.sendEmail, { template: 'signal_update', window: w.key }, { singletonKey: `signal:${w.key}`, runAfter: w.runAt });
    }
  }
  const out = { state: (moved ? resultState : prev) as ExperimentState, summary: summary.map(({ cmp: _c, ...s }) => s), confounderWindows };
  // Measured decay of the leading variant (§45): a fatigued winner asks for a controlled refresh, the learning stays.
  await recordFatigue(tx, experimentId, variantIds, best && (best.state === 'ACTIONABLE' || best.state === 'DIRECTIONAL') ? best.leader : null);
  // Learnings come from tests that ran (an archived test's late conversions still revise them), never from a
  // pre-launch or invalidated one.
  if (!running && prev !== 'ARCHIVED') return out;

  // Learnings (scoped to platform/measurement context and window; never generalized across platforms, §21) are
  // revised whenever results are recomputed — late conversions, backfills and corrections (§45, §48) — so they can
  // strengthen, weaken or be invalidated. History is appended, never rewritten. Serialized per SKU: two
  // computations (two experiments on one SKU, or a redelivered job) never create the same learning twice or
  // revise one from a stale state.
  await tx`select pg_advisory_xact_lock(hashtext(${'learnings:' + (e.sku_id as string)}))`;
  const isConfounded = resultState === 'OPERATIONALLY_CONFOUNDED';
  const revised = new Set<string>();
  const now = new Date().toISOString();
  const primaryCmp = new Map(primary.map((s) => [`${s.context}|${s.window}`, s.cmp]));

  // 1. Create or strengthen from a current lead — unless the period is operationally confounded (§45: a
  //    confounded result must not create or strengthen a learning).
  if (!isConfounded) {
    for (const s of primary.filter((x) => (x.state === 'ACTIONABLE' || x.state === 'DIRECTIONAL') && x.leader)) {
      const cmp = s.cmp;
      const lead = cmp.variants.find((v) => v.variantId === s.leader)!;
      const runnerUp = Math.max(...cmp.variants.filter((v) => v.variantId !== s.leader).map((v) => v.posterior.mean));
      const effect = runnerUp > 0 ? lead.posterior.mean / runnerUp - 1 : null;
      const supports = lead.probBest;
      const platform = platformOf(s.context);
      const d = describeLearning({
        variants,
        comparedIds: cmp.variants.map((v) => v.variantId),
        leaderId: s.leader!,
        primaryVariable: e.primary_variable as string,
        mode: e.mode as string,
        experimentGenes: expGenes,
        state: s.state as 'ACTIONABLE' | 'DIRECTIONAL',
        metric: s.metric,
        context: s.context,
      });
      // Same learning = same SKU, context, window and leading variant (a different leader is a different claim).
      const [existing] = await tx`select id from learnings where sku_id = ${e.sku_id} and measurement_context = ${s.context} and attribution_window = ${s.window}
                                  and state <> 'INVALIDATED'
                                  and (leader_variant_id = ${s.leader} or (leader_variant_id is null and ${experimentId}::uuid = any(supporting_experiments)))
                                  order by created_at limit 1 for update`;
      if (!existing) {
        const [l] = await tx`
          insert into learnings (workspace_id, sku_id, statement, scope_platform, measurement_context, attribution_window, relevant_genes, variable,
            winner_genes, loser_genes, effect, supporting_experiments, confidence, state, do_not_generalize_to, leader_variant_id, history)
          values (${ctx.workspaceId}, ${e.sku_id}, ${d.statement}, ${platform}, ${s.context}, ${s.window}, ${tx.json(d.relevantGenes as never)}, ${d.variable},
            ${tx.json(d.winnerGenes)}, ${tx.json(d.loserGenes)}, ${effect}, ${[experimentId]},
            ${supports}, ${s.state}, ${doNotGeneralizeTo(platform)}, ${s.leader},
            ${tx.json([{ at: now, to: s.state, experimentId, supports, actionable: s.state === 'ACTIONABLE', reason: 'created' }] as never)})
          returning id`;
        revised.add(l!.id as string);
        await emit(tx, ctx, 'LEARNING_CREATED', { type: 'learning', id: l!.id as string }, { state: s.state, experimentId, supports, variable: d.variable }, { experimentId, skuId: e.sku_id as string, variantId: s.leader });
      } else {
        await reviseLearning(tx, ctx, existing.id as string, supports, s.state === 'ACTIONABLE', { experimentId, reason: 'new evidence', leaderId: s.leader!, statement: d.statement, effect });
        revised.add(existing.id as string);
      }
    }
  }

  // 2. Every other learning on this SKU is re-checked against the newest comparable evidence in its context and
  //    window, including GATHERING / INCONCLUSIVE results: a learning this experiment produced by its leading
  //    variant's P(best); one from another experiment by P(its winning genes beat its losing genes) among this
  //    experiment's variants that carry them. A flipped leader invalidates, an erased lead weakens (§21).
  const candidates = await tx`select id, measurement_context, attribution_window, leader_variant_id, confounded, variable, winner_genes, loser_genes,
                                     ${experimentId}::uuid = any(supporting_experiments || contradicting_experiments) as linked
                              from learnings where sku_id = ${e.sku_id} and state <> 'INVALIDATED'
                              and (${experimentId}::uuid = any(supporting_experiments || contradicting_experiments) or variable is not null)`;
  for (const l of candidates) {
    if (revised.has(l.id as string)) continue;
    const own = !!l.linked && (!l.leader_variant_id || variantIds.includes(l.leader_variant_id as string));
    if (isConfounded) {
      if (own && !l.confounded) {
        await tx`update learnings set confounded = true, last_revalidated_at = now(),
                   history = history || ${tx.json([{ at: now, experimentId, reason: 'operationally confounded' }] as never)} where id = ${l.id}`;
        await emit(tx, ctx, 'LEARNING_WEAKENED', { type: 'learning', id: l.id as string }, { confounded: true, experimentId }, { experimentId, skuId: e.sku_id as string });
      }
      continue;
    }
    if (own && l.confounded) {
      await tx`update learnings set confounded = false, history = history || ${tx.json([{ at: now, experimentId, reason: 'confounder cleared' }] as never)} where id = ${l.id}`;
    }
    const cmp = primaryCmp.get(`${l.measurement_context}|${l.attribution_window}`);
    if (own) {
      // No comparable evidence left in this context (e.g. corrected away) → the learning has lost its support.
      let supports = 0.3;
      let actionable = false;
      if (cmp) {
        supports = cmp.variants.find((v) => v.variantId === l.leader_variant_id)?.probBest ?? 0;
        actionable = cmp.state === 'ACTIONABLE';
        // "Equivalent" evidence contradicts a claimed difference.
        if (cmp.state === 'INCONCLUSIVE') supports = Math.min(supports, 0.3);
      }
      await reviseLearning(tx, ctx, l.id as string, supports, actionable, { experimentId, reason: cmp ? `recomputed: ${cmp.state.toLowerCase()}` : 'evidence withdrawn' });
      continue;
    }
    // Another experiment's learning: only evidence that compares its winning and losing genes counts.
    if (!cmp || cmp.state === 'GATHERING_SIGNAL' || !l.variable || l.confounded) continue;
    const variable = l.variable as string;
    const winner = (l.winner_genes as Record<string, string>)[variable];
    const losers = ([] as string[]).concat((l.loser_genes as Record<string, string | string[]>)[variable] ?? []);
    if (!winner || winner === CONTROL_VALUE) continue;
    const carrying = (vals: string[]) =>
      cmp.variants.filter((r) => {
        const v = variants.find((x) => x.id === r.variantId);
        const val = v ? geneValue(v, variable, expGenes) : null;
        return !!val && vals.some((x) => x !== CONTROL_VALUE && same(x, val));
      });
    const w = carrying([winner]);
    const lo = carrying(losers);
    if (!w.length || !lo.length) continue;
    const supports = probAbove(w.map((r) => r.posterior), lo.map((r) => r.posterior));
    const actionable = cmp.state !== 'DIRECTIONAL' && [...w, ...lo].every((r) => r.meetsFloor);
    await reviseLearning(tx, ctx, l.id as string, supports, actionable, { experimentId, reason: `compared again in another experiment (${cmp.state.toLowerCase()})` });
  }
  return out;
}

/**
 * Apply new evidence to a learning (§21): state per nextLearningState, confidence (the evidence's probability that
 * the learning holds), the experiment recorded as supporting or contradicting, appended history, and
 * LEARNING_WEAKENED / LEARNING_INVALIDATED when it drops. The same experiment's unchanged evidence is not counted
 * again: a recomputation with the same numbers never weakens a learning twice.
 */
async function reviseLearning(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  learningId: string,
  supports: number,
  actionable: boolean,
  meta: { experimentId: string; reason: string; leaderId?: string; statement?: string; effect?: number | null },
) {
  const [l] = await tx`select state, sku_id, history from learnings where id = ${learningId} for update`;
  const from = l!.state as SignalState;
  const last = ((l!.history as { experimentId?: string; supports?: number; actionable?: boolean }[]) ?? []).filter((h) => h.experimentId === meta.experimentId && typeof h.supports === 'number').at(-1);
  if (last && Math.abs(last.supports! - supports) < 0.05 && last.actionable === actionable) return from;
  const next = nextLearningState(from, supports, actionable);
  const contradicts = supports < 0.5;
  await tx`update learnings set state = ${next}, confidence = ${supports}, last_revalidated_at = now(),
             statement = coalesce(${meta.statement ?? null}, statement), effect = coalesce(${meta.effect ?? null}::numeric, effect),
             leader_variant_id = coalesce(leader_variant_id, ${meta.leaderId ?? null}::uuid),
             supporting_experiments = case when ${contradicts} then array_remove(supporting_experiments, ${meta.experimentId}::uuid)
                                           else array(select distinct unnest(supporting_experiments || ${[meta.experimentId]}::uuid[])) end,
             contradicting_experiments = case when ${contradicts} then array(select distinct unnest(contradicting_experiments || ${[meta.experimentId]}::uuid[]))
                                              else array_remove(contradicting_experiments, ${meta.experimentId}::uuid) end,
             history = history || ${tx.json([{ at: new Date().toISOString(), from, to: next, experimentId: meta.experimentId, supports, actionable, reason: meta.reason }] as never)}
           where id = ${learningId}`;
  if (next !== from && (next === 'WEAKENING' || next === 'INVALIDATED')) {
    await emit(tx, ctx, next === 'INVALIDATED' ? 'LEARNING_INVALIDATED' : 'LEARNING_WEAKENED', { type: 'learning', id: learningId }, { from, to: next, supports, experimentId: meta.experimentId, reason: meta.reason }, { experimentId: meta.experimentId, skuId: l!.sku_id as string });
  }
  return next;
}

/**
 * Merchant-marked confounder (plan 03 A6): stockout, outage, price change, influencer spike… A running test with a
 * directional or actionable read becomes OPERATIONALLY_CONFOUNDED at once (§35, §45); results are recomputed.
 */
export async function markConfounder(
  tx: Tx,
  ctx: TenantContext,
  input: { skuId?: string | null; kind: string; startsAt: string; endsAt?: string | null; note?: string | null },
) {
  assertCan(ctx, 'sku.edit');
  await tx`insert into confounders (workspace_id, sku_id, kind, starts_at, ends_at, note, source, created_by)
           values (${ctx.workspaceId}, ${input.skuId ?? null}, ${input.kind}, ${input.startsAt}, ${input.endsAt ?? null}, ${input.note ?? null},
                   'merchant', ${actorString(ctx)})`;
  await confoundRunning(tx, ctx, input.skuId ?? null, input.kind);
  // §21: a price or offer change is a change of context — the learnings it touches weaken and get revalidated.
  if (CONTEXT_CHANGE_KINDS.has(input.kind)) await weakenLearnings(tx, ctx, input.skuId ?? null, `${input.kind.replace('_', ' ')} marked by the merchant`);
}

/**
 * The merchant's decision on a confounder (§45): confirm an automatic candidate (a detected sales spike) so it
 * excludes its days and marks running tests, or dismiss one that didn't happen so the SKU's tests are recomputed
 * without it. The row is kept either way (history).
 */
export async function decideConfounder(tx: Tx, ctx: TenantContext, confounderId: string, decision: 'confirm' | 'dismiss') {
  assertCan(ctx, 'sku.edit');
  const [c] = await tx`select id, sku_id, kind, status from confounders where id = ${confounderId} for update`;
  if (!c) throw new DomainError('NOT_FOUND', 'Confounder not found');
  const to = decision === 'confirm' ? 'active' : 'dismissed';
  if (c.status === to) return { changed: false };
  if (decision === 'confirm' && c.status !== 'pending_confirmation') throw new DomainError('CONFLICT', 'This was already decided.');
  await tx`update confounders set status = ${to}, decided_at = now(), decided_by = ${actorString(ctx)} where id = ${confounderId}`;
  if (to === 'active') {
    await confoundRunning(tx, ctx, (c.sku_id as string | null) ?? null, c.kind as string);
    if (CONTEXT_CHANGE_KINDS.has(c.kind as string)) await weakenLearnings(tx, ctx, (c.sku_id as string | null) ?? null, `${String(c.kind).replace('_', ' ')} confirmed`);
  } else {
    // Dismissed: the tests it touched are read again without it.
    const exps = await tx`select id from experiments where (${(c.sku_id as string | null) ?? null}::uuid is null or sku_id = ${(c.sku_id as string | null) ?? null}::uuid)
                          and state in ${tx(LIVE_STATES as ExperimentState[])}`;
    for (const x of exps) await enqueue(tx, ctx.workspaceId, Queues.computeResults, { experimentId: x.id, reason: 'confounder' }, { singletonKey: `results:${x.id as string}` });
  }
  return { changed: true };
}

export async function experimentView(tx: Tx, experimentId: string) {
  const [e] = await tx`select * from experiments where id = ${experimentId}`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const variants = await tx`select v.*, p.state as project_state from variants v left join projects p on p.id = v.project_id
                            where v.experiment_id = ${experimentId} order by v.code`;
  const results = await tx`select * from experiment_results where experiment_id = ${experimentId} order by measurement_context, attribution_window, metric`;
  // A removed ad account is not a connection that needs attention; a connected one is stale when it errors or
  // hasn't synced within the freshness window (§31).
  const [f] = await tx`select min(last_success_at) as oldest, bool_or(status <> 'active') as degraded, count(*)::int as n from integrations
                       where provider in ('meta','tiktok') and status <> 'disconnected'`;
  const oldest = f?.oldest ? new Date(f.oldest as string) : null;
  const stale = !!f && Number(f.n) > 0 && (!!f.degraded || !oldest || Date.now() - oldest.getTime() > FRESHNESS_DAYS * 86400_000);
  return { experiment: e, variants, results, freshness: f && Number(f.n) > 0 ? { oldest, degraded: !!f.degraded, stale } : null };
}

export { withTenant };
