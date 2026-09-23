import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withSystem, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, type StaffRole } from '@arkiv/shared';
import {
  addTenantNote,
  assertBreakGlass,
  cancelProjectBeforeDispatch,
  cancelTenantPurge,
  decideApproval,
  requestOpsCommand,
  requestOrExecute,
  retryProjectProduction,
  scheduleTenantPurge,
  setTenantFlags,
  setTenantHold,
  staffCan,
  startBreakGlass,
  suppressRiskFlag,
  type Staff,
} from './admin';
import { authorize } from './cost-governor';
import { holdJob } from './holds';
import { append, available, balances } from './ledger';
import { refreshRiskFlags } from './lifecycle';
import { ctxFor } from './testing';

async function staff(roles: StaffRole[], name = roles.join('+')): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, ${name}, 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name, roles };
}

beforeEach(truncateAll);
afterAll(closeAll);

describe('permissions', () => {
  it('maps roles to permissions as a union', () => {
    expect(staffCan(['SUPPORT'], 'breakglass.read')).toBe(true);
    expect(staffCan(['SUPPORT'], 'breakglass.write')).toBe(false);
    expect(staffCan(['ANALYST'], 'tenant.read')).toBe(false);
    expect(staffCan(['ANALYST', 'FINANCE'], 'ledger.adjust')).toBe(true);
    expect(staffCan(['OPS'], 'audit.read')).toBe(false);
  });

  it('SUPPORT re-runs only no-spend jobs; cancel and dead-letter redrive stay with OPS (§0.2)', async () => {
    const support = await staff(['SUPPORT']);
    const ops = await staff(['OPS']);
    expect(staffCan(['SUPPORT'], 'jobs.manage')).toBe(false);
    expect(staffCan(['SUPPORT'], 'jobs.retry_nospend')).toBe(true);
    await requestOpsCommand(support, 'job.retry', { queue: 'send-email', jobId: 'j1' }, 'bounced, retry');
    await expect(requestOpsCommand(support, 'job.retry', { queue: 'produce-project', jobId: 'j2' }, 'retry render')).rejects.toThrow(/no provider spend/);
    await expect(requestOpsCommand(support, 'job.retry', { queue: 'extract-genome', jobId: 'j3' }, 'retry genome')).rejects.toThrow(/no provider spend/);
    await expect(requestOpsCommand(support, 'job.cancel', { queue: 'send-email', jobId: 'j1' }, 'stop it')).rejects.toThrow(/role/);
    await expect(requestOpsCommand(support, 'dlq.requeue', { queue: 'produce-project', limit: 100 }, 'redrive all')).rejects.toThrow(/role/);
    await requestOpsCommand(ops, 'job.retry', { queue: 'produce-project', jobId: 'j2' }, 'retry render');
    await requestOpsCommand(ops, 'dlq.requeue', { queue: 'produce-project', limit: 100 }, 'redrive all');
    const cmds = await ownerPool()`select kind, payload->>'queue' as queue from ops_commands order by created_at`;
    expect(cmds.map((c) => `${c.kind}:${c.queue}`)).toEqual(['job.retry:send-email', 'job.retry:produce-project', 'dlq.requeue:produce-project']);
  });
});

describe('break-glass', () => {
  it('tenant content requires an active session, is audited, and write needs a second reason', async () => {
    const t = await makeTenant();
    const s = await staff(['SUPPORT']);
    await expect(withAdmin((tx) => assertBreakGlass(tx, s, t.workspaceId, 'view SKU'))).rejects.toThrow(/break-glass/);
    await expect(startBreakGlass(s, t.workspaceId, { reason: 'ticket', write: false })).rejects.toThrow(/Describe why/);
    await expect(startBreakGlass(s, t.workspaceId, { reason: 'Ticket #812: storyboard looks wrong', write: true, writeReason: 'fix it for them' })).rejects.toThrow(/role/);
    await startBreakGlass(s, t.workspaceId, { reason: 'Ticket #812: storyboard looks wrong', ticket: '812' });
    await withAdmin((tx) => assertBreakGlass(tx, s, t.workspaceId, 'view SKU'));
    await expect(withAdmin((tx) => assertBreakGlass(tx, s, t.workspaceId, 'edit claim', true))).rejects.toThrow(/write access/);
    // Customer-visible access log (RLS: the tenant sees its own sessions).
    const seen = await withTenant(t.workspaceId, (tx) => tx`select staff_name, reason from break_glass_sessions`);
    expect(seen).toHaveLength(1);
    const log = await ownerPool()`select action from admin_audit_log where staff_id = ${s.staffId} order by id`;
    expect(log.map((l) => l.action)).toEqual(['breakglass.start', 'content.view']);
  });
});

