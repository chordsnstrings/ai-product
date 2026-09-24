import type { Tx } from '@arkiv/db';
import { DomainError, Taxonomy } from '@arkiv/shared';
import type { TenantContext } from './context';
import { emit } from './events';
import { creativeMap } from './genome';

/**
 * SKU Creative Review (standard §9 Day 30, §11 month-end): "Summarize tested hypotheses, evidence, contradictions,
 * untested space and recommended portfolio." Deterministic — built from the SKU's experiments, their results and
 * confidence states, learnings, the Creative Map and open recommendations; no model call, no spend.
 */

export type SkuReviewKind = 'day30' | 'month_end';

export interface SkuReviewBody {
  sku: { id: string; name: string; catalogueNo: number };
  period: { start: string; end: string };
  summary: { tested: number; actionable: number; directional: number; inconclusive: number; contradictions: number };
  tested: {
    experimentId: string;
    hypothesis: string;
    angle: string | null;
    treatment: string | null;
    state: string;
    primaryMetric: string;
    /** The best variant's posterior on the primary metric, when results exist. */
    best: { variantId: string; rate: number | null; ciLow: number | null; ciHigh: number | null; probBest: number | null; state: string } | null;
  }[];
  evidence: { learningId: string; statement: string; state: string; confidence: number; platform: string }[];
  contradictions: { learningId: string; statement: string; state: string; contradictedBy: number }[];
  untested: { angle: string; treatments: string[] }[];
  portfolio: { recommendationId: string; slot: string; hypothesis: string; score: number }[];
}

const TESTED_STATES = ['PRODUCING', 'READY_TO_RUN', 'GATHERING_SIGNAL', 'DIRECTIONAL', 'ACTIONABLE', 'ARCHIVED', 'INCONCLUSIVE', 'INVALIDATED', 'OPERATIONALLY_CONFOUNDED'];

/** Aggregate one SKU's review for a period (tenant transaction). */
export async function buildSkuReview(tx: Tx, skuId: string, period: { start: Date; end: Date }): Promise<SkuReviewBody> {
  const [sku] = await tx`select id, name, catalogue_no from skus where id = ${skuId}`;
  if (!sku) throw new DomainError('NOT_FOUND', 'Product not found');
  const exps = await tx`
    select e.id, e.hypothesis, e.state, e.primary_metric, e.genes,
           (select jsonb_build_object('variantId', r.variant_id, 'rate', r.posterior_mean, 'ciLow', r.ci_low, 'ciHigh', r.ci_high, 'probBest', r.prob_best, 'state', r.state)
              from experiment_results r where r.experiment_id = e.id and r.workspace_id = e.workspace_id and r.metric = e.primary_metric
              order by r.prob_best desc nulls last, r.posterior_mean desc nulls last limit 1) as best
    from experiments e
    where e.sku_id = ${skuId} and e.state = any(${TESTED_STATES}) and e.created_at < ${period.end}
    order by e.created_at`;
  const learnings = await tx`select id, statement, state, confidence, scope_platform, cardinality(contradicting_experiments) as contradicted
                             from learnings where sku_id = ${skuId} and valid_from < ${period.end} order by confidence desc`;
  const map = await creativeMap(tx, skuId);
  const covered = new Set(map.cells.map((c) => `${c.angle}|${c.treatment}`));
  const untested = Taxonomy.angle
    .map((angle) => ({ angle, treatments: Taxonomy.treatment.filter((t) => !covered.has(`${angle}|${t}`)) as string[] }))
    .filter((a) => !map.cells.some((c) => c.angle === a.angle))
    .slice(0, 8);
  const recs = await tx`select id, slot, proposal->>'hypothesis' as hypothesis, score from recommendations
                        where sku_id = ${skuId} and status = 'open' order by week_of desc, score desc limit 3`;
  const num = (v: unknown) => (v == null ? null : Number(v));
  const tested = exps.map((e) => {
    const g = (e.genes ?? {}) as { angle?: string; treatment?: string };
    const b = e.best as Record<string, unknown> | null;
    return {
      experimentId: e.id as string,
      hypothesis: e.hypothesis as string,
      angle: g.angle ?? null,
      treatment: g.treatment ?? null,
      state: e.state as string,
      primaryMetric: e.primary_metric as string,
      best: b ? { variantId: b.variantId as string, rate: num(b.rate), ciLow: num(b.ciLow), ciHigh: num(b.ciHigh), probBest: num(b.probBest), state: String(b.state) } : null,
    };
  });
  const evidence = learnings
    .filter((l) => ['ACTIONABLE', 'DIRECTIONAL'].includes(l.state as string))
    .map((l) => ({ learningId: l.id as string, statement: l.statement as string, state: l.state as string, confidence: Number(l.confidence), platform: l.scope_platform as string }));
  const contradictions = learnings
    .filter((l) => ['WEAKENING', 'INVALIDATED'].includes(l.state as string) || Number(l.contradicted) > 0)
    .map((l) => ({ learningId: l.id as string, statement: l.statement as string, state: l.state as string, contradictedBy: Number(l.contradicted) }));
  return {
    sku: { id: sku.id as string, name: sku.name as string, catalogueNo: Number(sku.catalogue_no) },
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    summary: {
      tested: tested.length,
      actionable: evidence.filter((l) => l.state === 'ACTIONABLE').length,
      directional: evidence.filter((l) => l.state === 'DIRECTIONAL').length,
      inconclusive: tested.filter((t) => ['INCONCLUSIVE', 'OPERATIONALLY_CONFOUNDED'].includes(t.state)).length,
      contradictions: contradictions.length,
    },
    tested,
    evidence,
    contradictions,
    untested,
    portfolio: recs.map((r) => ({ recommendationId: r.id as string, slot: r.slot as string, hypothesis: (r.hypothesis as string) ?? '', score: Number(r.score) })),
  };
}

