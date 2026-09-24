import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, newId, type ExperimentState, type MeasurementContext, type SignalState } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { actorString } from './context';
import { emit } from './events';
import type { Proposal } from './intel-schemas';
import { enqueue, priorityFor, queueFor, Queues } from './outbox';
import { planSteps } from './progress';
import { transition } from './projects';
import { STORYBOARD_STEPS } from './storyboard';
import { compareVariants, DEFAULT_BASELINES, nextLearningState, posterior, toRate, type ComparisonResult, type RateMetric, type VariantEvidence } from './statistics';

/**
 * Experiment Engine (§20) + learning (§21). CONTROLLED experiments change a limited set of variables and keep
 * the rest stable; EXPLORATORY ones may change many, and the system never claims to know which variable caused
 * the result. Results are computed per measurement context — never averaged across platforms (§30, §48).
 */

const HELD_DEFAULT = ['body', 'offer', 'cta', 'product', 'duration'];

export function variantCode(catalogueNo: number, index: number) {
  return `AK-${String(catalogueNo).padStart(3, '0')}-${String.fromCharCode(65 + index)}`;
}

/**
 * Turn an accepted recommendation (or a merchant-chosen concept) into an experiment + creative-test project.
 * The storyboard is generated immediately; spend happens only when the merchant approves it in Studio.
 */