describe('four-eyes', () => {
  it('small ledger adjustments execute immediately; large ones wait for a different approver', async () => {
    const t = await makeTenant();
    const fin = await staff(['FINANCE'], 'Fin A');
    const fin2 = await staff(['FINANCE'], 'Fin B');
    const small = await requestOrExecute(fin, 'ledger.adjust', { workspaceId: t.workspaceId, unit: 'creative_test', amount: 2, nonce: newId() }, 'goodwill for failed render');
    expect(small.status).toBe('executed');
    expect((await withTenant(t.workspaceId, (tx) => balances(tx))).creativeTests).toBe(2);

    const big = await requestOrExecute(fin, 'ledger.adjust', { workspaceId: t.workspaceId, unit: 'creative_test', amount: 10, nonce: newId() }, 'migration credit');
    expect(big.status).toBe('pending');
    const id = (big as { approvalId: string }).approvalId;
    await expect(decideApproval(fin, id, true)).rejects.toThrow(/own request/);
    const ops = await staff(['OPS']);
    await expect(decideApproval(ops, id, true)).rejects.toThrow(/FINANCE/);
    const r = await decideApproval(fin2, id, true);
    expect(r.status).toBe('executed');
    expect((await withTenant(t.workspaceId, (tx) => balances(tx))).creativeTests).toBe(12);
    await expect(decideApproval(fin2, id, true)).rejects.toThrow(/Already/);
  });

  it('a lone SUPER_ADMIN cannot approve their own request', async () => {
    const t = await makeTenant();
    const sa = await staff(['SUPER_ADMIN']);
    const r = await requestOrExecute(sa, 'workspace.purge_now', { workspaceId: t.workspaceId }, 'legal request');
    await expect(decideApproval(sa, (r as { approvalId: string }).approvalId, true)).rejects.toThrow(/own request/);
  });

  it('negative adjustments cannot overdraw', async () => {
    const t = await makeTenant();
    const fin = await staff(['FINANCE']);
    await expect(requestOrExecute(fin, 'ledger.adjust', { workspaceId: t.workspaceId, unit: 'creative_test', amount: -1, nonce: newId() }, 'fix it')).rejects.toThrow(/negative/);
    await withAdmin((tx) => append(tx, { workspaceId: t.workspaceId, actor: { kind: 'system', id: 't' } }, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 3, idempotencyKey: 'g', reason: 'grant' }));
    await requestOrExecute(fin, 'ledger.adjust', { workspaceId: t.workspaceId, unit: 'creative_test', amount: -1, nonce: newId() }, 'double grant');
    expect((await withTenant(t.workspaceId, (tx) => balances(tx))).creativeTests).toBe(2);
  });
});

