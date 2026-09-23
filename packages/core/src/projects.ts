import type { Tx } from '@arkiv/db';
import { DomainError, type ProjectState } from '@arkiv/shared';
import type { TenantContext } from './context';
import { emit } from './events';

/**
 * Creative project state machine (§35). Every transition is guarded, evented and idempotent: a late or
 * duplicate event can never move a terminal project backwards (§48 out-of-order callbacks).
 */
const FLOW: ProjectState[] = [
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
const TERMINAL: ReadonlySet<ProjectState> = new Set(['COMPLETE', 'REFUNDED', 'CANCELLED']);
const SIDE: ReadonlySet<ProjectState> = new Set(['NEEDS_USER_ACTION', 'BLOCKED_COMPLIANCE', 'PROVIDER_FAILED']);

export function canTransition(from: ProjectState, to: ProjectState): boolean {
  if (from === to) return true;
  if (TERMINAL.has(from)) return false;
  if (to === 'CANCELLED' || to === 'REFUNDED' || SIDE.has(to)) return true;
  if (SIDE.has(from)) return FLOW.includes(to); // recovery re-enters the main flow
  const i = FLOW.indexOf(from);
  const j = FLOW.indexOf(to);
  if (i < 0 || j < 0) return false;
  // Forward moves, plus the allowed rewinds: re-selecting a concept or re-generating a storyboard pre-render.
  if (j > i) return true;
  return j >= FLOW.indexOf('CONCEPTS_READY') && i <= FLOW.indexOf('STORYBOARD_APPROVED');
}

export async function transition(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  projectId: string,
  to: ProjectState,
  opts: { from?: ProjectState | ProjectState[]; reason?: string; patch?: Record<string, unknown> } = {},
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
  await emit(tx, ctx, 'PROJECT_STATE_CHANGED', { type: 'project', id: projectId }, { from, to, reason: opts.reason ?? null });
  return { changed: true, from };
}

export async function getProject(tx: Tx, projectId: string) {
  const [p] = await tx`select * from projects where id = ${projectId}`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  return p;
}

export const isTerminal = (s: ProjectState) => TERMINAL.has(s);