export async function createExperiment(
  tx: Tx,
  ctx: TenantContext,
  input: { skuId: string; proposal: Proposal; recommendationId?: string | null; slot?: 'EXPLOIT' | 'EXPAND' | 'EXPLORE' | null; controlCreativeId?: string | null },
) {
  assertCan(ctx, 'experiment.create');
  const p = input.proposal;
  const controlled = p.primaryVariable === 'hook' || !!input.controlCreativeId;
  const mode = controlled && p.riskProfile !== 'exploratory' ? 'CONTROLLED' : 'EXPLORATORY';
  const [sku] = await tx`select catalogue_no from skus where id = ${input.skuId}`;
  if (!sku) throw new DomainError('NOT_FOUND', 'Product not found');
  const expId = newId();
  const genes = { angle: p.angle, hookMechanism: p.hookMechanism, proofMechanism: p.proofMechanism, treatment: p.treatment };
  await tx`
    insert into experiments (id, workspace_id, sku_id, hypothesis, rationale, primary_variable, controlled_variables, primary_metric,
      expected_learning, if_test_fails, mode, state, portfolio_slot, recommendation_id, genes, created_by)
    values (${expId}, ${ctx.workspaceId}, ${input.skuId}, ${p.hypothesis}, ${p.whyNow}, ${p.primaryVariable},
      ${mode === 'CONTROLLED' ? HELD_DEFAULT : []}, ${p.primaryVariable === 'hook' ? 'hold_rate' : 'ctr'}, ${p.expectedLearning},
      ${p.ifTestFails}, ${mode}, 'APPROVED', ${input.slot ?? null}, ${input.recommendationId ?? null}, ${tx.json(genes as never)},
      ${actorString(ctx)})`;
  // Variants: optional control (existing creative) + master + up to two economical hook variants (§5).
  let i = 0;
  if (input.controlCreativeId) {
    const [cid] = await tx`insert into variants (workspace_id, experiment_id, label, code, role, creative_id, changed_variables, held_constant)
                           values (${ctx.workspaceId}, ${expId}, 'Current control', ${variantCode(sku.catalogue_no as number, i++)}, 'control',
                                   ${input.controlCreativeId}, '{}', ${HELD_DEFAULT}) returning id`;
    await tx`update experiments set control_variant_id = ${cid!.id} where id = ${expId}`;
  }
  const projectId = newId();
  const [master] = await tx`
    insert into variants (workspace_id, experiment_id, label, code, role, project_id, changed_variables, held_constant, genes)
    values (${ctx.workspaceId}, ${expId}, ${p.hookOptions[0]!}, ${variantCode(sku.catalogue_no as number, i++)}, 'variant', ${projectId},
            ${input.controlCreativeId ? [p.primaryVariable] : []}, ${mode === 'CONTROLLED' ? HELD_DEFAULT : []}, ${tx.json({ ...genes, hook: p.hookOptions[0] } as never)})
    returning id`;
  for (const hook of p.hookOptions.slice(1, 3)) {
    await tx`insert into variants (workspace_id, experiment_id, label, code, role, changed_variables, held_constant, genes)
             values (${ctx.workspaceId}, ${expId}, ${hook}, ${variantCode(sku.catalogue_no as number, i++)}, 'variant', ${['hook']},
                     ${[...HELD_DEFAULT, 'scenes_2_plus', 'voiceover']}, ${tx.json({ ...genes, hook } as never)})`;
  }
  await tx`insert into projects (id, workspace_id, sku_id, experiment_id, variant_id, kind, state, created_by)
           values (${projectId}, ${ctx.workspaceId}, ${input.skuId}, ${expId}, ${master!.id}, 'creative_test', 'CONCEPTS_READY', ${actorString(ctx)})`;
  const [concept] = await tx`insert into concepts (workspace_id, sku_id, project_id, batch, idx, proposal, is_pick, prompt_version, model)
                             values (${ctx.workspaceId}, ${input.skuId}, ${projectId}, 1, 'A', ${tx.json(p as never)}, true, 'recommendation', 'n/a') returning id`;
  // Storyboard straight away (the approval boundary before expensive production, §13).
  const [sb] = await tx`insert into storyboards (workspace_id, project_id, concept_id, status) values (${ctx.workspaceId}, ${projectId}, ${concept!.id}, 'generating') returning id`;
  await transition(tx, ctx, projectId, 'CONCEPT_SELECTED', { patch: { selected_concept_id: concept!.id, storyboard_id: sb!.id } });
  await planSteps(tx, ctx.workspaceId, sb!.id as string, STORYBOARD_STEPS);
  await enqueue(tx, ctx.workspaceId, queueFor(Queues.generateStoryboard, ctx), { projectId, storyboardId: sb!.id, conceptId: concept!.id, actor: ctx.actor, experiment: true }, { priority: priorityFor(ctx) });
  const expRefs = { experimentId: expId, skuId: input.skuId, projectId, variantId: master!.id as string, storyboardId: sb!.id as string, recommendationId: input.recommendationId ?? null };
  await emit(tx, ctx, 'EXPERIMENT_CREATED', { type: 'experiment', id: expId }, { mode, slot: input.slot, primaryVariable: p.primaryVariable }, expRefs);
  if (input.recommendationId) {
    await tx`update recommendations set status = 'accepted', experiment_id = ${expId} where id = ${input.recommendationId}`;
    await emit(tx, ctx, 'RECOMMENDATION_ACCEPTED', { type: 'recommendation', id: input.recommendationId }, { experimentId: expId }, expRefs);
  }
  return { experimentId: expId, projectId, storyboardId: sb!.id as string };
}

const EXP_FLOW: ExperimentState[] = ['DRAFT', 'RECOMMENDED', 'APPROVED', 'PRODUCING', 'READY_TO_RUN', 'GATHERING_SIGNAL', 'DIRECTIONAL', 'ACTIONABLE', 'ARCHIVED'];

/**
 * Experiment state transitions. A merchant-initiated change is authorised here (a Viewer or a held workspace
 * cannot move an experiment); system transitions (results, variants) pass a system actor.
 */
