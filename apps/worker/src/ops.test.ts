import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { append, authorize, available } from '@arkiv/core';
import { ctxFor } from '@arkiv/core/testing';
import { newId } from '@arkiv/shared';
import { processOpsCommands } from './ops';

beforeEach(truncateAll);
afterAll(closeAll);

/** Only what processOpsCommands calls for job.cancel. */
function stubBoss(data: Record<string, unknown>) {
  const cancelled: string[] = [];
  const boss = {
    getJobById: async () => ({ id: 'job-1', data }),
    cancel: async (_q: string, id: string) => {
      cancelled.push(id);
      return { jobs: [id], requested: 1, affected: 1 };
    },
  } as unknown as PgBoss;
  return { boss, cancelled };
}

describe('job.cancel on a production job (standard §38; arch-11)', () => {
  it('cancels the pg-boss job and the production, releasing its reservation before dispatch', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    const projectId = newId();
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit)
                      values (${projectId}, ${t.workspaceId}, ${skuId}, 'creative_test', 'RENDER_RESERVED', 'test', 'creative_test')`;
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 1, idempotencyKey: 'grant:ops' });
      const a = await authorize(tx, ctx, { purpose: 'creative_test', projectId, lines: [{ kind: 'media', outputs: 1 }], entitlement: { unit: 'creative_test', amount: 1 }, idempotencyKey: `produce:${projectId}` });
      await tx`update projects set authorization_id = ${a.authorizationId} where id = ${projectId}`;
      expect(await available(tx, 'creative_test')).toBe(0);
    });
    const staffId = newId();
    await ownerPool()`insert into ops_commands (kind, payload, requested_by, reason) values ('job.cancel', ${ownerPool().json({ queue: 'produce-project', jobId: 'job-1' })}, ${staffId}, 'customer asked by phone')`;
    const { boss, cancelled } = stubBoss({ projectId, workspaceId: t.workspaceId });
    expect(await processOpsCommands(boss)).toBe(1);
    expect(cancelled).toEqual(['job-1']);
    const [cmd] = await ownerPool()`select status, result from ops_commands`;
    expect(cmd!.status).toBe('done');
    expect(cmd!.result).toMatchObject({ production: { projectId, status: 'cancelled', outcome: 'release' } });
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state, cancel_request from projects where id = ${projectId}`;
      expect(p!.state).toBe('CANCELLED');
      expect(p!.cancel_request).toMatchObject({ by: `staff:${staffId}` });
      expect(await available(tx, 'creative_test')).toBe(1); // the Creative Test is back
    });
  });

  it('a job whose production already ended is still cancelled, and says why the production was not', async () => {
    const t = await makeTenant();
    const skuId = await makeSku(t.workspaceId);
    const projectId = newId();
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit)
                      values (${projectId}, ${t.workspaceId}, ${skuId}, 'taste', 'COMPLETE', 'test', 'taste')`;
    await ownerPool()`insert into ops_commands (kind, payload, requested_by, reason) values ('job.cancel', ${ownerPool().json({ queue: 'produce-project', jobId: 'job-1' })}, ${newId()}, 'cleanup of old job')`;
    const { boss, cancelled } = stubBoss({ projectId, workspaceId: t.workspaceId });
    await processOpsCommands(boss);
    expect(cancelled).toEqual(['job-1']);
    const [cmd] = await ownerPool()`select status, result from ops_commands`;
    expect(cmd).toMatchObject({ status: 'done', result: { production: { status: 'not cancelled', reason: 'This ad has already been delivered.' } } });
  });

  it('reports what a cancel means for the job’s dispatch state (§39)', async () => {
    const boss = { getJobById: async () => ({ id: 'job-2', state: 'active', data: {} }), cancel: async () => ({ affected: 1 }) } as unknown as PgBoss;
    await ownerPool()`insert into ops_commands (kind, payload, requested_by, reason) values ('job.cancel', ${ownerPool().json({ queue: 'send-email', jobId: 'job-2' })}, ${newId()}, 'stop the send')`;
    await processOpsCommands(boss);
    const [cmd] = await ownerPool()`select status, result from ops_commands`;
    expect(cmd).toMatchObject({ status: 'done', result: { dispatchState: 'active', dispatch: expect.stringMatching(/^in flight/) } });
  });
});

describe('job.bulk_retry (plan 05 §12)', () => {
  it('retries the chosen failed jobs, skipping held workspaces and jobs that are no longer failed', async () => {
    const ok = await makeTenant();
    const held = await makeTenant({ state: 'SUSPENDED' });
    const jobs: Record<string, { id: string; state: string; data: { workspaceId: string } }> = {
      a: { id: 'a', state: 'failed', data: { workspaceId: ok.workspaceId } },
      b: { id: 'b', state: 'failed', data: { workspaceId: held.workspaceId } },
      c: { id: 'c', state: 'completed', data: { workspaceId: ok.workspaceId } },
    };
    const retried: string[] = [];
    const boss = {
      getJobById: async (_q: string, id: string) => jobs[id] ?? null,
      retry: async (_q: string, ids: string | string[]) => {
        retried.push(...[ids].flat());
        return { affected: [ids].flat().length };
      },
    } as unknown as PgBoss;
    await ownerPool()`insert into ops_commands (kind, payload, requested_by, reason) values ('job.bulk_retry', ${ownerPool().json({ queue: 'send-email', errorClass: 'timeout', jobIds: ['a', 'b', 'c', 'gone'] })}, ${newId()}, 'provider recovered')`;
    await processOpsCommands(boss);
    expect(retried).toEqual(['a']);
    const [cmd] = await ownerPool()`select status, result from ops_commands`;
    expect(cmd).toMatchObject({ status: 'done', result: { requested: 4, retried: 1, skipped: 3, errorClass: 'timeout' } });
  });
});

describe('eval.run on a model dataset (plan 05 §11)', () => {
  it('runs the candidate through the gateway and stores per-case latency and cost on the run', async () => {
    const staffId = newId();
    await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${staffId}, ${`${staffId.slice(-6)}@arkiv.test`}, 'Eng', 'x', '{ENGINEERING}')`;
    const [run] = await ownerPool()`insert into eval_runs (task, prompt_version, model, dataset, status, created_by)
                                    values ('extract.product_facts', 'extract-product@1.1.0', 'claude-opus-5-5', 'extract.packaging', 'queued', ${staffId}) returning id`;
    await ownerPool()`insert into ops_commands (kind, payload, requested_by, reason)
                      values ('eval.run', ${ownerPool().json({ dataset: 'extract.packaging', evalRunId: run!.id, task: 'extract.product_facts', model: 'claude-opus-5-5', promptVersion: 'extract-product@1.1.0' })}, ${staffId}, 'candidate')`;
    await processOpsCommands({} as PgBoss);
    const [r] = await ownerPool()`select status, cases, score, cost_micros, latency_p50_ms, results from eval_runs where id = ${run!.id}`;
    expect(r).toMatchObject({ status: 'passed', cases: 5 });
    expect(Number(r!.cost_micros)).toBeGreaterThan(0);
    expect(r!.latency_p50_ms).not.toBeNull();
    expect((r!.results as { latencyMs: number; costMicros: number }[]).every((c) => c.costMicros > 0 && c.latencyMs >= 0)).toBe(true);
  });
});
