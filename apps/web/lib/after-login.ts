import { globalTx, withTenant } from '@arkiv/db';
import { claimToken, safeRedirect } from '@arkiv/auth';
import { claimProvisional, createWorkspace, moveProvisionalSkus, recordFunnel } from '@arkiv/core';
import { DomainError, type SignInMethod } from '@arkiv/shared';

const WRITABLE = ['OWNER', 'ADMIN', 'MEMBER'];

/**
 * After any successful sign-in: carry the anonymous preview into the account (plan 02 §2.1, plan 04 L3/L5).
 *  - New user (no workspaces it can write to): the provisional workspace becomes theirs (claim).
 *  - Existing user: they choose — "Add this product to Workspace X" or "Create a new workspace" (/start/claim).
 *  - A preview someone else already saved: an explicit page says so, instead of a concepts page that 404s.
 * Returns where to send the user next (always a path on this app).
 */
export async function afterLogin(user: { userId: string }, provisionalWorkspaceId: string | null, redirectTo: string | null, method: SignInMethod): Promise<string> {
  let next = safeRedirect(redirectTo);
  const workspaces = await globalTx((tx) => tx`select * from list_user_workspaces(${user.userId})`);
  if (provisionalWorkspaceId) {
    if (workspaces.some((m) => m.workspace_id === provisionalWorkspaceId)) return next ?? '/app'; // already theirs
    const [w] = await withTenant(provisionalWorkspaceId, (tx) => tx`select state from workspaces where id = ${provisionalWorkspaceId}`);
    if (w && w.state !== 'PROVISIONAL') return '/start/claim?state=taken'; // saved to another account meanwhile
    if (w) {
      const writable = workspaces.filter((m) => WRITABLE.includes(m.role as string));
      if (writable.length) return `/start/claim?c=${encodeURIComponent(claimToken(provisionalWorkspaceId, user.userId, method))}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
      try {
        await claimProvisional(provisionalWorkspaceId, user.userId);
      } catch (e) {
        if (e instanceof DomainError && e.code === 'CONFLICT') return '/start/claim?state=taken';
        throw e;
      }
      await recordFunnel('ACCOUNT_CLAIMED', { workspaceId: provisionalWorkspaceId, props: { method, existingAccount: false, target: 'claimed' } });
      return next ?? '/app';
    }
    // The preview expired and was swept: an ordinary sign-in, just not back to its (gone) pages.
    if (next && /^\/(concepts|start|storyboard)\//.test(next)) next = null;
  }
  if (!workspaces.length) {
    const { slug } = await createWorkspace(user.userId, 'My brand');
    return next ?? `/w/${slug}/this-week`;
  }
  return next ?? '/app';
}

/**
 * The existing-account choice (plan 02 §2.1), made on /start/claim: move the previewed product into one of the
 * user's writable workspaces, or keep the preview as a new workspace of its own.
 */
export async function settleClaim(userId: string, provisionalWorkspaceId: string, target: string | 'new', method: SignInMethod): Promise<{ workspaceId: string }> {
  if (target === 'new') {
    await claimProvisional(provisionalWorkspaceId, userId);
    await recordFunnel('ACCOUNT_CLAIMED', { workspaceId: provisionalWorkspaceId, props: { method, existingAccount: true, target: 'new_workspace' } });
    return { workspaceId: provisionalWorkspaceId };
  }
  const [m] = await globalTx((tx) => tx`select role from list_user_workspaces(${userId}) where workspace_id = ${target}`);
  if (!m || !WRITABLE.includes(m.role as string)) throw new DomainError('FORBIDDEN', 'You can’t add products to that workspace.');
  const [w] = await withTenant(provisionalWorkspaceId, (tx) => tx`select state from workspaces where id = ${provisionalWorkspaceId}`);
  if (!w || w.state !== 'PROVISIONAL') throw new DomainError('CONFLICT', 'This preview has already been saved to an account.');
  await moveProvisionalSkus(provisionalWorkspaceId, target, userId);
  await recordFunnel('ACCOUNT_CLAIMED', { workspaceId: provisionalWorkspaceId, props: { method, existingAccount: true, target: 'existing_workspace' } });
  return { workspaceId: target };
}
