import { globalTx } from '@arkiv/db';
import { allowKey, createProvisionalWorkspace, hit, resolveProvisional, type TenantContext } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { currentUser, provisionalToken, setProvisionalCookie } from '@/lib/session';

/**
 * Where a visitor's product goes (plan 02 §2.1): a signed-in user's current writable workspace, otherwise the
 * visitor's provisional workspace — created (and its cookie set) on first use when `create` is set. Shared by
 * the preview submit and the upload endpoints so an upload and the preview it feeds land in the same workspace.
 */
export async function previewContext(ip: string | null, opts: { create: boolean }): Promise<TenantContext> {
  const user = await currentUser();
  if (user) {
    const ws = await globalTx((tx) => tx`select * from list_user_workspaces(${user.userId})`);
    const target = ws.find((w) => w.workspace_id === user.lastWorkspaceId && w.role !== 'VIEWER') ?? ws.find((w) => w.role !== 'VIEWER');
    if (!target) throw new DomainError('FORBIDDEN', 'Your role can’t add products. Ask an admin.');
    return { workspaceId: target.workspace_id, workspaceState: target.state, role: target.role, actor: { kind: 'user', id: user.userId }, requestId: crypto.randomUUID(), planCode: target.plan_code };
  }
  let wsId = await resolveProvisional(await provisionalToken());
  if (!wsId) {
    if (!opts.create) throw new DomainError('NOT_FOUND', 'Upload not found. Please add the photo again.');
    if (ip) await hit(`provisional:ip:${ip.split('.').slice(0, 3).join('.')}`, 15, 3600, undefined, { allow: [allowKey.ip(ip)] });
    const p = await createProvisionalWorkspace();
    await setProvisionalCookie(p.token);
    wsId = p.workspaceId;
  }
  return { workspaceId: wsId, workspaceState: 'PROVISIONAL', role: 'OWNER', actor: { kind: 'provisional', id: wsId }, requestId: crypto.randomUUID() };
}
