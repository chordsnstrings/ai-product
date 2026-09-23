import type { Actor, Role, WorkspaceState } from '@arkiv/shared';
import { actorRef } from '@arkiv/shared';

/**
 * Immutable per-request tenant context (plan 02 §3 layer 1). Every core function that touches tenant
 * data takes it as the first argument; there is no ambient global.
 */
export interface TenantContext {
  readonly workspaceId: string;
  readonly workspaceState: WorkspaceState;
  readonly role: Role;
  readonly actor: Actor;
  readonly requestId: string;
  readonly planCode?: string | null;
}

export const actorString = (ctx: Pick<TenantContext, 'actor'>) => actorRef(ctx.actor);

/** System context for workers acting on behalf of a workspace (e.g. a render job). */
export function systemContext(workspaceId: string, jobId: string, state: WorkspaceState = 'ACTIVE_PAID'): TenantContext {
  return {
    workspaceId,
    workspaceState: state,
    role: 'OWNER',
    actor: { kind: 'system', id: jobId },
    requestId: jobId,
  };
}
