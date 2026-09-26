import type { Tx } from '@arkiv/db';
import { DomainError, type ExperimentState, type ProjectState } from '@arkiv/shared';
import { assertCan } from './authz';
import { actorString, type TenantContext } from './context';
import { emit } from './events';
import { enqueue, Queues } from './outbox';

/**
 * Experiment state machine (§35): DRAFT → RECOMMENDED → APPROVED → PRODUCING → READY_TO_RUN → GATHERING_SIGNAL →
 * DIRECTIONAL → ACTIONABLE → ARCHIVED, with INCONCLUSIVE, INVALIDATED and OPERATIONALLY_CONFOUNDED on the side.
 * Every edge is listed: an experiment can't go live before its creative exists, a side state can't rewind to a
 * pre-launch state, and ARCHIVED / INVALIDATED are terminal.
 *  - PRODUCING → APPROVED: the master production failed or was blocked; a retry produces again.
 *  - READY_TO_RUN → signal states: the merchant marks it live, or linked results arrive (that proves it runs).
 *  - signal states revise either way as late conversions and corrections land (§45).
 *  - INVALIDATED: the test can no longer isolate anything (no comparable variant was produced).
 */
const SIGNAL: readonly ExperimentState[] = ['GATHERING_SIGNAL', 'DIRECTIONAL', 'ACTIONABLE', 'INCONCLUSIVE', 'OPERATIONALLY_CONFOUNDED'];
export const SIGNAL_STATES: ReadonlySet<ExperimentState> = new Set(SIGNAL);
/** States in which platform results may be attributed to the experiment's variants. */
export const LIVE_STATES: readonly ExperimentState[] = ['READY_TO_RUN', ...SIGNAL];

export const EXPERIMENT_NEXT: Readonly<Record<ExperimentState, readonly ExperimentState[]>> = {
  DRAFT: ['RECOMMENDED', 'APPROVED', 'ARCHIVED'],
  RECOMMENDED: ['APPROVED', 'ARCHIVED'],
  APPROVED: ['PRODUCING', 'ARCHIVED'],
  PRODUCING: ['READY_TO_RUN', 'APPROVED', 'INVALIDATED', 'ARCHIVED'],
  READY_TO_RUN: [...SIGNAL, 'INVALIDATED', 'ARCHIVED'],
  GATHERING_SIGNAL: [...SIGNAL.filter((s) => s !== 'GATHERING_SIGNAL'), 'INVALIDATED', 'ARCHIVED'],
  DIRECTIONAL: [...SIGNAL.filter((s) => s !== 'DIRECTIONAL'), 'INVALIDATED', 'ARCHIVED'],
  ACTIONABLE: [...SIGNAL.filter((s) => s !== 'ACTIONABLE'), 'INVALIDATED', 'ARCHIVED'],
  INCONCLUSIVE: [...SIGNAL.filter((s) => s !== 'INCONCLUSIVE'), 'INVALIDATED', 'ARCHIVED'],
  OPERATIONALLY_CONFOUNDED: [...SIGNAL.filter((s) => s !== 'OPERATIONALLY_CONFOUNDED'), 'INVALIDATED', 'ARCHIVED'],
  ARCHIVED: [],
  INVALIDATED: [],
};

export const canExperimentTransition = (from: ExperimentState, to: ExperimentState) => from === to || (EXPERIMENT_NEXT[from]?.includes(to) ?? false);

export type ExperimentCtx = Pick<TenantContext, 'workspaceId' | 'actor'> & Partial<Pick<TenantContext, 'role' | 'workspaceState'>>;

/**
 * Move an experiment along an allowed edge, evented and idempotent. A merchant-initiated change is authorised
 * (a Viewer or a held workspace cannot move an experiment) and an illegal one is refused with a reason; a system
 * transition that no longer applies (a stale job) is ignored and returns false.
 */
