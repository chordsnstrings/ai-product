import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, type StaffRole } from '@arkiv/shared';
import { jobRetryEstimate, requestOpsCommand, type Staff } from './admin';
import { authorize } from './cost-governor';
import { jobErrorClass, QUEUE_POLICY, Queues } from './outbox';
import { ctxFor } from './testing';

/** Plan 05 §12: retry/cancel safety — idempotent handlers only, fresh estimates for spending retries, bulk retry by class. */
beforeEach(truncateAll);
afterAll(closeAll);

async function staff(roles: StaffRole[]): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, ${roles.join('+')}, 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: roles.join('+'), roles };
}

describe('queue policy', () => {
  it('declares every queue, and never lets a purge be re-run as a retry', () => {
    expect(Object.keys(QUEUE_POLICY).sort()).toEqual(Object.values(Queues).sort());
    expect(QUEUE_POLICY[Queues.purgeWorkspace].idempotent).toBe(false);
    expect(QUEUE_POLICY[Queues.produceProject]).toEqual({ idempotent: true, spends: true });
    expect(QUEUE_POLICY[Queues.sendEmail]).toEqual({ idempotent: true, spends: false });
  });

  it('groups failures into error classes: code first, else the message with ids and numbers masked', () => {
    expect(jobErrorClass({ code: 'UNAVAILABLE', message: 'x' })).toBe('UNAVAILABLE');
    const a = jobErrorClass({ message: 'request timed out after 180000ms for 1f2e3d4c-1111-2222-3333-444455556666' });
    const b = jobErrorClass({ message: 'request timed out after 90000ms for 9a8b7c6d-1111-2222-3333-444455556666' });
    expect(a).toBe(b);
    expect(a).toBe('request timed out after <n>ms for <id>');
    expect(jobErrorClass({ message: 'Resend rejected “x@y.com”' })).toBe('Resend rejected <value>');
  });
});

describe('retry safety (plan 05 §12)', () => {
  it('refuses non-idempotent queues and unknown queues, and bulk retries of spending queues', async () => {
    const ops = await staff(['OPS']);
    await expect(requestOpsCommand(ops, 'job.retry', { queue: 'purge-workspace', jobId: 'j1' }, 'purge again')).rejects.toThrow(/aren’t safe to re-run/);
    await expect(requestOpsCommand(ops, 'job.retry', { queue: 'no-such-queue', jobId: 'j1' }, 'retry it')).rejects.toThrow(/Unknown queue/);
    await expect(requestOpsCommand(ops, 'job.bulk_retry', { queue: 'produce-project', errorClass: 'x', jobIds: ['a'] }, 'bulk retry')).rejects.toThrow(/one at a time/);
    await requestOpsCommand(ops, 'job.bulk_retry', { queue: 'send-email', errorClass: 'x', jobIds: ['a', 'b'] }, 'bulk retry');
    const support = await staff(['SUPPORT']);
    await expect(requestOpsCommand(support, 'job.bulk_retry', { queue: 'send-email', errorClass: 'x', jobIds: ['a'] }, 'bulk retry')).rejects.toThrow(/role/);
    expect(await ownerPool()`select kind from ops_commands`).toEqual([{ kind: 'job.bulk_retry' }]);
  });

  it('re-prices a spending job’s last authorization at current rates, flagging a rate change', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    const projectId = newId();
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by) values (${projectId}, ${t.workspaceId}, ${skuId}, 'taste', 'PROVIDER_FAILED', 'test')`;
    const line = { kind: 'llm' as const, provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 10_000, outputTokens: 2_000 };
    const a = await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'creative_test', projectId, skuId, lines: [line], idempotencyKey: `est:${projectId}` }));
    const first = await withAdmin((tx) => jobRetryEstimate(tx, { workspaceId: t.workspaceId, projectId }));
    expect(first).toMatchObject({ authorizationId: a.authorizationId, rateChanged: false });
    expect(first!.micros).toBe(first!.previousMicros);
    // Another workspace's job never reads this one's authorization.
    const other = await makeTenant();
    expect(await withAdmin((tx) => jobRetryEstimate(tx, { workspaceId: other.workspaceId, projectId }))).toBeNull();

    // A newer published rate table: the retry is re-estimated first (plan 05 §12 edge case).
    const [cur] = await ownerPool()`select unit, rates from provider_rate_tables where provider = 'anthropic' and model = 'claude-opus-5-5' and status = 'published' order by version desc limit 1`;
    const doubled = Object.fromEntries(Object.entries(cur!.rates as Record<string, number>).map(([k, v]) => [k, v * 2]));
    await ownerPool()`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, status)
                      values ('anthropic', 'claude-opus-5-5', 999, ${cur!.unit}, ${ownerPool().json(doubled)}, now() - interval '1 minute', 'published')`;
    try {
      const second = await withAdmin((tx) => jobRetryEstimate(tx, { workspaceId: t.workspaceId, projectId }));
      expect(second!.rateChanged).toBe(true);
      expect(second!.micros).toBeGreaterThan(first!.micros);
    } finally {
      await ownerPool()`delete from provider_rate_tables where version = 999`;
    }
  });
});