describe('tenant actions', () => {
  it('suspend and lift restore the previous state; flags and notes are audited', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ops = await staff(['OPS']);
    const support = await staff(['SUPPORT']);
    await expect(setTenantHold(support, t.workspaceId, 'SUSPENDED', 'card testing')).rejects.toThrow(/role/);
    expect(await setTenantHold(ops, t.workspaceId, 'SUSPENDED', 'card testing')).toBe('SUSPENDED');
    await expect(requestOpsCommand(ops, 'job.retry', { workspaceId: t.workspaceId, jobId: 'x', queue: 'produce-project' }, 'retry')).rejects.toThrow(/suspended/);
    expect(await setTenantHold(ops, t.workspaceId, 'LIFT', 'resolved')).toBe('ACTIVE_PAID');
    await setTenantFlags(support, t.workspaceId, { isVip: true, tags: ['agency'] });
    await addTenantNote(support, t.workspaceId, 'Called the founder; happy.');
    const [w] = await ownerPool()`select state, is_vip, tags from workspaces where id = ${t.workspaceId}`;
    expect(w).toMatchObject({ state: 'ACTIVE_PAID', is_vip: true, tags: ['agency'] });
    const events = await withTenant(t.workspaceId, (tx) => tx`select actor, payload from events where type = 'WORKSPACE_STATE_CHANGED' order by at`);
    expect(events[0]!.actor).toBe(`staff:${ops.staffId}`);
    await expect(ownerPool()`delete from admin_audit_log`).rejects.toThrow();
  });

  it('suspension parks jobs and lifting it re-enqueues them; the tenant sees nothing of other tenants', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const other = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ops = await staff(['OPS']);
    await setTenantHold(ops, t.workspaceId, 'SUSPENDED', 'fraud review');
    await withTenant(t.workspaceId, (tx) => holdJob(tx, t.workspaceId, 'compute-results', { experimentId: 'e1' }, 'job-1', 'workspace SUSPENDED'));
    await withTenant(t.workspaceId, (tx) => holdJob(tx, t.workspaceId, 'compute-results', { experimentId: 'e1' }, 'job-1', 'redelivered'));
    await withTenant(other.workspaceId, (tx) => holdJob(tx, other.workspaceId, 'send-email', { template: 'asset_ready' }, 'job-2', 'test'));
    expect(await ownerPool()`select 1 from held_jobs where workspace_id = ${t.workspaceId}`).toHaveLength(1); // parked once
    await setTenantHold(ops, t.workspaceId, 'LIFT', 'cleared');
    const out = await ownerPool()`select workspace_id, queue, payload from outbox where queue = 'compute-results'`;
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toMatchObject({ experimentId: 'e1', workspaceId: t.workspaceId });
    const [held] = await ownerPool()`select released_at from held_jobs where workspace_id = ${t.workspaceId}`;
    expect(held!.released_at).not.toBeNull();
    // Another tenant's parked job is untouched by this lift.
    const [otherHeld] = await ownerPool()`select released_at from held_jobs where workspace_id = ${other.workspaceId}`;
    expect(otherHeld!.released_at).toBeNull();
  });
});

describe('purge scheduling (plan 05 §2.2 danger zone)', () => {
  it('cancelling a purge restores a paying tenant instead of cancelling it', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ops = await staff(['OPS']);
    await scheduleTenantPurge(ops, t.workspaceId, 'legal hold request');
    const [s] = await ownerPool()`select state, state_before_purge, purge_at from workspaces where id = ${t.workspaceId}`;
    expect(s).toMatchObject({ state: 'PURGE_SCHEDULED', state_before_purge: 'ACTIVE_PAID' });
    expect(s!.purge_at).not.toBeNull();
    // Jobs that arrived while the purge was pending run again once it is cancelled.
    await withTenant(t.workspaceId, (tx) => holdJob(tx, t.workspaceId, 'produce-project', { projectId: 'p1' }, 'job-9', 'workspace PURGE_SCHEDULED'));
    expect(await cancelTenantPurge(ops, t.workspaceId, 'request withdrawn')).toBe('ACTIVE_PAID');
    const [w] = await ownerPool()`select state, state_before_purge, purge_at, cancelled_at from workspaces where id = ${t.workspaceId}`;
    expect(w).toMatchObject({ state: 'ACTIVE_PAID', state_before_purge: null, purge_at: null, cancelled_at: null });
    expect(await ownerPool()`select 1 from outbox where queue = 'produce-project' and workspace_id = ${t.workspaceId}`).toHaveLength(1);
    await expect(cancelTenantPurge(ops, t.workspaceId, 'again')).rejects.toThrow(/No purge/);
  });

  it('an early purge approved by a second person still records the prior state; CANCELLED restarts its archive clock', async () => {
    const free = await makeTenant({ state: 'ACTIVE_FREE' });
    const a = await staff(['OPS'], 'Ops A');
    const b = await staff(['OPS'], 'Ops B');
    const r = await requestOrExecute(a, 'workspace.purge_now', { workspaceId: free.workspaceId }, 'owner asked by email');
    await decideApproval(b, (r as { approvalId: string }).approvalId, true);
    expect(await cancelTenantPurge(a, free.workspaceId, 'owner changed their mind')).toBe('ACTIVE_FREE');

    const gone = await makeTenant({ state: 'CANCELLED' });
    await ownerPool()`update workspaces set cancelled_at = now() - interval '100 days' where id = ${gone.workspaceId}`;
    await scheduleTenantPurge(a, gone.workspaceId, 'retention');
    expect(await cancelTenantPurge(a, gone.workspaceId, 'keep for audit')).toBe('CANCELLED');
    const [g] = await ownerPool()`select cancelled_at from workspaces where id = ${gone.workspaceId}`;
    expect(Date.now() - new Date(g!.cancelled_at as string).getTime()).toBeLessThan(60_000);

    // Legacy rows without a recorded prior state fall back to CANCELLED.
    const legacy = await makeTenant({ state: 'PURGE_SCHEDULED' });
    expect(await cancelTenantPurge(a, legacy.workspaceId, 'legacy row')).toBe('CANCELLED');
  });
});