export async function setExperimentState(tx: Tx, ctx: ExperimentCtx, experimentId: string, to: ExperimentState, reason?: string): Promise<boolean> {
  const merchant = ctx.actor.kind === 'user' || ctx.actor.kind === 'provisional';
  if (merchant) {
    if (!ctx.role || !ctx.workspaceState) throw new DomainError('FORBIDDEN', 'Your role does not allow this action.');
    assertCan({ role: ctx.role, workspaceState: ctx.workspaceState }, 'experiment.create');
  }
  const [e] = await tx`select state from experiments where id = ${experimentId} for update`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const from = e.state as ExperimentState;
  if (from === to) return false;
  if (!canExperimentTransition(from, to)) {
    if (merchant) throw new DomainError('CONFLICT', stateRefusal(from, to));
    return false;
  }
  await tx`update experiments set state = ${to} where id = ${experimentId}`;
  await emit(tx, ctx, 'EXPERIMENT_STATE_CHANGED', { type: 'experiment', id: experimentId }, { from, to, reason: reason ?? null });
  return true;
}

function stateRefusal(from: ExperimentState, to: ExperimentState): string {
  if (to === 'GATHERING_SIGNAL') return from === 'ARCHIVED' || from === 'INVALIDATED' ? 'This test has ended.' : 'This test can go live once its ads are ready.';
  return `This test can’t move from ${from.toLowerCase().replace(/_/g, ' ')} to ${to.toLowerCase().replace(/_/g, ' ')}.`;
}

/**
 * Keep an experiment in step with its master production (§35): a failed or compliance-blocked production returns
 * the experiment to APPROVED (retryable); a retried production moves it back to PRODUCING; a cancelled or refunded
 * one archives it. Called from the project transition, in the same transaction.
 */
export async function syncExperimentWithProject(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, projectId: string, to: ProjectState) {
  const [row] = await tx`select e.id, e.state, e.approved_at from projects p
                         join variants v on v.project_id = p.id and v.workspace_id = p.workspace_id
                         join experiments e on e.id = v.experiment_id and e.workspace_id = v.workspace_id
                         where p.id = ${projectId} and p.kind = 'creative_test'`;
  if (!row) return;
  const state = row.state as ExperimentState;
  const sys = { workspaceId: ctx.workspaceId, actor: { kind: 'system' as const, id: 'experiment-sync' } };
  // Approving the master's storyboard for production is approving the test's spend, whichever screen it came from.
  if (to === 'STORYBOARD_APPROVED' && !row.approved_at && ['DRAFT', 'RECOMMENDED', 'APPROVED'].includes(state)) {
    await recordExperimentApproval(tx, ctx, row.id as string, projectId);
    return;
  }
  if ((to === 'PROVIDER_FAILED' || to === 'BLOCKED_COMPLIANCE') && state === 'PRODUCING') {
    await setExperimentState(tx, sys, row.id as string, 'APPROVED', `master production ${to.toLowerCase().replace(/_/g, ' ')}; retryable`);
  } else if ((to === 'CANCELLED' || to === 'REFUNDED') && ['DRAFT', 'RECOMMENDED', 'APPROVED', 'PRODUCING'].includes(state)) {
    await setExperimentState(tx, sys, row.id as string, 'ARCHIVED', `master production ${to.toLowerCase()}`);
  } else if ((to === 'STORYBOARD_APPROVED' || to === 'RENDER_RESERVED' || to === 'RENDERING') && state === 'APPROVED' && row.approved_at) {
    await setExperimentState(tx, sys, row.id as string, 'PRODUCING', 'master production resumed');
  }
}

/**
 * Record the merchant's approval of a test's spend (§35 → APPROVED → PRODUCING; Appendix B EXPERIMENT_APPROVED):
 * once — a replay finds approved_at set and changes and emits nothing.
 */
export async function recordExperimentApproval(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, experimentId: string, projectId: string): Promise<boolean> {
  const [e] = await tx`select state, sku_id, approved_at from experiments where id = ${experimentId} for update`;
  if (!e || e.approved_at || !['DRAFT', 'RECOMMENDED', 'APPROVED'].includes(e.state as string)) return false;
  const sys = { workspaceId: ctx.workspaceId, actor: { kind: 'system' as const, id: 'experiment-approval' } };
  await tx`update experiments set approved_by = ${actorString(ctx)}, approved_at = now() where id = ${experimentId}`;
  await setExperimentState(tx, sys, experimentId, 'APPROVED', 'approved by merchant');
  await emit(tx, ctx, 'EXPERIMENT_APPROVED', { type: 'experiment', id: experimentId }, { projectId, entitlementUnit: 'creative_test', approvedBy: actorString(ctx) }, { projectId, skuId: e.sku_id as string });
  await setExperimentState(tx, sys, experimentId, 'PRODUCING', 'production approved');
  return true;
}

