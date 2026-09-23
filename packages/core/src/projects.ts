import type { Tx } from '@arkiv/db';
import { DomainError, type ProjectState } from '@arkiv/shared';
import type { TenantContext } from './context';
import { emit } from './events';

/**
 * Creative project state machine (§35). Every transition is guarded, evented and idempotent: a late or
 * duplicate event can never move a terminal project backwards (§48 out-of-order callbacks).
 *
 * The allowed edges are listed explicitly (no "any forward jump"): the canonical path is linear, so production
 * can never skip approval or the reservation. Besides the path:
 *  - pre-approval rewinds: re-select a concept or ask for new ones before the storyboard is approved;
 *  - side states: NEEDS_USER_ACTION / BLOCKED_COMPLIANCE from any live state, PROVIDER_FAILED once production
 *    has been approved;
 *  - recovery: a retry re-approves (→ STORYBOARD_APPROVED), an outage pause resumes rendering, a fixed claim
 *    returns to the storyboard, a new photo resumes analysis;
 *  - CANCELLED before anything is dispatched; REFUNDED once money or entitlement is involved.
 */
const PRE_RENDER_SIDE: ProjectState[] = ['NEEDS_USER_ACTION', 'BLOCKED_COMPLIANCE', 'CANCELLED'];
const IN_FLIGHT_SIDE: ProjectState[] = ['NEEDS_USER_ACTION', 'PROVIDER_FAILED', 'REFUNDED'];

export const NEXT: Readonly<Record<ProjectState, readonly ProjectState[]>> = {
  PRODUCT_UPLOADED: ['PRODUCT_ANALYZED', ...PRE_RENDER_SIDE],
  PRODUCT_ANALYZED: ['BRIEF_READY', ...PRE_RENDER_SIDE],
  BRIEF_READY: ['CONCEPTS_READY', ...PRE_RENDER_SIDE],
  CONCEPTS_READY: ['CONCEPT_SELECTED', ...PRE_RENDER_SIDE],
  CONCEPT_SELECTED: ['STORYBOARD_READY', 'CONCEPTS_READY', ...PRE_RENDER_SIDE],
  STORYBOARD_READY: ['STORYBOARD_APPROVED', 'CONCEPT_SELECTED', 'CONCEPTS_READY', ...PRE_RENDER_SIDE],
  // Approved = paid for / entitlement committed. Cancelling is still possible before anything is dispatched.
  STORYBOARD_APPROVED: ['RENDER_RESERVED', 'CANCELLED', ...IN_FLIGHT_SIDE],
  RENDER_RESERVED: ['RENDERING', 'CANCELLED', ...IN_FLIGHT_SIDE],
  RENDERING: ['QA_RUNNING', ...IN_FLIGHT_SIDE],
  QA_RUNNING: ['COMPOSING', 'BLOCKED_COMPLIANCE', ...IN_FLIGHT_SIDE],
  COMPOSING: ['PLATFORM_VARIANTS', ...IN_FLIGHT_SIDE],
  PLATFORM_VARIANTS: ['FINAL_QA', ...IN_FLIGHT_SIDE],
  FINAL_QA: ['COMPLETE', ...IN_FLIGHT_SIDE],
  COMPLETE: [],
  NEEDS_USER_ACTION: [
    'PRODUCT_ANALYZED', // a usable photo arrived: analysis continues
    'STORYBOARD_APPROVED', // merchant/staff retry
    'RENDER_RESERVED', // entitlement restored: production reserves again
    'RENDERING', // provider outage over: the held reservation resumes rendering
    'PROVIDER_FAILED',
    'CANCELLED',
    'REFUNDED',
  ],
  BLOCKED_COMPLIANCE: ['STORYBOARD_READY', 'CANCELLED', 'REFUNDED'],
  PROVIDER_FAILED: ['STORYBOARD_APPROVED', 'REFUNDED', 'CANCELLED'],
  REFUNDED: [],
  CANCELLED: [],
};

const TERMINAL: ReadonlySet<ProjectState> = new Set(['COMPLETE', 'REFUNDED', 'CANCELLED']);

export function canTransition(from: ProjectState, to: ProjectState): boolean {
  if (from === to) return true;
  return NEXT[from]?.includes(to) ?? false;
}

/** States in which production is (or should be) running under a reservation. */
export const IN_PRODUCTION: readonly ProjectState[] = ['RENDER_RESERVED', 'RENDERING', 'QA_RUNNING', 'COMPOSING', 'PLATFORM_VARIANTS', 'FINAL_QA'];

/** Canonical order of the main path, for "has the project reached X yet?" checks. */
export const PATH: readonly ProjectState[] = [
  'PRODUCT_UPLOADED',
  'PRODUCT_ANALYZED',
  'BRIEF_READY',
  'CONCEPTS_READY',
  'CONCEPT_SELECTED',
  'STORYBOARD_READY',
  'STORYBOARD_APPROVED',
  'RENDER_RESERVED',
  'RENDERING',
  'QA_RUNNING',
  'COMPOSING',
  'PLATFORM_VARIANTS',
  'FINAL_QA',
  'COMPLETE',
];

export async function transition(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  projectId: string,
  to: ProjectState,
  opts: { from?: ProjectState | ProjectState[]; reason?: string; detail?: string; patch?: Record<string, unknown> } = {},
): Promise<{ changed: boolean; from: ProjectState }> {
  const [p] = await tx`select state from projects where id = ${projectId} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  const from = p.state as ProjectState;
  if (from === to) return { changed: false, from };
  const expected = opts.from ? [opts.from].flat() : null;
  if (expected && !expected.includes(from)) return { changed: false, from }; // stale/duplicate event: ignore safely
  if (!canTransition(from, to)) throw new DomainError('CONFLICT', `Project cannot move from ${from} to ${to}`);
  const patch = opts.patch ?? {};
  await tx`update projects set state = ${to}, state_version = state_version + 1,
             failure_reason = ${to === 'PROVIDER_FAILED' || to === 'BLOCKED_COMPLIANCE' || to === 'NEEDS_USER_ACTION' ? (opts.reason ?? null) : null}
           where id = ${projectId}`;
  for (const [k, v] of Object.entries(patch)) {
    await tx`update projects set ${tx({ [k]: v } as never)} where id = ${projectId}`;
  }
  // `reason` is customer-facing (shown in the funnel); `detail` is the internal cause, kept on the event only.
  await emit(tx, ctx, 'PROJECT_STATE_CHANGED', { type: 'project', id: projectId }, { from, to, reason: opts.reason ?? null, detail: opts.detail ?? null });
  return { changed: true, from };
}

export async function getProject(tx: Tx, projectId: string) {
  const [p] = await tx`select * from projects where id = ${projectId}`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  return p;
}

export const isTerminal = (s: ProjectState) => TERMINAL.has(s);
