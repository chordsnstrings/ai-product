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
  if (key !== 'price') return;
  // The changeover itself is the confounded period: readings either side of it are not one comparable test.
  await tx`insert into confounders (workspace_id, sku_id, kind, starts_at, ends_at, note, source, created_by)
           values (${ctx.workspaceId}, ${skuId}, 'price_change', now(), now() + interval '1 day', 'price changed in product facts', 'automatic', ${actorString(ctx)})`;
  await confoundRunning(tx, ctx, skuId, 'price_change');
  const now = new Date().toISOString();
  const ls = await tx`select id, state from learnings where sku_id = ${skuId} and state in ('DIRECTIONAL','ACTIONABLE') for update`;
  for (const l of ls) {
    await tx`update learnings set state = 'WEAKENING', last_revalidated_at = now(),
               history = history || ${tx.json([{ at: now, from: l.state, to: 'WEAKENING', reason: 'price changed' }] as never)} where id = ${l.id}`;
    await emit(tx, ctx, 'LEARNING_WEAKENED', { type: 'learning', id: l.id as string }, { from: l.state, to: 'WEAKENING', reason: 'price changed' }, { skuId });
  }
}