/** Flag the running experiments a confounder overlaps and queue their recomputation. */
export async function confoundRunning(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'> & Partial<TenantContext>, skuId: string | null, kind: string) {
  const exps = await tx`select id, sku_id, state from experiments where (${skuId}::uuid is null or sku_id = ${skuId}) and state in ('GATHERING_SIGNAL','DIRECTIONAL','ACTIONABLE')`;
  const sys = { workspaceId: ctx.workspaceId, actor: { kind: 'system' as const, id: 'confounder' } };
  for (const x of exps) {
    await emit(tx, ctx, 'EXPERIMENT_CONFOUNDED', { type: 'experiment', id: x.id as string }, { kind }, { skuId: x.sku_id as string });
    if (x.state === 'DIRECTIONAL' || x.state === 'ACTIONABLE') await setExperimentState(tx, sys, x.id as string, 'OPERATIONALLY_CONFOUNDED', `confounder: ${kind}`);
    await enqueue(tx, ctx.workspaceId, Queues.computeResults, { experimentId: x.id, reason: 'confounder' }, { singletonKey: `results:${x.id as string}` });
  }
}

/**
 * The SKU's price or offer changed (§21 "weaken or invalidate when context, offer or market changes"; §45 offer
 * changed mid-test): its directional and actionable learnings weaken, and an automatic price-change confounder
 * marks running tests so their results can't be read as clean.
 */
export async function onMaterialProductChange(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, skuId: string, key: string) {
  // Delivered ads that show this price or size on screen are recomposed with the new value — no new footage (§42).
  if (key === 'price' || key === 'size') {
    // Loaded lazily: recompose depends on production, which depends (via projects) on this module.
    const { queueRecompositions } = await import('./recompose');
    await queueRecompositions(tx, ctx.workspaceId, skuId);
  }
  // A price change, or a compare-at ("was") price appearing, changing or ending — a promotion (§48).
  const kind = key === 'price' ? 'price_change' : key === 'compare_at_price' ? 'offer_change' : null;
  if (!kind) return;
  const what = kind === 'price_change' ? 'price changed' : 'promotion (compare-at price) changed';
  // The changeover itself is the confounded period: readings either side of it are not one comparable test.
  await recordAutomaticConfounder(tx, ctx, { skuId, kind, endsAt: 'P1D', note: `${what} in product facts`, detail: { key } });
  await weakenLearnings(tx, ctx, skuId, what);
}

/** Confounder kinds that change the context a learning was learned in (§21 "context, offer or market changes"). */
export const CONTEXT_CHANGE_KINDS: ReadonlySet<string> = new Set(['price_change', 'offer_change']);

/**
 * Weaken the directional and actionable learnings of a SKU (or, with `skuId` null, of the whole workspace) because
 * the context they were learned in changed (§21 WEAKENING "reduce weight and schedule validation"): each moves to
 * WEAKENING with a history entry and LEARNING_WEAKENED. Recommendations then propose revalidating them. Returns the
 * learnings weakened. The workspace is named explicitly, so this is also safe from a system transaction.
 */
export async function weakenLearnings(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, skuId: string | null, reason: string, opts: { states?: readonly string[] } = {}): Promise<string[]> {
  const states = [...(opts.states ?? ['DIRECTIONAL', 'ACTIONABLE'])];
  const now = new Date().toISOString();
  const ls = await tx`select id, state, sku_id from learnings where workspace_id = ${ctx.workspaceId} and (${skuId}::uuid is null or sku_id = ${skuId}::uuid)
                      and state = any(${states}) for update`;
  for (const l of ls) {
    await tx`update learnings set state = 'WEAKENING',
               history = history || ${tx.json([{ at: now, from: l.state, to: 'WEAKENING', reason }] as never)} where id = ${l.id} and workspace_id = ${ctx.workspaceId}`;
    await emit(tx, ctx, 'LEARNING_WEAKENED', { type: 'learning', id: l.id as string }, { from: l.state, to: 'WEAKENING', reason }, { skuId: l.sku_id as string });
  }
  return ls.map((l) => l.id as string);
}

/** An ACTIONABLE learning not revalidated for this long is weakened and scheduled for validation (§21). */
export const LEARNING_REVALIDATION_DAYS = 60;

