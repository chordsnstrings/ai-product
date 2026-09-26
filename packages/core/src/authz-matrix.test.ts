import { describe, expect, it } from 'vitest';
import { Role, WorkspaceState } from '@arkiv/shared';
import { assertCan, can, type Action } from './authz';

/**
 * Exhaustive role × action × workspace-state matrix (plan 06 Phase 4: "role matrix tests for every action").
 * The expectations are written out from plan 02 §1.1 (roles) and §2 (lifecycle table) — deliberately NOT derived
 * from the MATRIX constant in authz.ts, so a drift in either direction fails here.
 */

// Plan 02 §1.1, one row per capability line.
const ALL: Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
const CREATORS: Role[] = ['OWNER', 'ADMIN', 'MEMBER']; // "Create SKUs, experiments, storyboards" / "Approve storyboard → spend"
const MANAGERS: Role[] = ['OWNER', 'ADMIN']; // claims, integrations, members (Admin: not Owners)
const OWNER: Role[] = ['OWNER']; // billing, delete, transfer, export all data

// Record<Action, …>: a new Action in authz.ts without a row here fails the typecheck.
const ROLES: Record<Action, Role[]> = {
  'workspace.view': ALL,
  'sku.create': CREATORS,
  'sku.edit': CREATORS,
  'experiment.create': CREATORS,
  'storyboard.approve': CREATORS,
  'spend.creative_test': CREATORS,
  'claim.approve': MANAGERS,
  'footage.accept': MANAGERS,
  'integration.manage': MANAGERS,
  'member.invite': MANAGERS,
  'member.remove': MANAGERS,
  'member.change_role': MANAGERS,
  'member.manage_owner': OWNER,
  'billing.manage': OWNER,
  'workspace.delete': OWNER,
  'workspace.cancel_deletion': OWNER,
  'workspace.transfer': OWNER,
  'workspace.export': OWNER,
};
const ACTIONS = Object.keys(ROLES) as Action[];
const SPEND: Action[] = ['spend.creative_test', 'storyboard.approve'];

/** Plan 02 §2: which actions each lifecycle state still permits (for a role that has them). */
function stateAllows(state: WorkspaceState, action: Action): boolean {
  // "Owner can still cancel the purge until T-0" — and cancelling only means anything while scheduled.
  if (action === 'workspace.cancel_deletion') return state === 'PURGE_SCHEDULED';
  switch (state) {
    case 'PROVISIONAL':
    case 'ACTIVE_FREE':
    case 'ACTIVE_PAID':
      return true;
    case 'PAST_DUE': // Read + export; new paid renders blocked (and no new free-preview spend).
      return !SPEND.includes(action) && action !== 'sku.create';
    case 'CANCELLED': // Read + export + reactivate; the Owner may still delete and members may leave/be removed.
      return ['workspace.view', 'workspace.export', 'billing.manage', 'workspace.delete', 'member.remove'].includes(action);
    case 'LOCKED': // Read-only (dispute handling: export and billing stay reachable)
    case 'SUSPENDED':
    case 'PURGE_SCHEDULED':
    case 'PURGED':
      return ['workspace.view', 'workspace.export', 'billing.manage'].includes(action);
  }
}

describe('authz matrix: every action × role × workspace state', () => {
  for (const state of WorkspaceState) {
    for (const role of Role) {
      it(`${role} in ${state}`, () => {
        const got = ACTIONS.filter((a) => can({ role, workspaceState: state }, a));
        const want = ACTIONS.filter((a) => ROLES[a].includes(role) && stateAllows(state, a));
        expect(got).toEqual(want);
      });
    }
  }

  it('assertCan explains a held workspace to a permitted role, and a role refusal otherwise', () => {
    expect(() => assertCan({ role: 'OWNER', workspaceState: 'CANCELLED' }, 'sku.create')).toThrow(/cancelled; this action is paused/);
    expect(() => assertCan({ role: 'VIEWER', workspaceState: 'ACTIVE_PAID' }, 'sku.create')).toThrow(/role does not allow/);
    expect(() => assertCan({ role: 'OWNER', workspaceState: 'CANCELLED' }, 'billing.manage')).not.toThrow();
  });
});
