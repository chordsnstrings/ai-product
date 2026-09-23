import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { holdDecision, Queues, setTenantHold } from '@arkiv/core';
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
