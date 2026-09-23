import type { Tx } from '@arkiv/db';
import type { WorkspaceState } from '@arkiv/shared';
import { Queues } from './outbox';

/**
 * Paused jobs (plan 02 §2 "SUSPENDED: all jobs paused"; plan 05 §2.3 suspending with jobs in flight).
 *
 * A job that reaches a worker while its workspace is held is parked in `held_jobs` instead of being dropped,
 * and re-enqueued through the outbox when the hold ends. Jobs already running when the hold starts finish
 * and store their outputs; what they would deliver (the "your ad is ready" email, the export link) is parked
 * the same way, so nothing reaches the customer until the workspace is unsuspended. Reservations are left
 * for the job to settle (the stranded-reservation sweeper skips suspended workspaces).
 */

/** States in which queued jobs wait instead of running. PURGE_SCHEDULED waits so a cancelled purge loses nothing. */
export const JOB_HOLD_STATES: ReadonlySet<WorkspaceState> = new Set(['SUSPENDED', 'PURGE_SCHEDULED']);
/** States in which finished work is not delivered. */
export const DELIVERY_HOLD_STATES: ReadonlySet<WorkspaceState> = new Set(['SUSPENDED']);
/** Staff-requested export on legal request runs regardless of holds. */
export const HOLD_EXEMPT_QUEUES: ReadonlySet<string> = new Set([Queues.exportWorkspace]);
/** Emails that deliver finished work. Other transactional mail (billing, security) is still sent. */
export const DELIVERY_TEMPLATES: ReadonlySet<string> = new Set(['asset_ready', 'export_ready']);

export type HoldDecision = 'run' | 'hold' | 'skip';

export function holdDecision(state: WorkspaceState, queue: string, payload: Record<string, unknown>): HoldDecision {
  if (state === 'PURGED') return 'skip';
  if (HOLD_EXEMPT_QUEUES.has(queue)) return 'run';
  if (queue === Queues.sendEmail) {
    return DELIVERY_HOLD_STATES.has(state) && DELIVERY_TEMPLATES.has(String(payload.template ?? '')) ? 'hold' : 'run';
  }
  return JOB_HOLD_STATES.has(state) ? 'hold' : 'run';
}

/** Park a job. Idempotent per original job id (a redelivered job is parked once). */
export async function holdJob(tx: Tx, workspaceId: string, queue: string, payload: Record<string, unknown>, originalJobId: string | null, reason: string): Promise<boolean> {
  const r = await tx`
    insert into held_jobs (workspace_id, queue, payload, original_job_id, reason)
    values (${workspaceId}, ${queue}, ${tx.json({ ...payload, workspaceId } as never)}, ${originalJobId}, ${reason})
    on conflict do nothing returning id`;
  return r.length > 0;
}

/**
 * Re-enqueue everything parked for a workspace (called when a hold ends). Runs under any role; the explicit
 * workspace filter keeps it tenant-scoped for the staff and system roles, whose policies see all rows.
 */
export async function releaseHeldJobs(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx`update held_jobs set released_at = now() where workspace_id = ${workspaceId} and released_at is null returning queue, payload, held_at`;
  for (const r of rows.sort((a, b) => new Date(a.held_at as string).getTime() - new Date(b.held_at as string).getTime())) {
    await tx`insert into outbox (workspace_id, queue, payload) values (${workspaceId}, ${r.queue as string}, ${tx.json({ ...(r.payload as Record<string, unknown>), workspaceId } as never)})`;
  }
  return rows.length;
}
