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
});
