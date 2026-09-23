import { globalTx } from '@arkiv/db';
import { claimProvisional, createWorkspace, moveProvisionalSkus, recordFunnel } from '@arkiv/core';

/**
 * After any successful sign-in: carry the anonymous preview into the account (plan 02 §2.1, plan 04 L3/L5).
 *  - New user (no workspaces): the provisional workspace becomes theirs (claim).
 *  - Existing user: the previewed SKU moves into their most recently used workspace.
 * Returns where to send the user next.
 */
export async function afterLogin(user: { userId: string; lastWorkspaceId?: string | null }, provisionalWorkspaceId: string | null, redirectTo: string | null): Promise<string> {
  const workspaces = await globalTx((tx) => tx`select * from list_user_workspaces(${user.userId})`);
  if (provisionalWorkspaceId) {
    const writable = workspaces.filter((w) => ['OWNER', 'ADMIN', 'MEMBER'].includes(w.role as string));
    try {
      if (!writable.length) {
        await claimProvisional(provisionalWorkspaceId, user.userId);
      } else {
        const target = writable.find((w) => w.workspace_id === user.lastWorkspaceId) ?? writable[writable.length - 1]!;
        await moveProvisionalSkus(provisionalWorkspaceId, target.workspace_id as string, user.userId);
      }
      await recordFunnel('ACCOUNT_CLAIMED', { workspaceId: provisionalWorkspaceId, props: { existingAccount: writable.length > 0 } });
    } catch {
      /* already claimed/moved (idempotent) or expired — continue to the redirect */
    }
    return redirectTo ?? '/app';
  }
  if (!workspaces.length) {
    const { slug } = await createWorkspace(user.userId, 'My brand');
    return redirectTo ?? `/w/${slug}/this-week`;
  }
  return redirectTo ?? '/app';
}