export async function setExperimentState(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'> & Partial<Pick<TenantContext, 'role' | 'workspaceState'>>,
  experimentId: string,
  to: ExperimentState,
  reason?: string,
) {
  if (ctx.actor.kind === 'user' || ctx.actor.kind === 'provisional') {
    if (!ctx.role || !ctx.workspaceState) throw new DomainError('FORBIDDEN', 'Your role does not allow this action.');
    assertCan({ role: ctx.role, workspaceState: ctx.workspaceState }, 'experiment.create');
  }
  const [e] = await tx`select state from experiments where id = ${experimentId} for update`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const from = e.state as ExperimentState;
  if (from === to) return false;
  if (from === 'ARCHIVED' || from === 'INVALIDATED') return false;
  const signal: ExperimentState[] = ['GATHERING_SIGNAL', 'DIRECTIONAL', 'ACTIONABLE', 'INCONCLUSIVE', 'OPERATIONALLY_CONFOUNDED'];
  // Signal states can move either way (late conversions revise, §45); pre-launch states only forward.
  if (!(signal.includes(from) && signal.includes(to)) && EXP_FLOW.indexOf(to) >= 0 && EXP_FLOW.indexOf(from) > EXP_FLOW.indexOf(to)) return false;
  await tx`update experiments set state = ${to} where id = ${experimentId}`;
  await emit(tx, ctx, 'EXPERIMENT_STATE_CHANGED', { type: 'experiment', id: experimentId }, { from, to, reason: reason ?? null });
  return true;
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

export async function autoLinkByCode(tx: Tx, platform: 'meta' | 'tiktok', adId: string, adName: string | null): Promise<string | null> {
  const m = adName ? /AK-\d{3}-[A-Z]/.exec(adName.toUpperCase()) : null;
  if (!m) return null;
  const [v] = await tx`select id, creative_id from variants where code = ${m[0]}`;
  if (!v) return null;
  await tx`update performance_observations set variant_id = ${v.id}, creative_id = ${v.creative_id ?? null} where platform = ${platform} and ad_id = ${adId}`;
  return v.id as string;
}

interface ObsAgg {
  variant_id: string;
  measurement_context: MeasurementContext;
  impressions: number;
  clicks: number;
  purchases: number;
  video_starts: number;
  video_75: number;
  spend_micros: number;
  purchase_value_micros: number;
  days: number;
}

/**
 * Compute results for an experiment (job `compute-results`). Excludes merchant/auto confounder windows from
 * causal interpretation (§45). Writes experiment_results, updates experiment state and learnings.
 */
export async function computeResults(tx: Tx, ctx: TenantContext, experimentId: string) {
  const [e] = await tx`select * from experiments where id = ${experimentId}`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const variants = await tx`select id, role, label, code from variants where experiment_id = ${experimentId}`;
  const agg = (await tx`
    select o.variant_id, o.measurement_context,
      sum(o.impressions)::bigint as impressions, sum(o.clicks)::bigint as clicks, sum(o.purchases)::bigint as purchases,
      sum(coalesce(o.video_starts,0))::bigint as video_starts, sum(coalesce(o.video_75,0))::bigint as video_75,
      sum(o.spend_micros)::bigint as spend_micros, sum(o.purchase_value_micros)::bigint as purchase_value_micros,
      count(distinct o.date)::int as days
    from performance_observations o
    where o.variant_id in ${tx(variants.map((v) => v.id as string).concat(['00000000-0000-0000-0000-000000000000']))}
      and o.superseded_at is null
      and not exists (select 1 from confounders c where (c.sku_id is null or c.sku_id = ${e.sku_id})
                        and o.date >= c.starts_at::date and o.date <= coalesce(c.ends_at, now())::date)
    group by 1, 2`) as unknown as ObsAgg[];
  const [vol] = await tx`select coalesce(sum(impressions) / nullif(count(distinct date), 0), 0)::bigint as daily from performance_observations
                         where date > now() - interval '30 days'`;
  const daily = Number(vol!.daily);
  const contexts = [...new Set(agg.map((a) => a.measurement_context))];
  const metrics: RateMetric[] = e.primary_metric === 'hold_rate' ? ['hold_rate', 'ctr', 'cvr'] : ['ctr', 'hold_rate', 'cvr'];
  const summary: { context: MeasurementContext; metric: RateMetric; state: string; leader: string | null; explanation: string }[] = [];
  const comparisons: { context: MeasurementContext; metric: RateMetric; cmp: ComparisonResult }[] = [];
  const [confounded] = await tx`select count(*)::int as n from confounders where (sku_id is null or sku_id = ${e.sku_id})
                                and starts_at > now() - interval '30 days'`;

  for (const context of contexts) {
    for (const metric of metrics) {
      const rows = agg.filter((a) => a.measurement_context === context);
      const ev: VariantEvidence[] = rows.map((r) => ({ variantId: r.variant_id, obs: toRate(metric, r), days: Number(r.days) })).filter((x) => x.obs.trials > 0);
      if (!ev.length) continue;
      const cmp = ev.length > 1 ? compareVariants(metric, ev, DEFAULT_BASELINES[metric], daily, (e.control_variant_id as string) ?? null) : null;
      for (const r of ev) {
        const post = posterior(r.obs, DEFAULT_BASELINES[metric]);
        const row = cmp?.variants.find((x) => x.variantId === r.variantId);
        await tx`
          insert into experiment_results (workspace_id, experiment_id, variant_id, measurement_context, metric, successes, trials, raw_rate,
            posterior_mean, ci_low, ci_high, prob_best, state)
          values (${ctx.workspaceId}, ${experimentId}, ${r.variantId}, ${context}, ${metric}, ${r.obs.successes}, ${r.obs.trials}, ${post.raw},
            ${post.mean}, ${post.ciLow}, ${post.ciHigh}, ${row?.probBest ?? null}, ${cmp?.state ?? 'GATHERING_SIGNAL'})
          on conflict (workspace_id, experiment_id, variant_id, measurement_context, metric) do update set
            successes = excluded.successes, trials = excluded.trials, raw_rate = excluded.raw_rate, posterior_mean = excluded.posterior_mean,
            ci_low = excluded.ci_low, ci_high = excluded.ci_high, prob_best = excluded.prob_best, state = excluded.state, computed_at = now()`;
      }
      if (cmp) {
        summary.push({ context, metric, state: cmp.state, leader: cmp.leader, explanation: cmp.explanation });
        comparisons.push({ context, metric, cmp });
      }
    }
  }

  const primary = summary.filter((s) => s.metric === e.primary_metric);
  const best = primary.find((s) => s.state === 'ACTIONABLE') ?? primary.find((s) => s.state === 'DIRECTIONAL') ?? primary.find((s) => s.state === 'INCONCLUSIVE');
  let expState: ExperimentState = agg.length ? 'GATHERING_SIGNAL' : (e.state as ExperimentState);
  if (best) expState = best.state as ExperimentState;
  if (confounded!.n > 0 && expState === 'ACTIONABLE') expState = 'OPERATIONALLY_CONFOUNDED';
  const prev = e.state as string;
  if (agg.length) await setExperimentState(tx, ctx, experimentId, expState, 'results');
  if (prev !== expState && agg.length) await emit(tx, ctx, 'CONFIDENCE_CHANGED', { type: 'experiment', id: experimentId }, { from: prev, to: expState }, { skuId: e.sku_id as string });

  // Learnings (scoped to platform/measurement context; never generalized across platforms, §21). Learnings are
  // revised whenever results are recomputed — late conversions, backfills and corrections (§45, §48) — so they can
  // strengthen, weaken or be invalidated. History is appended, never rewritten.
  const genes = (e.genes ?? {}) as Record<string, string>;
  const isConfounded = expState === 'OPERATIONALLY_CONFOUNDED';
  const revised = new Set<string>();
  const now = new Date().toISOString();
  const primaryCmp = new Map(comparisons.filter((c) => c.metric === e.primary_metric).map((c) => [c.context, c.cmp]));

  // 1. Create or strengthen from a current lead — unless the period is operationally confounded (§45: a
  //    confounded result must not create or strengthen a learning).
  if (!isConfounded) {
    for (const s of primary.filter((x) => (x.state === 'ACTIONABLE' || x.state === 'DIRECTIONAL') && x.leader)) {
      const leader = variants.find((v) => v.id === s.leader);
      const cmp = primaryCmp.get(s.context)!;
      const supports = cmp.variants.find((v) => v.variantId === s.leader)?.probBest ?? 0;
      const platform = s.context.startsWith('META') ? 'meta' : s.context.startsWith('TIKTOK') ? 'tiktok' : 'blended';
      const statement =
        e.mode === 'CONTROLLED'
          ? `For this SKU on ${platform === 'meta' ? 'Meta' : platform === 'tiktok' ? 'TikTok' : 'blended data'}, “${leader?.label}” ${s.state === 'ACTIONABLE' ? 'is' : 'looks'} stronger on ${s.metric.replace('_', ' ')} (${String(genes.angle ?? '').toLowerCase().replace(/_/g, ' ')} angle).`
          : `For this SKU on ${platform}, the ${String(genes.angle ?? '').toLowerCase().replace(/_/g, ' ')} direction ${s.state === 'ACTIONABLE' ? 'won' : 'is leading'} — exploratory, so the cause is not isolated.`;
      // Same learning = same SKU, context, angle and leading variant (a different leader is a different claim).
      const [existing] = await tx`select id, state from learnings where sku_id = ${e.sku_id} and measurement_context = ${s.context}
                                  and relevant_genes->>'angle' = ${genes.angle ?? ''} and state <> 'INVALIDATED'
                                  and (leader_variant_id = ${s.leader} or (leader_variant_id is null and ${experimentId}::uuid = any(supporting_experiments)))
                                  order by created_at limit 1`;
      if (!existing) {
        const [l] = await tx`
          insert into learnings (workspace_id, sku_id, statement, scope_platform, measurement_context, relevant_genes, supporting_experiments,
            confidence, state, do_not_generalize_to, leader_variant_id, history)
          values (${ctx.workspaceId}, ${e.sku_id}, ${statement}, ${platform}, ${s.context}, ${tx.json({ ...genes, hook: leader?.label ?? null } as never)}, ${[experimentId]},
            ${supports}, ${s.state}, ${platform === 'meta' ? ['tiktok', 'other_skus'] : ['meta', 'other_skus']}, ${s.leader},
            ${tx.json([{ at: now, to: s.state, experimentId, supports, reason: 'created' }] as never)})
          returning id`;
        revised.add(l!.id as string);
        await emit(tx, ctx, 'LEARNING_CREATED', { type: 'learning', id: l!.id as string }, { state: s.state, experimentId, supports }, { experimentId, skuId: e.sku_id as string, variantId: s.leader });
      } else {
        await reviseLearning(tx, ctx, existing.id as string, supports, s.state === 'ACTIONABLE', { experimentId, reason: 'new evidence', leaderId: s.leader! });
        revised.add(existing.id as string);
      }
    }
  }

  // 2. Every other learning this experiment supports is re-checked against the newest comparable evidence,
  //    including GATHERING / INCONCLUSIVE results: a flipped leader invalidates it, an erased lead weakens it.
  const supported = await tx`select id, measurement_context, leader_variant_id, confounded from learnings
                             where sku_id = ${e.sku_id} and ${experimentId}::uuid = any(supporting_experiments) and state <> 'INVALIDATED'`;
  for (const l of supported) {
    if (isConfounded) {
      if (!l.confounded) {
        await tx`update learnings set confounded = true, last_revalidated_at = now(),
                   history = history || ${tx.json([{ at: now, experimentId, reason: 'operationally confounded' }] as never)} where id = ${l.id}`;
        await emit(tx, ctx, 'LEARNING_WEAKENED', { type: 'learning', id: l.id as string }, { confounded: true, experimentId }, { experimentId, skuId: e.sku_id as string });
      }
      continue;
    }
    if (l.confounded) {
      await tx`update learnings set confounded = false, history = history || ${tx.json([{ at: now, experimentId, reason: 'confounder cleared' }] as never)} where id = ${l.id}`;
    }
    if (revised.has(l.id as string)) continue;
    const cmp = primaryCmp.get(l.measurement_context as MeasurementContext);
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
  }
  return { state: expState, summary };
}

/** Apply new evidence to a learning (§21): state per nextLearningState, confidence, appended history, events. */
async function reviseLearning(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  learningId: string,
  supports: number,
  actionable: boolean,
  meta: { experimentId: string; reason: string; leaderId?: string },
) {
  const [l] = await tx`select state, sku_id from learnings where id = ${learningId} for update`;
  const from = l!.state as SignalState;
  const next = nextLearningState(from, supports, actionable);
  await tx`update learnings set state = ${next}, confidence = ${supports}, last_revalidated_at = now(),
             leader_variant_id = coalesce(leader_variant_id, ${meta.leaderId ?? null}::uuid),
             supporting_experiments = array(select distinct unnest(supporting_experiments || ${[meta.experimentId]}::uuid[])),
             history = history || ${tx.json([{ at: new Date().toISOString(), from, to: next, experimentId: meta.experimentId, supports, reason: meta.reason }] as never)}
           where id = ${learningId}`;
  if (next !== from && (next === 'WEAKENING' || next === 'INVALIDATED')) {
    await emit(tx, ctx, next === 'INVALIDATED' ? 'LEARNING_INVALIDATED' : 'LEARNING_WEAKENED', { type: 'learning', id: learningId }, { from, to: next, supports, experimentId: meta.experimentId, reason: meta.reason }, { experimentId: meta.experimentId, skuId: l!.sku_id as string });
  }
  return next;
}

/** Merchant-marked confounder (plan 03 A6): stockout, outage, price change, influencer spike… */
export async function markConfounder(
  tx: Tx,
  ctx: TenantContext,
  input: { skuId?: string | null; kind: string; startsAt: string; endsAt?: string | null; note?: string | null },
) {
  assertCan(ctx, 'sku.edit');
  await tx`insert into confounders (workspace_id, sku_id, kind, starts_at, ends_at, note, source, created_by)
           values (${ctx.workspaceId}, ${input.skuId ?? null}, ${input.kind}, ${input.startsAt}, ${input.endsAt ?? null}, ${input.note ?? null},
                   'merchant', ${actorString(ctx)})`;
  const exps = await tx`select id, sku_id from experiments where (${input.skuId ?? null}::uuid is null or sku_id = ${input.skuId ?? null}) and state in ('GATHERING_SIGNAL','DIRECTIONAL','ACTIONABLE')`;
  for (const x of exps) {
    await emit(tx, ctx, 'EXPERIMENT_CONFOUNDED', { type: 'experiment', id: x.id as string }, { kind: input.kind }, { skuId: x.sku_id as string });
    await enqueue(tx, ctx.workspaceId, Queues.computeResults, { experimentId: x.id, reason: 'confounder' });
  }
}

export async function experimentView(tx: Tx, experimentId: string) {
  const [e] = await tx`select * from experiments where id = ${experimentId}`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const variants = await tx`select v.*, p.state as project_state from variants v left join projects p on p.id = v.project_id
                            where v.experiment_id = ${experimentId} order by v.code`;
  const results = await tx`select * from experiment_results where experiment_id = ${experimentId} order by measurement_context, metric`;
  const [freshness] = await tx`select min(last_success_at) as oldest, bool_or(status <> 'active') as degraded from integrations
                               where provider in ('meta','tiktok')`;
  return { experiment: e, variants, results, freshness: freshness ?? null };
}

export { withTenant };
