import { DomainError, type Role, type WorkspaceState } from '@arkiv/shared';
import type { TenantContext } from './context';

/** Plan 02 §1.1 — the only place role logic lives. */
export type Action =
  | 'workspace.view'
  | 'sku.create'
  | 'sku.edit'
  | 'experiment.create'
  | 'storyboard.approve'
  | 'spend.creative_test'
  | 'claim.approve'
  | 'footage.accept'
  | 'integration.manage'
  | 'member.invite'
  | 'member.remove'
  | 'member.change_role'
  | 'member.manage_owner'
  | 'billing.manage'
  | 'workspace.delete'
  | 'workspace.cancel_deletion'
  | 'workspace.transfer'
  | 'workspace.export';

const MATRIX: Record<Action, readonly Role[]> = {
  'workspace.view': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  'sku.create': ['OWNER', 'ADMIN', 'MEMBER'],
  'sku.edit': ['OWNER', 'ADMIN', 'MEMBER'],
  'experiment.create': ['OWNER', 'ADMIN', 'MEMBER'],
  'storyboard.approve': ['OWNER', 'ADMIN', 'MEMBER'],
  'spend.creative_test': ['OWNER', 'ADMIN', 'MEMBER'],
  'claim.approve': ['OWNER', 'ADMIN'],
  // §26 / plan 03 A7: taking creator footage into a test is a rights decision (the merchant attests on accept).
  'footage.accept': ['OWNER', 'ADMIN'],
  'integration.manage': ['OWNER', 'ADMIN'],
  'member.invite': ['OWNER', 'ADMIN'],
  'member.remove': ['OWNER', 'ADMIN'],
  'member.change_role': ['OWNER', 'ADMIN'],
  'member.manage_owner': ['OWNER'],
  'billing.manage': ['OWNER'],
  'workspace.delete': ['OWNER'],
  'workspace.cancel_deletion': ['OWNER'],
  'workspace.transfer': ['OWNER'],
  'workspace.export': ['OWNER'],
};

/** Actions still allowed when the workspace is on hold / lapsed (plan 02 §2 table). */
const READ_ONLY_OK: ReadonlySet<Action> = new Set(['workspace.view', 'workspace.export', 'billing.manage']);

/**
 * Actions that only make sense in one lifecycle state, and stay allowed there even though that state blocks
 * writes: "PURGE_SCHEDULED — Owner can still cancel the purge until T-0" (plan 02 §2 table, §7).
 */
const ONLY_IN_STATE: Partial<Record<Action, WorkspaceState>> = { 'workspace.cancel_deletion': 'PURGE_SCHEDULED' };

const WRITE_BLOCKED_STATES: ReadonlySet<WorkspaceState> = new Set(['LOCKED', 'SUSPENDED', 'PURGE_SCHEDULED', 'PURGED']);
const SPEND_BLOCKED_STATES: ReadonlySet<WorkspaceState> = new Set([
  'PAST_DUE',
  'CANCELLED',
  'LOCKED',
  'SUSPENDED',
  'PURGE_SCHEDULED',
  'PURGED',
]);

export function can(ctx: Pick<TenantContext, 'role' | 'workspaceState'>, action: Action): boolean {
  if (!MATRIX[action].includes(ctx.role)) return false;
  const only = ONLY_IN_STATE[action];
  if (only) return ctx.workspaceState === only;
  if (WRITE_BLOCKED_STATES.has(ctx.workspaceState) && !READ_ONLY_OK.has(action)) return false;
  if (SPEND_BLOCKED_STATES.has(ctx.workspaceState) && (action === 'spend.creative_test' || action === 'storyboard.approve'))
    return false;
  return true;
}

export function assertCan(ctx: Pick<TenantContext, 'role' | 'workspaceState'>, action: Action): void {
  if (!can(ctx, action)) {
    const held = WRITE_BLOCKED_STATES.has(ctx.workspaceState) || SPEND_BLOCKED_STATES.has(ctx.workspaceState);
    throw new DomainError(
      'FORBIDDEN',
      held && MATRIX[action].includes(ctx.role)
        ? `This workspace is ${ctx.workspaceState.toLowerCase().replace(/_/g, ' ')}; this action is paused.`
        : 'Your role does not allow this action.',
      { action },
    );
  }
}

/** Role hierarchy (display ordering; the Owner-only rules are expressed as `member.manage_owner`). */
export const roleRank: Record<Role, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1, VIEWER: 0 };
