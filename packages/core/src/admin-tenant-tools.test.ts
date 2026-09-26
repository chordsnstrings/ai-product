import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { encryptToken } from '@arkiv/integrations';
import { newId, type StaffRole } from '@arkiv/shared';
import { cancelOwnershipTransfer, reconciliationExceptions, requestOwnershipTransfer, startIntervention, type Staff } from './admin';
import { append } from './ledger';
import { dismissNotice } from './lifecycle';
import { syncIntegration } from './performance';
import { ctxFor } from './testing';
import { decideOwnershipTransfer, lookupInvite, lookupOwnershipTransfer, rotateInviteToken, sha256 } from './workspaces';

async function staff(roles: StaffRole[], name = roles.join('+')): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, ${name}, 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name, roles };
}

async function member(workspaceId: string, role: 'ADMIN' | 'MEMBER' | 'OWNER', email = `m-${newId().slice(-8)}@example.com`) {
  const [u] = await ownerPool()`insert into users (email, email_verified_at) values (${email}, now()) returning id`;
  await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${u!.id}, ${role})`;
  return { id: u!.id as string, email };
}

beforeEach(truncateAll);
afterEach(() => vi.unstubAllGlobals());
afterAll(closeAll);

describe('reconciliation exceptions (plan 05 §7, §2.2 Ledger)', () => {
  it('flags paid-without-grant and grant-without-payment, keeps one-off buyers clean, and scopes to one tenant', async () => {
    const oneOff = await makeTenant({ state: 'ACTIVE_PAID' });
    const noGrant = await makeTenant({ state: 'ACTIVE_PAID' });
    const orphanGrant = await makeTenant();
    const bare = await makeTenant({ state: 'ACTIVE_PAID' });
    const test = await makeTenant({ state: 'ACTIVE_PAID' });
    await ownerPool()`update workspaces set is_test = true where id = ${test.workspaceId}`;
    // A one-off buyer: paid purchase with its CREDIT_GRANTED (reference = checkout session) — reconciles.
    await ownerPool()`insert into purchases (workspace_id, kind, amount_micros, stripe_checkout_session_id, status, created_by, paid_at)
                      values (${oneOff.workspaceId}, 'standalone', 29000000, 'cs_ok', 'paid', 'user:x', now() - interval '1 hour')`;
    await withTenant(oneOff.workspaceId, (tx) => append(tx, ctxFor(oneOff.workspaceId, oneOff.userId), { type: 'CREDIT_GRANTED', unit: 'standalone', amount: 1, reference: 'cs_ok', idempotencyKey: 'pay:cs_ok' }));
    // Paid, but the grant never happened.
    await ownerPool()`insert into purchases (workspace_id, kind, amount_micros, stripe_checkout_session_id, status, created_by, paid_at)
                      values (${noGrant.workspaceId}, 'taste', 19000000, 'cs_missing', 'paid', 'user:x', now() - interval '1 hour')`;
    // A payment grant with no purchase behind it.
    await withTenant(orphanGrant.workspaceId, (tx) => append(tx, ctxFor(orphanGrant.workspaceId, orphanGrant.userId), { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, reference: 'cs_ghost', idempotencyKey: 'pay:cs_ghost' }));

    const all = await withAdmin((tx) => reconciliationExceptions(tx));
    const issues = (ws: string) => all.filter((r) => r.workspaceId === ws).map((r) => r.issue).sort();
    expect(issues(oneOff.workspaceId)).toEqual([]);
    expect(issues(noGrant.workspaceId)).toEqual(['Paid purchase without entitlement grant']);
    expect(issues(orphanGrant.workspaceId)).toEqual(['Entitlement granted without a payment']);
    expect(issues(bare.workspaceId)).toEqual(['Workspace ACTIVE_PAID without subscription or payment']);
    // Test accounts are excluded from the platform report unless asked for.
    expect(issues(test.workspaceId)).toEqual([]);
    expect((await withAdmin((tx) => reconciliationExceptions(tx, { includeTest: true }))).some((r) => r.workspaceId === test.workspaceId)).toBe(true);

    // A tenant's Ledger tab sees only its own exceptions.
    const mine = await withAdmin((tx) => reconciliationExceptions(tx, { workspaceId: noGrant.workspaceId }));
    expect(mine.map((r) => [r.workspaceId, r.issue])).toEqual([[noGrant.workspaceId, 'Paid purchase without entitlement grant']]);
    expect(await withAdmin((tx) => reconciliationExceptions(tx, { workspaceId: oneOff.workspaceId }))).toEqual([]);
  });

  it('shows an unrouted failed Stripe event on the tenant whose customer it names', async () => {
    const t = await makeTenant();
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_recon', ${t.workspaceId})`;
    await ownerPool()`insert into stripe_events (id, type, payload, status) values ('evt_fail', 'invoice.paid', ${ownerPool().json({ data: { object: { customer: 'cus_recon' } } })}, 'failed'),
                                                                                ('evt_other', 'invoice.paid', ${ownerPool().json({ data: { object: { customer: 'cus_else' } } })}, 'failed')`;
    const mine = await withAdmin((tx) => reconciliationExceptions(tx, { workspaceId: t.workspaceId }));
    expect(mine.map((r) => r.ref)).toEqual(['evt_fail']);
  });
});

