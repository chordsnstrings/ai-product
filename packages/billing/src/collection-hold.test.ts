import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { holdDecision, Queues, setTenantHold, type Staff } from '@arkiv/core';
import { ctxFor } from '@arkiv/core/testing';
import { newId } from '@arkiv/shared';
import { completeMockCheckout, recordAutoRenewConsent, startSubscriptionCheckout, syncCollectionHold } from './billing';
import { MockStripe, setBillingGateway } from './gateway';

/** Plan 02 §2: "SUSPENDED — no jobs; data untouched — Billing: Paused". */
let gw: MockStripe;
beforeEach(async () => {
  await truncateAll();
  gw = new MockStripe();
  setBillingGateway(gw);
});
afterAll(closeAll);

async function subscribed() {
  const t = await makeTenant();
  const free = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
  const consentId = await withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, free, { userId: t.userId, plan: 'GROWTH', agreed: true }));
  const co = await withTenant(t.workspaceId, (tx) => startSubscriptionCheckout(tx, free, 'GROWTH', consentId, { id: t.userId, email: t.email }));
  await completeMockCheckout(co.sessionId);
  const [s] = await ownerPool()`select stripe_subscription_id from subscriptions where workspace_id = ${t.workspaceId}`;
  return { t, subId: s!.stripe_subscription_id as string };
}

async function ops(): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, 'Ops', 'x', ${['OPS']})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: 'Ops', roles: ['OPS'] };
}

const holdJobs = (ws: string) => ownerPool()`select payload from outbox where workspace_id = ${ws} and queue = ${Queues.billingHold} order by created_at`;

describe('suspension pauses billing (plan 02 §2)', () => {
  it('suspending queues a billing pause that pauses Stripe collection; lifting resumes it; other tenants untouched', async () => {
    const a = await subscribed();
    const b = await subscribed();
    const staff = await ops();
    await setTenantHold(staff, a.t.workspaceId, 'SUSPENDED', 'fraud review');
    expect(await holdJobs(a.t.workspaceId)).toHaveLength(1);
    expect(await holdJobs(b.t.workspaceId)).toHaveLength(0);
    // The job runs while the workspace is held (it is the hold's own billing effect).
    expect(holdDecision('SUSPENDED', Queues.billingHold, {})).toBe('run');

    expect(await syncCollectionHold(a.t.workspaceId)).toEqual({ paused: [a.subId], resumed: [] });
    expect([...gw.paused]).toEqual([a.subId]);
    const [s] = await ownerPool()`select collection_paused_at from subscriptions where workspace_id = ${a.t.workspaceId}`;
    expect(s!.collection_paused_at).not.toBeNull();
    // A repeated job converges: nothing more to do.
    expect(await syncCollectionHold(a.t.workspaceId)).toEqual({ paused: [], resumed: [] });
    expect(await syncCollectionHold(b.t.workspaceId)).toEqual({ paused: [], resumed: [] });

    await setTenantHold(staff, a.t.workspaceId, 'LIFT', 'cleared');
    expect(await holdJobs(a.t.workspaceId)).toHaveLength(2);
    expect(await syncCollectionHold(a.t.workspaceId)).toEqual({ paused: [], resumed: [a.subId] });
    expect(gw.paused.size).toBe(0);
    const [after] = await ownerPool()`select collection_paused_at from subscriptions where workspace_id = ${a.t.workspaceId}`;
    expect(after!.collection_paused_at).toBeNull();
  });

  it('a lock (dispute) queues nothing: billing continues for dispute handling', async () => {
    const a = await subscribed();
    await setTenantHold(await ops(), a.t.workspaceId, 'LOCKED', 'chargeback review');
    expect(await holdJobs(a.t.workspaceId)).toHaveLength(0);
    expect(await syncCollectionHold(a.t.workspaceId)).toEqual({ paused: [], resumed: [] });
  });
});
