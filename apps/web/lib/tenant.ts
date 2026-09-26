import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { globalTx, withTenant } from '@arkiv/db';
import { noteAccessDenied, resolveProvisional, type ProbeTarget, type TenantContext } from '@arkiv/core';
import { DomainError, type Role, type WorkspaceState } from '@arkiv/shared';
import { currentRequestId } from '@arkiv/shared/log';
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

/** Options for an access check: `probe: false` for lookups that aren't the request's own access (page titles). */
export interface AccessOpts {
  probe?: boolean;
}

/**
 * Deny a lookup of an object the caller can't open (standard §48 "Deny and log"): the answer stays a plain 404 so
 * existence can't be probed, and the denial is logged with a per-user/network counter for the console.
 */
export async function deny(target: ProbeTarget, targetId: string, userId: string | null, opts: AccessOpts = {}): Promise<never> {
  if (opts.probe !== false) {
    const h = await headers().catch(() => null);
    const ip = h?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h?.get('x-real-ip') ?? null;
    await noteAccessDenied({ userId, ip, target, targetId });
  }
  throw new DomainError('NOT_FOUND', 'Not found');
}

export async function workspaceBySlug(slug: string, opts: AccessOpts = {}): Promise<WorkspaceInfo> {
  const user = await currentUser();
  if (!user) throw new DomainError('NOT_FOUND', 'Not found');
  const [m] = await globalTx((tx) => tx`select * from resolve_membership(${user.userId}, ${slug})`);
  if (!m) return deny('workspace', slug, user.userId, opts);
  if (user.lastWorkspaceId !== m.workspace_id) void rememberWorkspace(user.sessionId, m.workspace_id as string);
  return {
    ctx: { workspaceId: m.workspace_id, workspaceState: m.state as WorkspaceState, role: m.role as Role, actor: { kind: 'user', id: user.userId }, requestId: currentRequestId() ?? crypto.randomUUID(), planCode: m.plan_code },
    slug: m.slug,
    name: m.name,
    user: { id: user.userId, email: user.email, name: user.name, sessionId: user.sessionId },
  };
}

/** Page variant of deny(): an id in the URL that isn't this workspace's (RLS hides it) is logged, then a 404. */
export async function denyPage(target: ProbeTarget, targetId: string, w: WorkspaceInfo): Promise<never> {
  try {
    await deny(target, targetId, w.user?.id ?? null);
  } catch {
    /* deny always throws NOT_FOUND */
  }
  notFound();
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
export async function projectAccess(projectId: string, opts: AccessOpts = {}): Promise<WorkspaceInfo & { provisional: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new DomainError('NOT_FOUND', 'Not found');
  const [row] = await globalTx((tx) => tx`select project_workspace(${projectId}) as ws`);
  const ws = row?.ws as string | null;
  const user = await currentUser();
  if (!ws) return deny('project', projectId, user?.userId ?? null, opts);
  if (user) {
    const [m] = await globalTx((tx) => tx`select * from list_user_workspaces(${user.userId}) where workspace_id = ${ws}`);
    if (m) {
      return {
        ctx: { workspaceId: ws, workspaceState: m.state as WorkspaceState, role: m.role as Role, actor: { kind: 'user', id: user.userId }, requestId: currentRequestId() ?? crypto.randomUUID(), planCode: m.plan_code },
        slug: m.slug,
        name: m.name,
        user: { id: user.userId, email: user.email, name: user.name, sessionId: user.sessionId },
        provisional: false,
      };
    }
  }
  const cookie = await provisionalToken();
  const prov = await resolveProvisional(cookie);
  if (prov === ws) {
    return {
      ctx: { workspaceId: ws, workspaceState: 'PROVISIONAL', role: 'OWNER', actor: { kind: 'provisional', id: ws }, requestId: currentRequestId() ?? crypto.randomUUID() },
      slug: '',
      name: 'Your brand',
      user: user ? { id: user.userId, email: user.email, name: user.name, sessionId: user.sessionId } : null,
      provisional: true,
    };
  }
  // A signed-out visitor whose preview cookie no longer opens anything: the preview they were looking at was saved
  // to an account (the link was opened on another device, plan 03 P6). Say so, instead of a bare 404.
  if (!user && cookie && !prov) {
    const [w] = await withTenant(ws, (tx) => tx`select state from workspaces where id = ${ws}`);
    if (w && w.state !== 'PROVISIONAL') throw new DomainError('UNAUTHENTICATED', 'This preview was saved to an account. Log in to keep going.', { savedToAccount: true });
  }
  return deny('project', projectId, user?.userId ?? null, opts);
}

export async function userWorkspaces(userId: string) {
  return globalTx((tx) => tx`select * from list_user_workspaces(${userId})`);
}
