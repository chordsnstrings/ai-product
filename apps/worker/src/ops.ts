import type { PgBoss } from 'pg-boss';
import { ownerPool, withSystem, withTenant } from '@arkiv/db';
import { cancelProduction, Queues, runDeterministicEval, GOLDEN, type TenantContext } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';

/**
 * Staff-requested queue operations (plan 05 §12), executed here because the worker owns pg-boss. The admin
 * app only inserts audited rows into ops_commands.
 *  - job.retry: only for idempotent handlers; spend is re-authorised by the handler's Cost Governor call.
 *  - job.cancel: pg-boss cancel. A production job also cancels its production (standard §38): before dispatch the
 *    reservation is released at once; a running one stops at its next checkpoint and settles per the cancel policy.
 *  - dlq.requeue: redrive dead-lettered jobs back to their source queue.
 *  - eval.run: run a golden-set evaluation and store the result.
 */
export async function processOpsCommands(boss: PgBoss): Promise<number> {
  const cmds = await withSystem((tx) => tx`select * from ops_commands where status = 'pending' order by created_at limit 20`);
  for (const c of cmds) {
    const p = c.payload as Record<string, string>;
    let result: unknown;
    let ok = true;
    try {
      switch (c.kind) {
        case 'job.retry':
          result = await boss.retry(p.queue!, p.jobId!);
          break;
        case 'job.cancel': {
          const production = p.queue === Queues.produceProject ? await cancelProductionJob(boss, p.queue, p.jobId!, c.requested_by as string, c.reason as string) : undefined;
          result = { job: await boss.cancel(p.queue!, p.jobId!), ...(production ? { production } : {}) };
          break;
        }
        case 'dlq.requeue':
          result = { moved: await boss.redrive(`${p.queue}-dlq`, { destination: p.queue, limit: Number(p.limit ?? 100) }) };
          break;
        case 'eval.run': {
          if (!GOLDEN[p.dataset!]) throw new Error(`unknown dataset ${p.dataset}`);
          const r = runDeterministicEval(p.dataset!);
          await withSystem((tx) => tx`update eval_runs set status = ${r.passed ? 'passed' : 'failed'}, cases = ${r.cases}, score = ${r.score},
                                        results = ${tx.json(r.results as never)}, finished_at = now() where id = ${p.evalRunId!}`);
          result = { score: r.score, passed: r.passed };
          break;
        }
        case 'integration.verify_webhooks': {
          // Shopify registrations are verified per shop with its token; without app credentials we only report scope.
          const [n] = await withSystem((tx) => tx`select count(*)::int as n from shopify_shops`);
          result = { shops: n!.n, verified: process.env.SHOPIFY_API_KEY ? 'queued per shop' : 'skipped: Shopify app not configured' };
          break;
        }
        default:
          throw new Error(`unsupported command ${c.kind}`);
      }
    } catch (e) {
      ok = false;
      result = { error: (e as Error).message };
      if (c.kind === 'eval.run' && p.evalRunId) await withSystem((tx) => tx`update eval_runs set status = 'error', finished_at = now() where id = ${p.evalRunId!}`);
    }
    await withSystem((tx) => tx`update ops_commands set status = ${ok ? 'done' : 'failed'}, result = ${tx.json((result ?? {}) as never)}, executed_at = now() where id = ${c.id}`);
  }
  return cmds.length;
}

/** Cancel the production a produce-project job works on, as the staff member who asked (audited on the command). */
async function cancelProductionJob(boss: Pick<PgBoss, 'getJobById'>, queue: string, jobId: string, staffId: string, reason: string) {
  const job = await boss.getJobById<{ projectId?: string; workspaceId?: string }>(queue, jobId);
  const projectId = job?.data?.projectId;
  const workspaceId = job?.data?.workspaceId;
  if (!projectId || !workspaceId) return { status: 'no project on this job' };
  const ctx: TenantContext = { workspaceId, workspaceState: 'ACTIVE_PAID', role: 'OWNER', actor: { kind: 'staff', id: staffId }, requestId: `ops:${jobId}` };
  try {
    const r = await withTenant(workspaceId, (tx) => cancelProduction(tx, ctx, projectId, { reason: `staff job cancel: ${reason}` }));
    return { projectId, status: r.status, outcome: r.decision.outcome };
  } catch (e) {
    // Already delivered or already ended: the job itself is still cancelled.
    if (e instanceof DomainError) return { projectId, status: 'not cancelled', reason: e.message };
    throw e;
  }
}

/** Read-only visibility of the pg-boss schema for the admin console (Jobs & queues, plan 05 §12). */
export async function grantQueueVisibility() {
  const sql = ownerPool();
  await sql`grant usage on schema pgboss to admin_rw`.catch(() => {});
  await sql`grant select on all tables in schema pgboss to admin_rw`.catch(() => {});
  await sql`alter default privileges in schema pgboss grant select on tables to admin_rw`.catch(() => {});
}