describe('risk flags (plan 05 §2.2 Risk, §17)', () => {
  it('a suppression survives the daily recomputation until it expires', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const sku = await makeSku(t.workspaceId);
    await ownerPool()`update skus set status = 'out_of_stock' where id = ${sku}`;
    const support = await staff(['SUPPORT']);
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    const [flag] = await ownerPool()`select id, indicator from risk_flags where workspace_id = ${t.workspaceId} and resolved_at is null`;
    expect(flag!.indicator).toBe('stockout');
    await expect(suppressRiskFlag(support, t.workspaceId, flag!.id as string, 'restock arrives Friday', 0)).rejects.toThrow(/1–180/);
    const s = await suppressRiskFlag(support, t.workspaceId, flag!.id as string, 'restock arrives Friday', 14);
    expect(new Date(s.suppressedUntil).getTime()).toBeGreaterThan(Date.now() + 13 * 86400_000);
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    expect(await ownerPool()`select 1 from risk_flags where workspace_id = ${t.workspaceId} and resolved_at is null`).toHaveLength(0);
    // Once the suppression lapses and the indicator persists, it is raised again.
    await ownerPool()`update risk_flags set suppressed_until = now() - interval '1 minute' where id = ${flag!.id}`;
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    expect(await ownerPool()`select indicator from risk_flags where workspace_id = ${t.workspaceId} and resolved_at is null`).toEqual([{ indicator: 'stockout' }]);
    // Another workspace's flag id can't be suppressed through this workspace.
    const other = await makeTenant();
    await expect(suppressRiskFlag(support, other.workspaceId, flag!.id as string, 'wrong tenant', 7)).rejects.toThrow(/not found/);
  });

  it('negative support sentiment on a staff note raises its indicator', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const support = await staff(['SUPPORT']);
    await addTenantNote(support, t.workspaceId, 'Frustrated about render times; considering cancelling.', 'negative');
    const found = await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    expect(found.map((f) => f.indicator)).toContain('negative_support_sentiment');
    await addTenantNote(support, t.workspaceId, 'Follow-up call went well.', 'positive');
    const after = await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    expect(after.map((f) => f.indicator)).not.toContain('negative_support_sentiment');
  });
});