/**
 * Weekly (system role): actionable learnings that no new evidence has revalidated within LEARNING_REVALIDATION_DAYS
 * move to WEAKENING, so ranking stops leaning on them fully and a revalidation test is proposed. Every predicate names
 * the row's own workspace (system_rw sees every tenant).
 */
export async function sweepStaleLearnings(tx: Tx): Promise<number> {
  const stale = await tx`select l.workspace_id, l.sku_id from learnings l
                         where l.state = 'ACTIONABLE' and coalesce(l.last_revalidated_at, l.created_at) < now() - make_interval(days => ${LEARNING_REVALIDATION_DAYS})
                         group by l.workspace_id, l.sku_id limit 500`;
  let n = 0;
  for (const s of stale) {
    const ctx = { workspaceId: s.workspace_id as string, actor: { kind: 'system' as const, id: 'learning-revalidation' } };
    const ids = await tx`select id from learnings where workspace_id = ${ctx.workspaceId} and sku_id = ${s.sku_id as string} and state = 'ACTIONABLE'
                         and coalesce(last_revalidated_at, created_at) < now() - make_interval(days => ${LEARNING_REVALIDATION_DAYS})`;
    if (!ids.length) continue;
    const now = new Date().toISOString();
    for (const l of ids) {
      await tx`update learnings set state = 'WEAKENING', history = history || ${tx.json([{ at: now, from: 'ACTIONABLE', to: 'WEAKENING', reason: `not revalidated in ${LEARNING_REVALIDATION_DAYS} days` }] as never)}
               where id = ${l.id} and workspace_id = ${ctx.workspaceId}`;
      await emit(tx, ctx, 'LEARNING_WEAKENED', { type: 'learning', id: l.id as string }, { from: 'ACTIONABLE', to: 'WEAKENING', reason: 'revalidation due' }, { skuId: s.sku_id as string });
      n++;
    }
  }
  return n;
}

/**
 * An automatic operational confounder (§45 "merchant or automated signal marks affected date range"; §48 price or
 * promotion changes "create an operational-confounder window"). An active one marks the SKU's running tests at
 * once and recomputes them; a candidate ('pending_confirmation', e.g. a detected sales spike) waits for the
 * merchant and confounds nothing until confirmed. `endsAt` 'P1D' = one day from the start; null = still ongoing.
 * An ongoing automatic confounder of the same kind on the SKU is not opened twice.
 */
export async function recordAutomaticConfounder(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  input: { skuId: string | null; kind: string; startsAt?: string | null; endsAt?: string | 'P1D' | null; note: string; detail?: Record<string, unknown>; status?: 'active' | 'pending_confirmation' },
): Promise<string | null> {
  if (input.endsAt === null || input.endsAt === undefined) {
    const [open] = await tx`select id from confounders where source = 'automatic' and kind = ${input.kind} and sku_id is not distinct from ${input.skuId}::uuid
                            and ends_at is null and status <> 'dismissed' limit 1`;
    if (open) return null;
  }
  const status = input.status ?? 'active';
  const [c] = await tx`
    insert into confounders (workspace_id, sku_id, kind, starts_at, ends_at, note, source, created_by, status, detail)
    values (${ctx.workspaceId}, ${input.skuId}, ${input.kind}, coalesce(${input.startsAt ?? null}::timestamptz, now()),
            case when ${input.endsAt === 'P1D'} then coalesce(${input.startsAt ?? null}::timestamptz, now()) + interval '1 day' else ${input.endsAt === 'P1D' ? null : (input.endsAt ?? null)}::timestamptz end,
            ${input.note}, 'automatic', ${actorString(ctx)}, ${status}, ${tx.json((input.detail ?? {}) as never)})
    returning id`;
  if (status === 'active') await confoundRunning(tx, ctx, input.skuId, input.kind);
  return c!.id as string;
}

/** Close the SKU's ongoing automatic confounders of a kind (e.g. back in stock): the window ends now. */
export async function closeAutomaticConfounders(tx: Tx, skuId: string, kind: string) {
  const r = await tx`update confounders set ends_at = now() where sku_id = ${skuId} and kind = ${kind} and source = 'automatic' and ends_at is null returning id`;
  return r.length;
}
