import type { Tx } from '@arkiv/db';
import type { Canary } from './model-gateway';

/**
 * Canary guard (plan 05 §11): "canary 5% → 25% → 100% with automatic rollback if live QA first-pass rate or
 * the claim-block rate regresses". The gateway tags every provider call with the arm that served it; this
 * compares the projects each arm touched and clears the canary (audited) when it does measurably worse.
 * Metrics are platform-level aggregates — no tenant content is read.
 */

export interface ArmStats {
  /** Distinct projects that used the arm. */
  projects: number;
  /** Of those, projects blocked by the claims check. */
  blocked: number;
  /** First-attempt scene QA results on those projects, and how many passed. */
  qaFirst: number;
  qaFirstPassed: number;
}

export const CANARY_GUARD = {
  /** Don't judge an arm on fewer samples than this. */
  minProjects: 20,
  minQaChecks: 20,
  /** Roll back when canary first-pass QA is this many points below stable… */
  qaDrop: 0.1,
  /** …or its claim-block rate this many points above stable. */
  blockRise: 0.05,
  /** Look-back when the canary has no recorded start. */
  defaultWindowDays: 7,
};

/** Why the canary regressed against stable, or null if it didn't (or there isn't enough data to say). */
export function canaryRegression(stable: ArmStats, canary: ArmStats, g = CANARY_GUARD): string | null {
  const rate = (n: number, d: number) => n / d;
  if (canary.qaFirst >= g.minQaChecks && stable.qaFirst >= g.minQaChecks) {
    const s = rate(stable.qaFirstPassed, stable.qaFirst);
    const c = rate(canary.qaFirstPassed, canary.qaFirst);
    if (c < s - g.qaDrop) return `QA first-pass ${(c * 100).toFixed(1)}% vs ${(s * 100).toFixed(1)}% stable`;
  }
  if (canary.projects >= g.minProjects && stable.projects >= g.minProjects) {
    const s = rate(stable.blocked, stable.projects);
    const c = rate(canary.blocked, canary.projects);
    if (c > s + g.blockRise) return `claim-block rate ${(c * 100).toFixed(1)}% vs ${(s * 100).toFixed(1)}% stable`;
  }
  return null;
}

/** Per-arm stats for one task since a point in time (system role: every query is cross-tenant by design). */
export async function armStats(tx: Tx, task: string, since: Date): Promise<Record<'stable' | 'canary', ArmStats>> {
  const empty = (): ArmStats => ({ projects: 0, blocked: 0, qaFirst: 0, qaFirstPassed: 0 });
  const out = { stable: empty(), canary: empty() };
  const proj = await tx`
    with j as (select distinct workspace_id, project_id, arm from provider_jobs
               where task = ${task} and arm is not null and project_id is not null and created_at >= ${since})
    select j.arm, count(*)::int as projects,
           count(*) filter (where exists (select 1 from events e where e.workspace_id = j.workspace_id and e.subject_id = j.project_id
                                          and e.type = 'PROJECT_STATE_CHANGED' and e.payload->>'to' = 'BLOCKED_COMPLIANCE' and e.at >= ${since}))::int as blocked
    from j group by j.arm`;
  for (const r of proj) Object.assign(out[r.arm as 'stable' | 'canary'], { projects: Number(r.projects), blocked: Number(r.blocked) });
  const qa = await tx`
    with j as (select distinct workspace_id, project_id, arm from provider_jobs
               where task = ${task} and arm is not null and project_id is not null and created_at >= ${since})
    select j.arm, count(*)::int as first, count(*) filter (where e.type = 'QA_PASSED')::int as passed
    from j
    join projects p on p.id = j.project_id and p.workspace_id = j.workspace_id
    join scenes s on s.storyboard_id = p.storyboard_id and s.workspace_id = p.workspace_id
    join events e on e.subject_id = s.id and e.workspace_id = s.workspace_id and e.type in ('QA_PASSED','QA_FAILED') and e.payload->>'attempt' = '1' and e.at >= ${since}
    group by j.arm`;
  for (const r of qa) Object.assign(out[r.arm as 'stable' | 'canary'], { qaFirst: Number(r.first), qaFirstPassed: Number(r.passed) });
  return out;
}

/** Sweep: roll back every canary that regressed. Returns the tasks rolled back. */
export async function evaluateCanaries(tx: Tx): Promise<{ task: string; why: string }[]> {
  const routes = await tx`select task, canary from model_routes where canary is not null`;
  const rolled: { task: string; why: string }[] = [];
  for (const r of routes) {
    const canary = r.canary as Canary;
    const since = canary.startedAt ? new Date(canary.startedAt) : new Date(Date.now() - CANARY_GUARD.defaultWindowDays * 86400_000);
    const stats = await armStats(tx, r.task as string, since);
    const why = canaryRegression(stats.stable, stats.canary);
    if (!why) continue;
    const [cleared] = await tx`update model_routes set canary = null, updated_at = now() where task = ${r.task} and canary is not null returning task`;
    if (!cleared) continue;
    await tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, reason, before, after)
             values (null, '{}', 'route.canary_rollback', 'route', ${r.task as string}, ${`automatic rollback: ${why}`},
                     ${tx.json({ canary } as never)}, ${tx.json({ canary: null, stats } as never)})`;
    rolled.push({ task: r.task as string, why });
  }
  return rolled;
}
