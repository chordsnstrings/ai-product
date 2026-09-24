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

/** Typical step durations, used when a step's provider task has too little recent history to estimate from. */
export const STEP_EXPECTED_MS: Readonly<Record<string, number>> = {
  read_page: 8_000,
  photos: 6_000,
  identify: 25_000,
  claims: 4_000,
  fingerprint: 6_000,
  concepts: 30_000,
  plan: 20_000,
  frames: 40_000,
};
/** Steps whose duration is dominated by one provider call: estimated from that task's recent latency. */
const STEP_TASK: Readonly<Record<string, string>> = { identify: 'extract.product_facts', concepts: 'creative_director.concepts', plan: 'creative_director.storyboard' };

/**
 * How long a step should take (plan 03 P3: "a true estimate from the job"): the p75 of its provider task's
 * recent successful calls, else the typical duration; null for steps we do not estimate.
 */
export async function expectedStepMs(tx: Tx, key: string): Promise<number | null> {
  const task = STEP_TASK[key];
  if (task) {
    const [r] = await tx`select task_latency_p75(${task}) as ms`;
    if (r?.ms != null) return Number(r.ms);
  }
  return STEP_EXPECTED_MS[key] ?? null;
}

export async function step(tx: Tx, workspaceId: string, subjectId: string, key: string, status: StepStatus, detail?: string | null, label?: string) {
  // The estimate is fixed when the step starts, so the remaining time shown is honest about the original plan.
  const expected = status === 'active' ? await expectedStepMs(tx, key) : null;
  await tx`
    insert into progress_steps (workspace_id, subject_id, step_key, label, status, detail, started_at, completed_at, position, expected_ms)
    values (${workspaceId}, ${subjectId}, ${key}, ${label ?? key}, ${status}, ${detail ?? null},
            ${status === 'active' ? new Date() : null}, ${status === 'done' || status === 'failed' || status === 'skipped' ? new Date() : null}, 100, ${expected})
    on conflict (workspace_id, subject_id, step_key) do update set
      status = excluded.status,
      -- A failed step that starts again (a retried job) is a new attempt: fresh start time, estimate and detail.
      detail = case when progress_steps.status = 'failed' and excluded.status = 'active' then excluded.detail
                    else coalesce(excluded.detail, progress_steps.detail) end,
      label = case when ${label ?? null}::text is null then progress_steps.label else excluded.label end,
      started_at = case when progress_steps.status = 'failed' and excluded.status = 'active' then excluded.started_at
                        else coalesce(progress_steps.started_at, excluded.started_at, case when excluded.status <> 'pending' then now() end) end,
      completed_at = excluded.completed_at,
      expected_ms = case when progress_steps.status = 'failed' and excluded.status = 'active' then excluded.expected_ms
                         else coalesce(progress_steps.expected_ms, excluded.expected_ms) end`;
}

export async function listSteps(tx: Tx, subjectId: string) {
  return tx`select step_key, label, status, detail, started_at, completed_at, expected_ms from progress_steps
            where subject_id = ${subjectId} order by position, started_at nulls last`;
}

/** A step taking longer than this shows its remaining estimate (plan 03 P3 "extraction slower than 45s"). */
export const SLOW_STEP_MS = 45_000;

/**
 * Time left on an active step from its recorded estimate: `remainingMs` is 0 once the estimate has passed (the
 * UI then says "taking longer than usual" instead of counting down past zero).
 */
export function stepEta(s: { status: string; started_at?: Date | string | null; expected_ms?: number | null }, now = Date.now()): { elapsedMs: number; remainingMs: number | null } | null {
  if (s.status !== 'active' || !s.started_at) return null;
  const elapsedMs = Math.max(0, now - new Date(s.started_at).getTime());
  return { elapsedMs, remainingMs: s.expected_ms != null ? Math.max(0, Number(s.expected_ms) - elapsedMs) : null };
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
