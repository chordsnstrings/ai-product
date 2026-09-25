import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { available, Queues, transitionWorkspace, weekOf } from '@arkiv/core';
import { ctxFor } from '@arkiv/core/testing';
import { completeMockCheckout, processStripeEvent, receiveStripeWebhook, recordAutoRenewConsent, setCancellation, startSubscriptionCheckout } from './billing';
import { MockStripe, setBillingGateway } from './gateway';

/**
 * Subscription lifecycle under real Stripe delivery: out of order, late, and around staff holds and scheduled
 * deletions (standard §35, §39; plan 02 §2, §6).
 */

let gw: MockStripe;
beforeEach(async () => {
  await truncateAll();
  gw = new MockStripe();
  setBillingGateway(gw);
  T = Math.floor(Date.now() / 1000);
});
afterAll(closeAll);

const day = 86400;
let T = Math.floor(Date.now() / 1000);
let n = 0;
/** Deliver one event created at `created` (Stripe's clock, unix seconds). */
async function send(type: string, object: Record<string, unknown>, created: number) {
  const id = `evt_l_${++n}_${Math.random().toString(16).slice(2)}`;
  await receiveStripeWebhook(JSON.stringify({ id, type, data: { object }, created }), null);
  return { id, outcome: await processStripeEvent(id) };
}

async function subscribed(plan: 'LAUNCH' | 'GROWTH' | 'SCALE') {
  const t = await makeTenant();
  const free = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
  const consentId = await withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, free, { userId: t.userId, plan, agreed: true }));
  const co = await withTenant(t.workspaceId, (tx) => startSubscriptionCheckout(tx, free, plan, consentId, { id: t.userId, email: t.email }));
  await completeMockCheckout(co.sessionId);
  // The mock checkout stamps its events with the real time, so the test's Stripe clock starts after them: on a slow
  // runner a clock taken earlier falls behind, and later events look stale to the out-of-order guard.
  T = Math.floor(Date.now() / 1000) + 1;
  const [s] = await ownerPool()`select s.stripe_subscription_id, w.stripe_customer_id from subscriptions s join workspaces w on w.id = s.workspace_id where s.workspace_id = ${t.workspaceId}`;
  const subId = s!.stripe_subscription_id as string;
  const customer = s!.stripe_customer_id as string;
  const subEvent = (fields: Record<string, unknown>) => ({
    id: subId,
    customer,
    status: 'active',
    cancel_at_period_end: false,
    metadata: { workspace_id: t.workspaceId },
    items: { data: [{ price: { id: 'price_unconfigured' }, current_period_start: T, current_period_end: T + 30 * day }] },
    ...fields,
  });
  return { t, ctx: (state = 'ACTIVE_PAID') => ctxFor(t.workspaceId, t.userId, 'OWNER', state as never), subId, customer, subEvent };
}

const ws = async (id: string) => (await ownerPool()`select state, state_before_hold, state_before_purge, plan_code from workspaces where id = ${id}`)[0]!;
const subRow = async (id: string) => (await ownerPool()`select status, cancel_at_period_end, plan_code from subscriptions where workspace_id = ${id}`)[0]!;

describe('out-of-order subscription events (x-sublife-06)', () => {
  it('a cancel delivered after the un-cancel that followed it changes nothing', async () => {
    const { t, subEvent } = await subscribed('GROWTH');
    await send('customer.subscription.updated', subEvent({ cancel_at_period_end: false }), T + 20);
    await send('customer.subscription.updated', subEvent({ cancel_at_period_end: true }), T + 10);
    expect((await subRow(t.workspaceId)).cancel_at_period_end).toBe(false);
  }, 30_000);

  it('a Stripe event created before a change made in the app never undoes it', async () => {
    const { t, ctx, subEvent } = await subscribed('GROWTH');
    await withTenant(t.workspaceId, (tx) => setCancellation(tx, ctx(), true, null));
    await send('customer.subscription.updated', subEvent({ cancel_at_period_end: false }), T - 60);
    expect((await subRow(t.workspaceId)).cancel_at_period_end).toBe(true);
  }, 30_000);

  it('a renewal’s "active" delivered after its payment failed does not recover the plan', async () => {
    const { t, subId, customer, subEvent } = await subscribed('GROWTH');
    await send('invoice.payment_failed', { id: 'in_renew', customer, subscription: subId, attempt_count: 1, next_payment_attempt: T + 3 * day }, T + 3600);
    expect((await ws(t.workspaceId)).state).toBe('PAST_DUE');
    await send('customer.subscription.updated', subEvent({ status: 'active' }), T + 60);
    expect((await ws(t.workspaceId)).state).toBe('PAST_DUE');
    expect((await subRow(t.workspaceId)).status).toBe('past_due');
    // Stripe's own later status change (a retry succeeded) does recover it.
    await send('customer.subscription.updated', subEvent({ status: 'active' }), T + 7200);
    expect((await ws(t.workspaceId)).state).toBe('ACTIVE_PAID');
    expect((await subRow(t.workspaceId)).status).toBe('active');
  }, 30_000);

  it('a failure event arriving after its invoice was paid changes nothing', async () => {
    const { t, subId, customer } = await subscribed('GROWTH');
    await send('invoice.paid', { id: 'in_retry', customer, subscription: subId, billing_reason: 'subscription_update', status: 'paid' }, T + 7200);
    await send('invoice.payment_failed', { id: 'in_retry', customer, subscription: subId, attempt_count: 1 }, T + 3600);
    expect((await ws(t.workspaceId)).state).toBe('ACTIVE_PAID');
    expect((await subRow(t.workspaceId)).status).toBe('active');
    expect((await ownerPool()`select count(*)::int as n from outbox where workspace_id = ${t.workspaceId} and payload->>'template' = 'payment_failed'`)[0]!.n).toBe(0);
  }, 30_000);
});

