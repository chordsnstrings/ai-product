import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, type StaffRole } from '@arkiv/shared';
import {
  addTenantNote,
  assertBreakGlass,
  decideApproval,
  requestOpsCommand,
  requestOrExecute,
  setTenantFlags,
  setTenantHold,
  staffCan,
  startBreakGlass,
  type Staff,
} from './admin';
import { append, balances } from './ledger';

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
});
