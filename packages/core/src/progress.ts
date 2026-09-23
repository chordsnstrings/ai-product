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