describe('a paid invoice on an ended subscription (x-sublife-07)', () => {
  it('settles the debt but neither reactivates the plan nor grants tests', async () => {
    const { t, subId, customer } = await subscribed('GROWTH');
    await send('invoice.payment_failed', { id: 'in_last', customer, subscription: subId, attempt_count: 4, next_payment_attempt: null }, T + 100);
    await send('customer.subscription.deleted', { id: subId, customer, metadata: { workspace_id: t.workspaceId }, cancellation_details: { reason: 'payment_failed' } }, T + 200);
    expect((await ws(t.workspaceId)).state).toBe('CANCELLED');
    const next = T + 31 * day;
    await send('invoice.paid', { id: 'in_last', customer, subscription: subId, billing_reason: 'subscription_cycle', status: 'paid', lines: { data: [{ period: { start: next, end: next + 30 * day } }] } }, T + 300);
    expect(await ws(t.workspaceId)).toMatchObject({ state: 'CANCELLED', plan_code: null });
    expect((await subRow(t.workspaceId)).status).toBe('canceled');
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(0);
    const [inv] = await ownerPool()`select status from stripe_invoices where id = 'in_last'`;
    expect(inv!.status).toBe('paid');
    // A late subscription event never revives it either.
    await send('customer.subscription.updated', { id: subId, customer, status: 'active', cancel_at_period_end: false, metadata: { workspace_id: t.workspaceId } }, T + 400);
    expect((await subRow(t.workspaceId)).status).toBe('canceled');
  }, 30_000);
});

describe('subscribing around a staff hold (x-sublife-12)', () => {
  it('no consent or checkout while the workspace is locked or suspended', async () => {
    const t = await makeTenant();
    for (const state of ['LOCKED', 'SUSPENDED'] as const) {
      const held = ctxFor(t.workspaceId, t.userId, 'OWNER', state);
      await expect(withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, held, { userId: t.userId, plan: 'LAUNCH', agreed: true }))).rejects.toThrow(/on hold/);
    }
    const free = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    const consentId = await withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, free, { userId: t.userId, plan: 'LAUNCH', agreed: true }));
    await expect(withTenant(t.workspaceId, (tx) => startSubscriptionCheckout(tx, ctxFor(t.workspaceId, t.userId, 'OWNER', 'LOCKED'), 'LAUNCH', consentId, { id: t.userId, email: t.email }))).rejects.toThrow(/on hold/);
  }, 30_000);

  it('a checkout completed after a lock records the plan and grants its tests, but never lifts the lock', async () => {
    const t = await makeTenant();
    const free = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    const consentId = await withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, free, { userId: t.userId, plan: 'GROWTH', agreed: true }));
    const co = await withTenant(t.workspaceId, (tx) => startSubscriptionCheckout(tx, free, 'GROWTH', consentId, { id: t.userId, email: t.email }));
    await withTenant(t.workspaceId, (tx) => transitionWorkspace(tx, { workspaceId: t.workspaceId, actor: { kind: 'system', id: 't' } }, 'LOCKED', 'dispute'));
    const ids = await completeMockCheckout(co.sessionId);
    const events = await ownerPool()`select status from stripe_events where id in ${ownerPool()(ids)}`;
    expect(events.every((e) => e.status === 'processed')).toBe(true);
    expect(await ws(t.workspaceId)).toMatchObject({ state: 'LOCKED', state_before_hold: 'ACTIVE_PAID', plan_code: 'GROWTH' });
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(7);
    // Lifting the hold returns to the paid state the plan now gives.
    await withTenant(t.workspaceId, (tx) => transitionWorkspace(tx, { workspaceId: t.workspaceId, actor: { kind: 'system', id: 't' } }, 'ACTIVE_PAID', 'staff lift'));
    expect((await ws(t.workspaceId)).state).toBe('ACTIVE_PAID');
  }, 30_000);

  it('a payment recovered during a suspension keeps the suspension; lifting it returns to paid', async () => {
    const { t, subId, customer, subEvent } = await subscribed('LAUNCH');
    await send('invoice.payment_failed', { id: 'in_s', customer, subscription: subId, attempt_count: 1 }, T + 10);
    await withTenant(t.workspaceId, (tx) => transitionWorkspace(tx, { workspaceId: t.workspaceId, actor: { kind: 'system', id: 't' } }, 'SUSPENDED', 'abuse review'));
    expect(await ws(t.workspaceId)).toMatchObject({ state: 'SUSPENDED', state_before_hold: 'PAST_DUE' });
    await send('customer.subscription.updated', subEvent({ status: 'active' }), T + 50);
    expect(await ws(t.workspaceId)).toMatchObject({ state: 'SUSPENDED', state_before_hold: 'ACTIVE_PAID' });
  }, 30_000);
});