describe('members: resend invite and ownership transfer (plan 05 §2.2)', () => {
  it('resending an invite rotates the link and renews it; accepted or revoked invites are refused', async () => {
    const t = await makeTenant();
    const oldToken = 'old-token-' + newId();
    const [inv] = await ownerPool()`insert into invites (workspace_id, email, role, token_hash, invited_by, expires_at)
                                    values (${t.workspaceId}, 'new@brand.com', 'MEMBER', ${sha256(oldToken)}, ${t.userId}, now() - interval '1 day') returning id`;
    expect((await lookupInvite(oldToken)).status).toBe('expired');
    const other = await makeTenant();
    await expect(withAdmin((tx) => rotateInviteToken(tx, other.workspaceId, inv!.id as string))).rejects.toThrow(/not found/i);
    const r = await withAdmin((tx) => rotateInviteToken(tx, t.workspaceId, inv!.id as string));
    expect(r).toMatchObject({ email: 'new@brand.com', role: 'MEMBER', inviterName: t.email });
    expect((await lookupInvite(oldToken)).status).toBe('not_found');
    expect(await lookupInvite(r.token)).toMatchObject({ status: 'ok', email: 'new@brand.com', workspaceId: t.workspaceId });
    await ownerPool()`update invites set revoked_at = now() where id = ${inv!.id}`;
    await expect(withAdmin((tx) => rotateInviteToken(tx, t.workspaceId, inv!.id as string))).rejects.toThrow(/revoked/);
  });

  it('changes nothing until a current owner confirms from the emailed link, and audits both steps', async () => {
    const t = await makeTenant();
    const next = await member(t.workspaceId, 'ADMIN', 'next-owner@example.com');
    const plain = await member(t.workspaceId, 'MEMBER');
    const ops = await staff(['OPS'], 'Olivia Ops');
    await expect(requestOwnershipTransfer(await staff(['SUPPORT']), t.workspaceId, next.id, 'owner left')).rejects.toThrow(/role/);
    await expect(requestOwnershipTransfer(ops, t.workspaceId, t.userId, 'already owner')).rejects.toThrow(/already owns/);
    const req = await requestOwnershipTransfer(ops, t.workspaceId, next.id, 'Ticket #88: owner is leaving');
    expect(req.notify).toEqual([t.email]);
    expect(req.newOwner.email).toBe('next-owner@example.com');
    const roles = async () => Object.fromEntries((await ownerPool()`select user_id, role from memberships where workspace_id = ${t.workspaceId}`).map((r) => [r.user_id, r.role]));
    expect((await roles())[next.id]).toBe('ADMIN'); // nothing changed yet
    // Only the hash is stored.
    expect(await ownerPool()`select 1 from ownership_transfers where token_hash = ${req.token}`).toHaveLength(0);
    expect(await lookupOwnershipTransfer(req.token)).toMatchObject({ status: 'pending', workspaceId: t.workspaceId, toEmail: 'next-owner@example.com', staffName: 'Olivia Ops' });

    // Someone who isn't an owner of this workspace can't answer, even holding the link.
    await expect(decideOwnershipTransfer(req.token, { id: plain.id }, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const outsider = await makeTenant();
    await expect(decideOwnershipTransfer(req.token, { id: outsider.userId }, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const done = await decideOwnershipTransfer(req.token, { id: t.userId }, true, { ip: '203.0.113.9', userAgent: 'test' });
    expect(done).toMatchObject({ confirmed: true, workspaceId: t.workspaceId });
    expect(await roles()).toMatchObject({ [next.id]: 'OWNER', [t.userId]: 'ADMIN', [plain.id]: 'MEMBER' });
    const ev = await ownerPool()`select subject_id, actor, payload from events where workspace_id = ${t.workspaceId} and type = 'MEMBER_ROLE_CHANGED' order by payload->>'to' desc`;
    expect(ev.map((e) => [e.subject_id, e.actor, e.payload])).toEqual([
      [next.id, `user:${t.userId}`, { from: 'ADMIN', to: 'OWNER', transfer: true, byStaff: true, reason: 'Ticket #88: owner is leaving' }],
      [t.userId, `user:${t.userId}`, { from: 'OWNER', to: 'ADMIN', transfer: true, byStaff: true, reason: 'Ticket #88: owner is leaving' }],
    ]);
    const audits = await ownerPool()`select staff_id, action, workspace_id, ip::text as ip from admin_audit_log where workspace_id = ${t.workspaceId} order by id`;
    expect(audits.map((a) => [a.staff_id, a.action])).toEqual([
      [ops.staffId, 'tenant.transfer_owner_requested'],
      [ops.staffId, 'tenant.transfer_owner_confirmed'],
    ]);
    expect(audits[1]!.ip).toBe('203.0.113.9/32');
    // Both owners are told through the outbox.
    const [mail] = await ownerPool()`select payload from outbox where workspace_id = ${t.workspaceId} and queue = 'send-email'`;
    expect(mail!.payload).toMatchObject({ template: 'ownership_transferred', userIds: [next.id, t.userId] });
    // The link works once.
    await expect(decideOwnershipTransfer(req.token, { id: next.id }, true)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await lookupOwnershipTransfer(req.token)).status).toBe('confirmed');
  });

  it('a decline or a withdrawn request leaves the roles alone; a new request replaces a pending one', async () => {
    const t = await makeTenant();
    const next = await member(t.workspaceId, 'MEMBER');
    const ops = await staff(['OPS']);
    const first = await requestOwnershipTransfer(ops, t.workspaceId, next.id, 'Ticket #1');
    const second = await requestOwnershipTransfer(ops, t.workspaceId, next.id, 'Ticket #2');
    expect((await lookupOwnershipTransfer(first.token)).status).toBe('cancelled');
    const r = await decideOwnershipTransfer(second.token, { id: t.userId }, false);
    expect(r.confirmed).toBe(false);
    const [m] = await ownerPool()`select role from memberships where user_id = ${next.id}`;
    expect(m!.role).toBe('MEMBER');
    const [a] = await ownerPool()`select action from admin_audit_log where action like 'tenant.transfer_owner_de%'`;
    expect(a!.action).toBe('tenant.transfer_owner_declined');
    const third = await requestOwnershipTransfer(ops, t.workspaceId, next.id, 'Ticket #3');
    await expect(cancelOwnershipTransfer(ops, (await makeTenant()).workspaceId, third.transferId, 'wrong tenant')).rejects.toThrow(/no longer pending/);
    await cancelOwnershipTransfer(ops, t.workspaceId, third.transferId, 'customer changed their mind');
    await expect(decideOwnershipTransfer(third.token, { id: t.userId }, true)).rejects.toMatchObject({ code: 'CONFLICT' });
    // An expired request can't be confirmed either.
    const fourth = await requestOwnershipTransfer(ops, t.workspaceId, next.id, 'Ticket #4');
    await ownerPool()`update ownership_transfers set expires_at = now() - interval '1 minute' where id = ${fourth.transferId}`;
    await expect(decideOwnershipTransfer(fourth.token, { id: t.userId }, true)).rejects.toMatchObject({ code: 'CONFLICT' });
    const [still] = await ownerPool()`select role from memberships where user_id = ${next.id}`;
    expect(still!.role).toBe('MEMBER');
  });
});

describe('intervention playbooks (plan 05 §2.2 Risk, §17)', () => {
  it('queues the email, posts the in-app notice and records the start on the flag — once per cooldown', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const sup = await staff(['SUPPORT']);
    const [f] = await ownerPool()`insert into risk_flags (workspace_id, indicator, evidence) values (${t.workspaceId}, 'paid_no_export', '{"projects":1}') returning id`;
    const other = await makeTenant();
    await expect(startIntervention(sup, other.workspaceId, f!.id as string)).rejects.toThrow(/not found/i);
    const r = await startIntervention(sup, t.workspaceId, f!.id as string, { note: 'ticket #12' });
    expect(r).toMatchObject({ playbook: 'paid_no_export', emailed: true, notice: true, by: sup.email });
    const [mail] = await ownerPool()`select payload from outbox where workspace_id = ${t.workspaceId} and queue = 'send-email'`;
    expect(mail!.payload).toMatchObject({ template: 'intervention', indicator: 'paid_no_export', flagId: f!.id });
    const [n] = await ownerPool()`select title, link_path, source, created_by from workspace_notices where workspace_id = ${t.workspaceId}`;
    expect(n).toMatchObject({ title: 'Your ad is ready to upload', link_path: '/results', source: 'risk:paid_no_export', created_by: `staff:${sup.staffId}` });
    const [flag] = await ownerPool()`select interventions from risk_flags where id = ${f!.id}`;
    expect(flag!.interventions).toHaveLength(1);
    await expect(startIntervention(sup, t.workspaceId, f!.id as string)).rejects.toThrow(/minutes ago/);
    const [audit] = await ownerPool()`select action, workspace_id from admin_audit_log where action = 'intervention.start'`;
    expect(audit!.workspace_id).toBe(t.workspaceId);

    // The customer sees the notice until a member dismisses it; nobody dismisses another workspace's notice.
    const [notice] = await ownerPool()`select id from workspace_notices where workspace_id = ${t.workspaceId}`;
    expect(await withTenant(other.workspaceId, (tx) => dismissNotice(tx, ctxFor(other.workspaceId, other.userId), notice!.id as string))).toBe(false);
    expect(await withTenant(t.workspaceId, (tx) => tx`select id from workspace_notices where dismissed_at is null`)).toHaveLength(1);
    const staffCtx = { ...ctxFor(t.workspaceId, t.userId), actor: { kind: 'staff' as const, id: sup.staffId } };
    await expect(withTenant(t.workspaceId, (tx) => dismissNotice(tx, staffCtx, notice!.id as string))).rejects.toThrow(/signed-in member/);
    // Any role may acknowledge it, even while the workspace is held.
    expect(await withTenant(t.workspaceId, (tx) => dismissNotice(tx, ctxFor(t.workspaceId, t.userId, 'VIEWER', 'LOCKED'), notice!.id as string))).toBe(true);
    expect(await withTenant(t.workspaceId, (tx) => dismissNotice(tx, ctxFor(t.workspaceId, t.userId), notice!.id as string))).toBe(false);
    // The app can only mark notices dismissed, never write them.
    await expect(withTenant(t.workspaceId, (tx) => tx`update workspace_notices set title = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(withTenant(t.workspaceId, (tx) => tx`insert into workspace_notices (workspace_id, title, body, created_by) values (${t.workspaceId}, 'x', 'y', 'user')`)).rejects.toThrow(/permission denied/);
  });

  it('records a personal follow-up without messaging, and refuses resolved flags and held workspaces', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ops = await staff(['OPS']);
    const [f] = await ownerPool()`insert into risk_flags (workspace_id, indicator) values (${t.workspaceId}, 'negative_support_sentiment') returning id`;
    const r = await startIntervention(ops, t.workspaceId, f!.id as string);
    expect(r).toMatchObject({ emailed: false, notice: false });
    expect(r.message).toMatch(/follow up personally/);
    expect(await ownerPool()`select 1 from outbox where workspace_id = ${t.workspaceId}`).toHaveLength(0);
    const [g] = await ownerPool()`insert into risk_flags (workspace_id, indicator, resolved_at) values (${t.workspaceId}, 'idle_7d', now()) returning id`;
    await expect(startIntervention(ops, t.workspaceId, g!.id as string)).rejects.toThrow(/resolved/);
    const [h] = await ownerPool()`insert into risk_flags (workspace_id, indicator) values (${t.workspaceId}, 'idle_7d') returning id`;
    await ownerPool()`update workspaces set state = 'SUSPENDED' where id = ${t.workspaceId}`;
    await expect(startIntervention(ops, t.workspaceId, h!.id as string)).rejects.toThrow(/suspended/);
    // Email-only playbooks leave no notice behind.
    await ownerPool()`update workspaces set state = 'ACTIVE_PAID' where id = ${t.workspaceId}`;
    const [lo] = await ownerPool()`insert into risk_flags (workspace_id, indicator) values (${t.workspaceId}, 'low_utilisation') returning id`;
    expect(await startIntervention(ops, t.workspaceId, lo!.id as string, { notice: true })).toMatchObject({ emailed: true, notice: false });
  });
});

describe('integration rate-limit history (plan 05 §2.2 Integrations)', () => {
  it('records each throttle per connection and keeps the connection active', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const [i] = await ownerPool()`insert into integrations (workspace_id, provider, external_account_id, status, token_enc)
                                  values (${t.workspaceId}, 'meta', 'act_123', 'active', ${encryptToken('tok')}) returning id`;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 17, message: 'User request limit reached' } }), { status: 400 }));
    const r = await syncIntegration(ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID'), i!.id as string);
    expect(r).toMatchObject({ ok: false, error: 'rate_limited' });
    const rows = await ownerPool()`select workspace_id, provider, message, retry_after_sec from integration_rate_limits where integration_id = ${i!.id}`;
    expect(rows).toEqual([{ workspace_id: t.workspaceId, provider: 'meta', message: '[meta] User request limit reached', retry_after_sec: 60 }]);
    const [after] = await ownerPool()`select status, error->>'kind' as kind from integrations where id = ${i!.id}`;
    expect(after).toEqual({ status: 'active', kind: 'rate_limited' });
    // Tenants read their own history only.
    const other = await makeTenant();
    expect(await withTenant(other.workspaceId, (tx) => tx`select 1 from integration_rate_limits`)).toHaveLength(0);
  });
});