/**
 * Create the review for one SKU and period, once (a re-run of the sweep finds it). Returns its id, or null when it
 * already existed.
 */
export async function createSkuReview(tx: Tx, ctx: TenantContext, skuId: string, kind: SkuReviewKind, period: { start: Date; end: Date }): Promise<string | null> {
  const body = await buildSkuReview(tx, skuId, period);
  const [row] = await tx`
    insert into sku_reviews (workspace_id, sku_id, kind, period_start, period_end, version, body)
    values (${ctx.workspaceId}, ${skuId}, ${kind}, ${period.start}, ${period.end},
            (select coalesce(max(version), 0) + 1 from sku_reviews where sku_id = ${skuId}), ${tx.json(body as never)})
    on conflict (workspace_id, sku_id, kind, period_end) do nothing
    returning id`;
  if (!row) return null;
  await emit(tx, ctx, 'SKU_REVIEW_CREATED', { type: 'sku', id: skuId }, { reviewId: row.id, kind, tested: body.summary.tested, actionable: body.summary.actionable });
  return row.id as string;
}

/**
 * SKUs due a review (system read, filtered per workspace by the caller's use): Day 30 after the SKU's first paid
 * activity (a paid one-off ad, or its first approved test), and month-end for SKUs tested in a subscription period
 * that just ended.
 */
export async function dueSkuReviews(tx: Tx): Promise<{ workspaceId: string; skuId: string; kind: SkuReviewKind; start: Date; end: Date }[]> {
  const day30 = await tx`
    with first_paid as (
      select s.workspace_id, s.id as sku_id, least(
        (select min(pu.paid_at) from purchases pu join projects p on p.id = pu.project_id and p.workspace_id = pu.workspace_id
          where p.sku_id = s.id and p.workspace_id = s.workspace_id and pu.status = 'paid'),
        (select min(e.created_at) from experiments e where e.sku_id = s.id and e.workspace_id = s.workspace_id and e.state = any(${TESTED_STATES}))) as at
      from skus s join workspaces w on w.id = s.workspace_id
      where s.status = 'active' and w.state in ('ACTIVE_FREE', 'ACTIVE_PAID', 'PAST_DUE'))
    select f.workspace_id, f.sku_id, f.at from first_paid f
    where f.at is not null and f.at <= now() - interval '30 days' and f.at > now() - interval '60 days'
      and not exists (select 1 from sku_reviews r where r.workspace_id = f.workspace_id and r.sku_id = f.sku_id and r.kind = 'day30')
    limit 200`;
  const monthEnd = await tx`
    select s.workspace_id, s.id as sku_id, sub.current_period_start as period_end
    from subscriptions sub join skus s on s.workspace_id = sub.workspace_id
    where sub.status in ('active', 'trialing', 'past_due') and sub.current_period_start between now() - interval '1 day' and now()
      and sub.current_period_start > sub.created_at + interval '1 day' and s.status = 'active'
      and exists (select 1 from experiments e where e.sku_id = s.id and e.workspace_id = s.workspace_id and e.state = any(${TESTED_STATES}))
      and not exists (select 1 from sku_reviews r where r.workspace_id = s.workspace_id and r.sku_id = s.id and r.kind = 'month_end'
                      and r.period_end = sub.current_period_start)
    limit 200`;
  const DAY = 86_400_000;
  return [
    ...day30.map((r) => ({ workspaceId: r.workspace_id as string, skuId: r.sku_id as string, kind: 'day30' as const, start: new Date(r.at as string), end: new Date(new Date(r.at as string).getTime() + 30 * DAY) })),
    ...monthEnd.map((r) => {
      const end = new Date(r.period_end as string);
      const start = new Date(end);
      start.setUTCMonth(start.getUTCMonth() - 1);
      return { workspaceId: r.workspace_id as string, skuId: r.sku_id as string, kind: 'month_end' as const, start, end };
    }),
  ];
}