describe('billing events during a hold or a scheduled deletion (x-sublife-13)', () => {
  it('a plan that ends during a lock leaves the workspace to return to CANCELLED, not paid', async () => {
    const { t, subId, customer } = await subscribed('GROWTH');
    await send('charge.dispute.created', { id: 'dp_l', charge: 'ch_l', customer, payment_intent: 'pi_l' }, T + 10);
    expect(await ws(t.workspaceId)).toMatchObject({ state: 'LOCKED', state_before_hold: 'ACTIVE_PAID' });
    await send('invoice.payment_failed', { id: 'in_l', customer, subscription: subId, attempt_count: 1 }, T + 20);
    expect(await ws(t.workspaceId)).toMatchObject({ state: 'LOCKED', state_before_hold: 'PAST_DUE' });
    await send('customer.subscription.deleted', { id: subId, customer, metadata: { workspace_id: t.workspaceId }, cancellation_details: { reason: 'payment_failed' } }, T + 30);
    expect(await ws(t.workspaceId)).toMatchObject({ state: 'LOCKED', state_before_hold: 'CANCELLED', plan_code: null });
    const changes = await ownerPool()`select payload from events where workspace_id = ${t.workspaceId} and type = 'WORKSPACE_STATE_CHANGED' and payload ? 'underlying' order by seq`;
    expect(changes.map((c) => (c.payload as { underlying: { to: string } }).underlying.to)).toEqual(['PAST_DUE', 'CANCELLED']);
    // The dispute is won: the workspace returns to where billing left it.
    await send('charge.dispute.closed', { id: 'dp_l', charge: 'ch_l', customer, payment_intent: 'pi_l', status: 'won' }, T + 40);
    expect((await ws(t.workspaceId)).state).toBe('CANCELLED');
  }, 30_000);

  it('a plan that ends while deletion is scheduled makes a cancelled deletion return to CANCELLED', async () => {
    const { t, subId, customer } = await subscribed('GROWTH');
    await withTenant(t.workspaceId, (tx) => transitionWorkspace(tx, { workspaceId: t.workspaceId, actor: { kind: 'system', id: 't' } }, 'PURGE_SCHEDULED', 'owner asked'));
    await send('customer.subscription.deleted', { id: subId, customer, metadata: { workspace_id: t.workspaceId } }, T + 30);
    expect(await ws(t.workspaceId)).toMatchObject({ state: 'PURGE_SCHEDULED', state_before_purge: 'CANCELLED' });
  }, 30_000);
});

describe('a new subscription (standard §9 "Day 1-2")', () => {
  it('queues the first recommendations now, under the weekly run’s key', async () => {
    const { t } = await subscribed('GROWTH');
    const jobs = await ownerPool()`select payload, singleton_key from outbox where workspace_id = ${t.workspaceId} and queue = ${Queues.weeklyRecommendations}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ singleton_key: `recs:${t.workspaceId}:${weekOf()}`, payload: { week: weekOf() } });
  }, 30_000);
});
