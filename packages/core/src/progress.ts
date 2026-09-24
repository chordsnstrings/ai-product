import type { Tx } from '@arkiv/db';

/**
 * Progress ledger (plan 03 P3/P9, design M2/M11). Only real server events are written here — the UI never
 * shows scripted fake steps (plan 04 L7, §3 legal line).
 */
export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export async function planSteps(tx: Tx, workspaceId: string, subjectId: string, steps: { key: string; label: string }[]) {
  for (const [i, s] of steps.entries()) {
    await tx`insert into progress_steps (workspace_id, subject_id, step_key, label, status, position)
             values (${workspaceId}, ${subjectId}, ${s.key}, ${s.label}, 'pending', ${i})
             on conflict (workspace_id, subject_id, step_key) do nothing`;
  }
}

export async function step(tx: Tx, workspaceId: string, subjectId: string, key: string, status: StepStatus, detail?: string | null, label?: string) {
  await tx`
    insert into progress_steps (workspace_id, subject_id, step_key, label, status, detail, started_at, completed_at, position)
    values (${workspaceId}, ${subjectId}, ${key}, ${label ?? key}, ${status}, ${detail ?? null},
            ${status === 'active' ? new Date() : null}, ${status === 'done' || status === 'failed' || status === 'skipped' ? new Date() : null}, 100)
    on conflict (workspace_id, subject_id, step_key) do update set
      status = excluded.status,
      detail = coalesce(excluded.detail, progress_steps.detail),
      label = case when ${label ?? null}::text is null then progress_steps.label else excluded.label end,
      started_at = coalesce(progress_steps.started_at, excluded.started_at, case when excluded.status <> 'pending' then now() end),
      completed_at = excluded.completed_at`;
}

export async function listSteps(tx: Tx, subjectId: string) {
  return tx`select step_key, label, status, detail, started_at, completed_at from progress_steps
            where subject_id = ${subjectId} order by position, started_at nulls last`;
}

// ───────────── Heartbeats (standard §39 "long-running jobs expose heartbeat/progress state") ─────────────

/** A running production writes a heartbeat at least this often (stage boundaries, and every minute while polling). */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** No heartbeat for this long means the run is no longer alive (its lease has lapsed too). */
export const HEARTBEAT_STALE_MS = 5 * 60_000;
/** Each heartbeat keeps the run's reservation alive for at least this much longer. */
export const HEARTBEAT_AUTH_EXTENSION_MINUTES = 30;

/**
 * Record that a job working on a project is alive, and keep its cost authorization from expiring under it: a
 * production that legitimately runs past its reservation TTL (slow provider queues, repairs) must not have the
 * sweeper release its reservation mid-run. Explicitly scoped by workspace (callable under any role).
 */
export async function heartbeat(tx: Tx, workspaceId: string, projectId: string, authorizationId: string | null = null): Promise<void> {
  await tx`update projects set heartbeat_at = now() where id = ${projectId} and workspace_id = ${workspaceId}`;
  if (authorizationId) {
    await tx`update cost_authorizations set expires_at = greatest(expires_at, now() + make_interval(mins => ${HEARTBEAT_AUTH_EXTENSION_MINUTES}))
             where id = ${authorizationId} and workspace_id = ${workspaceId} and status = 'active'`;
  }
}

export type Liveness = { heartbeatAt: string | null; heartbeatAgeMs: number | null; state: 'working' | 'stalled' | 'idle' };

/** "Still working" vs "stalled" for a job that should be running (the UI never guesses from elapsed time alone). */
export function liveness(running: boolean, heartbeatAt: Date | string | null, now = Date.now()): Liveness {
  const at = heartbeatAt ? new Date(heartbeatAt) : null;
  const age = at ? Math.max(0, now - at.getTime()) : null;
  if (!running) return { heartbeatAt: at?.toISOString() ?? null, heartbeatAgeMs: age, state: 'idle' };
  return { heartbeatAt: at?.toISOString() ?? null, heartbeatAgeMs: age, state: age != null && age <= HEARTBEAT_STALE_MS ? 'working' : 'stalled' };
}
