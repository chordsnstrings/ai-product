import { withTenant } from '@arkiv/db';
import { DomainError, type Actor, type WorkspaceState } from '@arkiv/shared';
import type { TenantContext } from '@arkiv/core';

/** Re-enter a tenant context for a job (plan 02 §3 layer 5): the payload carries workspaceId + original actor. */
export async function jobContext(payload: { workspaceId?: string; actor?: Actor }, jobId: string): Promise<TenantContext> {
  if (!payload.workspaceId) throw new DomainError('INVALID', 'job payload missing workspaceId');
  const [w] = await withTenant(payload.workspaceId, (tx) => tx`select state, plan_code from workspaces where id = ${payload.workspaceId!}`);
  if (!w) throw new DomainError('NOT_FOUND', 'workspace gone');
  return {
    workspaceId: payload.workspaceId,
    workspaceState: w.state as WorkspaceState,
    role: 'OWNER',
    actor: payload.actor ?? { kind: 'system', id: jobId },
    // The request that enqueued the job (propagated through the outbox), else the job itself.
    requestId: (payload as { requestId?: string }).requestId ?? jobId,
    planCode: w.plan_code as string | null,
  };
}
