import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { enqueue, holdDecision, Queues, requestExport, setTenantHold } from '@arkiv/core';
import { newId, type StaffRole } from '@arkiv/shared';
import { runJob } from './handlers';

beforeEach(truncateAll);
afterAll(closeAll);

async function ops() {
  const id = newId();
  const roles: StaffRole[] = ['OPS'];
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, 'Ops', 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: 'Ops', roles };
}

describe('hold decisions (plan 05 §2.3)', () => {
  it('pause jobs for held workspaces, hold deliveries only while suspended, and let the legal export run', () => {
    expect(holdDecision('ACTIVE_PAID', Queues.produceProject, {})).toBe('run');
    expect(holdDecision('SUSPENDED', Queues.produceProject, {})).toBe('hold');
    expect(holdDecision('SUSPENDED', Queues.hookVariants, {})).toBe('hold');
    expect(holdDecision('SUSPENDED', Queues.exportWorkspace, {})).toBe('run');
    expect(holdDecision('SUSPENDED', Queues.sendEmail, { template: 'asset_ready' })).toBe('hold');
    expect(holdDecision('SUSPENDED', Queues.sendEmail, { template: 'payment_failed' })).toBe('run');
    expect(holdDecision('PURGE_SCHEDULED', Queues.computeResults, {})).toBe('hold');
    expect(holdDecision('PURGE_SCHEDULED', Queues.sendEmail, { template: 'asset_ready' })).toBe('run');
    expect(holdDecision('PURGE_SCHEDULED', Queues.exportWorkspace, {})).toBe('run');
    // Money owed back (quality-guarantee refund) never waits on a hold; a purge would otherwise drop it.
    expect(holdDecision('SUSPENDED', Queues.refundPurchase, {})).toBe('run');
    expect(holdDecision('PURGE_SCHEDULED', Queues.refundPurchase, {})).toBe('run');
    expect(holdDecision('PURGED', Queues.exportWorkspace, {})).toBe('skip');
  });
});

describe('runJob while a workspace is suspended', () => {
  it('parks jobs and deliveries, still runs the legal export, and replays everything after the lift', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const staff = await ops();
    await setTenantHold(staff, t.workspaceId, 'SUSPENDED', 'fraud review');

    const held = await runJob(Queues.computeResults, { workspaceId: t.workspaceId, experimentId: newId() }, newId());
    expect(held).toMatchObject({ held: 'workspace SUSPENDED', parked: true });
    expect(await runJob(Queues.sendEmail, { workspaceId: t.workspaceId, template: 'asset_ready', projectId: newId() }, newId())).toMatchObject({ held: 'workspace SUSPENDED' });
    // Billing notices are not deliveries of work; they still go out.
    await runJob(Queues.sendEmail, { workspaceId: t.workspaceId, template: 'payment_failed' }, newId());
    // Staff export on legal request runs; its link waits with the other deliveries.
    const exp = await runJob(Queues.exportWorkspace, { workspaceId: t.workspaceId, requestedBy: { kind: 'staff', id: staff.staffId } }, newId());
    expect(exp).toMatchObject({ delivery: 'held' });
    const log = await ownerPool()`select template from email_log where workspace_id = ${t.workspaceId}`;
    expect(log.map((l) => l.template)).toEqual(['payment_failed']);
    expect(await ownerPool()`select queue from outbox where workspace_id = ${t.workspaceId}`).toEqual([]);

    await setTenantHold(staff, t.workspaceId, 'LIFT', 'cleared');
    const replay = await ownerPool()`select id, queue, payload from outbox where workspace_id = ${t.workspaceId} order by created_at`;
    expect(replay.map((r) => `${r.queue}${(r.payload as { template?: string }).template ? ':' + (r.payload as { template: string }).template : ''}`).sort()).toEqual(['compute-results', 'send-email:asset_ready', 'send-email:export_ready']);
    // The released export email mints a fresh signed link from the stored asset.
    const exportMail = replay.find((r) => (r.payload as { template?: string }).template === 'export_ready')!;
    await runJob(Queues.sendEmail, exportMail.payload as Record<string, unknown>, exportMail.id as string);
    expect((await ownerPool()`select template from email_log where workspace_id = ${t.workspaceId} order by created_at`).map((l) => l.template)).toEqual(['payment_failed', 'export_ready']);
  }, 60_000);

  it('drops jobs for purged workspaces', async () => {
    const t = await makeTenant({ state: 'PURGED' });
    expect(await runJob(Queues.computeResults, { workspaceId: t.workspaceId, experimentId: newId() }, newId())).toEqual({ skipped: 'workspace PURGED' });
    expect(await ownerPool()`select 1 from held_jobs`).toHaveLength(0);
  });
});

