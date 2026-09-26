import type { PlanCode } from '@arkiv/shared';

const PLAN_CODES: readonly string[] = ['LAUNCH', 'GROWTH', 'SCALE'];
/** Workspace states in which a plan is running (past due still has it until the retries end). */
const ON_PLAN = ['ACTIVE_PAID', 'PAST_DUE'];

export interface CurrentPlan {
  slug: string;
  planCode: PlanCode;
  /** Owners and admins change the plan; others are told who can. */
  canManage: boolean;
}

/**
 * The plan a signed-in visitor already has, for the pricing page (plan 03 P11 edge: "already subscribed → the page
 * shows the current plan with upgrade/downgrade"): the workspace they used last when it is on a plan, otherwise the
 * first of theirs that is. Null for a visitor without a plan.
 */
export function currentPlanFor(
  workspaces: readonly { workspace_id: string; slug: string; plan_code: string | null; role: string; state: string }[],
  lastWorkspaceId: string | null,
): CurrentPlan | null {
  const paid = workspaces.filter((w) => w.plan_code && PLAN_CODES.includes(w.plan_code) && ON_PLAN.includes(w.state));
  const w = paid.find((x) => x.workspace_id === lastWorkspaceId) ?? paid[0];
  return w ? { slug: w.slug, planCode: w.plan_code as PlanCode, canManage: ['OWNER', 'ADMIN'].includes(w.role) } : null;
}