describe('experiments & jobs tab (plan 05 §2.2)', () => {
  async function project(workspaceId: string, state: string) {
    const sku = await makeSku(workspaceId);
    const id = newId();
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit) values (${id}, ${workspaceId}, ${sku}, 'taste', ${state}, 'test', 'taste')`;
    return id;
  }

  it('cancel before dispatch releases the reservation; after a provider call it is refused', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const ops = await staff(['OPS']);
    const support = await staff(['SUPPORT']);
    const pid = await project(t.workspaceId, 'RENDER_RESERVED');
    const auth = await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: `pay:${pid}` });
      return authorize(tx, ctx, { purpose: 'taste', projectId: pid, lines: [{ kind: 'media', outputs: 1 }], entitlement: { unit: 'taste', amount: 1 }, idempotencyKey: `produce:${pid}` });
    });
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'taste'))).toBe(0);
    await expect(cancelProjectBeforeDispatch(support, t.workspaceId, pid, 'customer asked')).rejects.toThrow(/role/);
    const r = await cancelProjectBeforeDispatch(ops, t.workspaceId, pid, 'customer asked to change the product');
    expect(r.released).toBe(1);
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state from projects where id = ${pid}`;
      expect(p!.state).toBe('CANCELLED');
      expect(await available(tx, 'taste')).toBe(1);
      const [a] = await tx`select status from cost_authorizations where id = ${auth.authorizationId}`;
      expect(a!.status).toBe('released');
    });
    await expect(cancelProjectBeforeDispatch(ops, t.workspaceId, pid, 'twice')).rejects.toThrow(/haven’t reached a provider/);

    const pid2 = await project(t.workspaceId, 'RENDER_RESERVED');
    const auth2 = await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'taste', projectId: pid2, lines: [{ kind: 'media', outputs: 1 }], entitlement: { unit: 'taste', amount: 1 }, idempotencyKey: `produce:${pid2}` }));
    await ownerPool()`insert into provider_jobs (workspace_id, project_id, provider, task, model, request_hash, status, authorization_id) values (${t.workspaceId}, ${pid2}, 'byteplus', 'video.scene', 'm', 'h', 'dispatched', ${auth2.authorizationId})`;
    await expect(cancelProjectBeforeDispatch(ops, t.workspaceId, pid2, 'too late')).rejects.toThrow(/already dispatched/);
    // A project id from another workspace is not reachable through this one.
    const other = await makeTenant();
    await expect(cancelProjectBeforeDispatch(ops, other.workspaceId, pid2, 'wrong tenant')).rejects.toThrow(/not found/);
  });

  it('retrying a failed production re-enters the flow with a fresh authorization, never while suspended', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ops = await staff(['OPS']);
    const support = await staff(['SUPPORT']);
    const pid = await project(t.workspaceId, 'PROVIDER_FAILED');
    await ownerPool()`insert into cost_authorizations (workspace_id, project_id, purpose, token_hash, idempotency_key, rate_table_versions, estimate, max_cost_micros, status, expires_at)
                      values (${t.workspaceId}, ${pid}, 'taste', 'h1', ${'produce:' + pid}, '{}', '{}', 1, 'refunded', now())`;
    await expect(retryProjectProduction(support, t.workspaceId, pid, 'retry please')).rejects.toThrow(/role/);
    await retryProjectProduction(ops, t.workspaceId, pid, 'provider recovered');
    const [p] = await ownerPool()`select state from projects where id = ${pid}`;
    expect(p!.state).toBe('STORYBOARD_APPROVED');
    expect(await ownerPool()`select 1 from outbox where queue = 'produce-project' and payload->>'projectId' = ${pid}`).toHaveLength(1);
    // The old authorization's key was retired so the worker can authorise afresh.
    const [a] = await ownerPool()`select idempotency_key from cost_authorizations where project_id = ${pid}`;
    expect(a!.idempotency_key).not.toBe(`produce:${pid}`);
    const audit = await ownerPool()`select action from admin_audit_log where staff_id = ${ops.staffId}`;
    expect(audit.map((x) => x.action)).toContain('project.retry');

    const pid2 = await project(t.workspaceId, 'PROVIDER_FAILED');
    await setTenantHold(ops, t.workspaceId, 'SUSPENDED', 'fraud review');
    await expect(retryProjectProduction(ops, t.workspaceId, pid2, 'retry')).rejects.toThrow(/suspended/);
  });
});
