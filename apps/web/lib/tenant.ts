import { notFound } from 'next/navigation';
import { globalTx } from '@arkiv/db';
import { resolveProvisional, type TenantContext } from '@arkiv/core';
import { DomainError, type Role, type WorkspaceState } from '@arkiv/shared';
import { rememberWorkspace } from '@arkiv/auth';
import { currentUser, provisionalToken } from './session';

/**
 * Request → TenantContext (plan 02 §3 layer 1). Membership is resolved server-side on every request; a
 * workspace the user doesn't belong to is a 404, never a 403, so existence can't be probed.
 */
export interface WorkspaceInfo {
  ctx: TenantContext;
  slug: string;
  name: string;
  user: { id: string; email: string; name: string | null; sessionId: string } | null;
}

export async function workspaceBySlug(slug: string): Promise<WorkspaceInfo> {
  const user = await currentUser();
  if (!user) throw new DomainError('NOT_FOUND', 'Not found');
  const [m] = await globalTx((tx) => tx`select * from resolve_membership(${user.userId}, ${slug})`);
  if (!m) throw new DomainError('NOT_FOUND', 'Not found');
  if (user.lastWorkspaceId !== m.workspace_id) void rememberWorkspace(user.sessionId, m.workspace_id as string);
  return {
    ctx: { workspaceId: m.workspace_id, workspaceState: m.state as WorkspaceState, role: m.role as Role, actor: { kind: 'user', id: user.userId }, requestId: crypto.randomUUID(), planCode: m.plan_code },
    slug: m.slug,
    name: m.name,
    user: { id: user.userId, email: user.email, name: user.name, sessionId: user.sessionId },
  };
}

/** Page variant: turns NOT_FOUND into the Next 404 page. */
export async function workspacePage(slug: string) {
  try {
    return await workspaceBySlug(slug);
  } catch {
    notFound();
  }
}

/**
 * Funnel routes address a project directly. Access is allowed for members of its workspace, or for the
 * anonymous visitor holding that provisional workspace's cookie (plan 02 §2.1).
 */
export async function projectAccess(projectId: string): Promise<WorkspaceInfo & { provisional: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new DomainError('NOT_FOUND', 'Not found');
  const [row] = await globalTx((tx) => tx`select project_workspace(${projectId}) as ws`);
  const ws = row?.ws as string | null;
  if (!ws) throw new DomainError('NOT_FOUND', 'Not found');
  const user = await currentUser();
  if (user) {
    const [m] = await globalTx((tx) => tx`select * from list_user_workspaces(${user.userId}) where workspace_id = ${ws}`);
    if (m) {
      return {
        ctx: { workspaceId: ws, workspaceState: m.state as WorkspaceState, role: m.role as Role, actor: { kind: 'user', id: user.userId }, requestId: crypto.randomUUID(), planCode: m.plan_code },
        slug: m.slug,
        name: m.name,
        user: { id: user.userId, email: user.email, name: user.name, sessionId: user.sessionId },
        provisional: false,
      };
    }
  }
  const prov = await resolveProvisional(await provisionalToken());
  if (prov === ws) {
    return {
      ctx: { workspaceId: ws, workspaceState: 'PROVISIONAL', role: 'OWNER', actor: { kind: 'provisional', id: ws }, requestId: crypto.randomUUID() },
      slug: '',
      name: 'Your brand',
      user: user ? { id: user.userId, email: user.email, name: user.name, sessionId: user.sessionId } : null,
      provisional: true,
    };
  }
  throw new DomainError('NOT_FOUND', 'Not found');
}

export async function userWorkspaces(userId: string) {
  return globalTx((tx) => tx`select * from list_user_workspaces(${userId})`);
}