describe('non-overlapping jobs and atomic singleton keys (standard §35/§39, x-races-14)', () => {
  it('concurrent enqueues with one singleton key leave one pending job; a new one is allowed once it is dispatched', async () => {
    const t = await makeTenant();
    const ctx = { workspaceId: t.workspaceId, workspaceState: 'ACTIVE_FREE' as const, role: 'OWNER' as const, actor: { kind: 'user' as const, id: t.userId }, requestId: 'x' };
    await Promise.all(Array.from({ length: 6 }, () => withTenant(t.workspaceId, (tx) => requestExport(tx, ctx))));
    const pending = await ownerPool()`select id from outbox where workspace_id = ${t.workspaceId} and queue = 'export-workspace' and dispatched_at is null`;
    expect(pending).toHaveLength(1);
    await ownerPool()`update outbox set dispatched_at = now() where id = ${pending[0]!.id}`;
    expect(await withTenant(t.workspaceId, (tx) => enqueue(tx, t.workspaceId, Queues.exportWorkspace, {}, { singletonKey: `export:${t.workspaceId}` }))).toBe(true);
    expect(await withTenant(t.workspaceId, (tx) => enqueue(tx, t.workspaceId, Queues.exportWorkspace, {}, { singletonKey: `export:${t.workspaceId}` }))).toBe(false);
  });

  it('builds one export for a double click, even after the first job was dispatched', async () => {
    const t = await makeTenant();
    const requestedAt = new Date(Date.now() - 1000).toISOString();
    const first = await runJob(Queues.exportWorkspace, { workspaceId: t.workspaceId, requestedAt }, newId());
    expect(typeof first).toBe('string'); // the export asset id
    expect(await runJob(Queues.exportWorkspace, { workspaceId: t.workspaceId, requestedAt }, newId())).toEqual({ skipped: 'already exported since this request' });
    // While an export runs, another one stands down.
    await ownerPool()`insert into workspace_leases (workspace_id, resource, holder, expires_at) values (${t.workspaceId}, 'export', 'other-job', now() + interval '5 minutes')`;
    expect(await runJob(Queues.exportWorkspace, { workspaceId: t.workspaceId, requestedAt: new Date().toISOString() }, newId())).toEqual({ skipped: 'an export is already running' });
    const exports = await ownerPool()`select count(*)::int as n from assets where workspace_id = ${t.workspaceId} and lineage->>'export' = 'true'`;
    expect(exports[0]!.n).toBe(1);
    expect((await ownerPool()`select template from email_log where workspace_id = ${t.workspaceId}`).map((l) => l.template)).toEqual(['export_ready']);
  }, 60_000);

  it('a sync requested while one runs is queued once behind it instead of running concurrently', async () => {
    const t = await makeTenant();
    const integrationId = newId();
    await ownerPool()`insert into workspace_leases (workspace_id, resource, holder, expires_at) values (${t.workspaceId}, ${`sync:${integrationId}`}, 'running-job', now() + interval '5 minutes')`;
    for (let i = 0; i < 3; i++) {
      expect(await runJob(Queues.syncIntegration, { workspaceId: t.workspaceId, integrationId }, newId())).toEqual({ requeued: `sync:${integrationId} is already running` });
    }
    const follow = await ownerPool()`select singleton_key, run_after > now() as later from outbox where workspace_id = ${t.workspaceId} and queue = 'sync-integration' and dispatched_at is null`;
    expect(follow).toEqual([{ singleton_key: `sync:${integrationId}:after-running`, later: true }]);
    // Once the running sync is done (or its lease lapsed), the job runs (here: nothing to sync).
    await ownerPool()`update workspace_leases set expires_at = now() - interval '1 second'`;
    expect(await runJob(Queues.syncIntegration, { workspaceId: t.workspaceId, integrationId }, newId())).toEqual({ skipped: true });
    expect(await ownerPool()`select 1 from workspace_leases where resource like 'sync:%'`).toHaveLength(0);
  });
});

describe('exports while a workspace is scheduled for deletion (x-promises-11)', () => {
  it('builds the export and emails the link: "you can export everything anytime"', async () => {
    const t = await makeTenant({ state: 'PURGE_SCHEDULED' });
    const ctx = { workspaceId: t.workspaceId, workspaceState: 'PURGE_SCHEDULED' as const, role: 'OWNER' as const, actor: { kind: 'user' as const, id: t.userId }, requestId: 'x' };
    await withTenant(t.workspaceId, (tx) => requestExport(tx, ctx));
    const [job] = await ownerPool()`select id, payload from outbox where workspace_id = ${t.workspaceId} and queue = 'export-workspace'`;
    const r = await runJob(Queues.exportWorkspace, job!.payload as Record<string, unknown>, job!.id as string);
    expect(typeof r).toBe('string');
    expect(await ownerPool()`select 1 from held_jobs where workspace_id = ${t.workspaceId}`).toHaveLength(0);
    expect((await ownerPool()`select template from email_log where workspace_id = ${t.workspaceId}`).map((l) => l.template)).toEqual(['export_ready']);
  }, 60_000);
});
