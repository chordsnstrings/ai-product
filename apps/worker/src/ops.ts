import type { PgBoss } from 'pg-boss';
import { ownerPool, withSystem, withTenant } from '@arkiv/db';
import { cancelProduction, DATASETS, JOB_HOLD_STATES, loadCases, Queues, runDeterministicEval, runModelEval, applyTaxonomyRemap, verifyShopifyWebhooks, type TenantContext } from '@arkiv/core';
import { reconcileStripe } from '@arkiv/billing';
import { DomainError } from '@arkiv/shared';

/**
 * Staff-requested queue operations (plan 05 §12), executed here because the worker owns pg-boss. The admin
 * app only inserts audited rows into ops_commands.
 *  - job.retry: only for idempotent handlers (the console checked the queue policy and, for spending queues, that
 *    the operator confirmed a fresh estimate); spend is re-authorised by the handler's Cost Governor call.
 *  - job.bulk_retry: the failed no-spend jobs of one error class, skipping held workspaces.
 *  - job.cancel: pg-boss cancel, reported by dispatch state. A production job also cancels its production
 *    (standard §38): before dispatch the reservation is released at once; a running one stops at its next
 *    checkpoint and settles per the cancel policy.
 *  - dlq.requeue: redrive dead-lettered jobs back to their source queue.
 *  - eval.run: run a golden-set evaluation and store the result.
 *  - stripe.reconcile: the nightly Stripe reconciliation, on demand (plan 05 §7).
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
        case 'job.bulk_retry': {
          // The console chose the failed jobs of one error class; a workspace held since then is skipped (§2.3).
          const ids = ((c.payload as { jobIds?: string[] }).jobIds ?? []).slice(0, 500);
          const jobs: { id: string; state: string; data: { workspaceId?: string } | null }[] = [];
          for (const id of ids) {
            const j = await boss.getJobById<{ workspaceId?: string }>(p.queue!, id).catch(() => null);
            if (j) jobs.push(j);
          }
          const held = new Set(
            (await withSystem((tx) => tx`select id from workspaces where id = any(${[...new Set(jobs.map((j) => j.data?.workspaceId).filter((x): x is string => !!x))]}::uuid[]) and state = any(${[...JOB_HOLD_STATES]})`)).map((r) => r.id as string),
          );
          const retry = jobs.filter((j) => j.state === 'failed' && !(j.data?.workspaceId && held.has(j.data.workspaceId))).map((j) => j.id);
          if (retry.length) await boss.retry(p.queue!, retry);
          result = { errorClass: p.errorClass, requested: ids.length, retried: retry.length, skipped: ids.length - retry.length };
          break;
        }
        case 'job.cancel': {
          // Semantics depend on dispatch state (§39): a job that never started had nothing dispatched; a running one
          // may have provider work in flight, which finishes, is recorded and reconciled — its reservation settles
          // with the handler or expires. A production job also cancels its production (standard §38).
          const job = await boss.getJobById<Record<string, unknown>>(p.queue!, p.jobId!).catch(() => null);
          const state = (job as { state?: string } | null)?.state ?? null;
          const dispatch = !state
            ? 'unknown'
            : ['created', 'retry'].includes(state)
              ? 'before dispatch: never ran, nothing was sent to a provider'
              : state === 'active'
                ? 'in flight: provider calls already sent finish and are reconciled; nothing new is dispatched after the next checkpoint'
                : `already ${state}: nothing to stop`;
          const production = p.queue === Queues.produceProject ? await cancelProductionJob(boss, p.queue, p.jobId!, c.requested_by as string, c.reason as string) : undefined;
          result = { job: await boss.cancel(p.queue!, p.jobId!), dispatchState: state, dispatch, ...(production ? { production } : {}) };
          break;
        }
        case 'dlq.requeue':
          result = { moved: await boss.redrive(`${p.queue}-dlq`, { destination: p.queue, limit: Number(p.limit ?? 100) }) };
          break;
        case 'eval.run': {
          const info = DATASETS[p.dataset!];
          if (!info) throw new Error(`unknown dataset ${p.dataset}`);
          await withSystem((tx) => tx`update eval_runs set status = 'running' where id = ${p.evalRunId!} and status = 'queued'`);
          const cases = await withSystem((tx) => loadCases(tx, p.dataset!));
          // Model datasets run the candidate template × model through the gateway; rules datasets the deterministic engines.
          const r =
            info.kind === 'model'
              ? await runModelEval({ evalRunId: p.evalRunId!, dataset: p.dataset!, task: p.task!, model: p.model!, promptVersion: p.promptVersion!, cases })
              : runDeterministicEval(p.dataset!, cases);
          await withSystem((tx) => tx`update eval_runs set status = ${r.passed ? 'passed' : 'failed'}, cases = ${r.cases}, score = ${r.score},
                                        results = ${tx.json(r.results as never)}, cost_micros = ${r.costMicros}, latency_p50_ms = ${r.latencyP50Ms},
                                        finished_at = now() where id = ${p.evalRunId!}`);
          result = { score: r.score, passed: r.passed, costMicros: r.costMicros };
          break;
        }
        case 'stripe.reconcile':
          result = await reconcileStripe();
          break;
        case 'taxonomy.remap':
          // An approved taxonomy change's migration plan, applied to existing genomes (plan 05 §19).
          result = await applyTaxonomyRemap(p.proposalId!);
          break;
        case 'integration.verify_webhooks': {
          // Each shop's registrations are listed with its own token and missing topics re-registered (plan 05 §16).
          result = await verifyShopifyWebhooks();
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
