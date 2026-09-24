import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, available, generateStoryboard, ingestBytes, periodUsage, scheduleDeletion, selectConcept, setStockIntent, startPreview } from '@arkiv/core';
import { ctxFor, productPhoto } from '@arkiv/core/testing';
import {
  autoRenewText,
  cancelSubscriptionsForPurge,
  changePlan,
  completeMockCheckout,
  processStripeEvent,
  receiveStripeWebhook,
  recordAutoRenewConsent,
  setCancellation,
  startProductionCheckout,
  startSubscriptionCheckout,
} from './billing';
import { MockStripe, setBillingGateway } from './gateway';
import { applySucceededRefund } from './refunds';

let gw: MockStripe;
beforeEach(async () => {
  await truncateAll();
  gw = new MockStripe();
  setBillingGateway(gw);
});
afterAll(closeAll);

let n = 0;
async function send(type: string, object: Record<string, unknown>) {
  const id = `evt_t_${++n}_${Math.random().toString(16).slice(2)}`;
  await receiveStripeWebhook(JSON.stringify({ id, type, data: { object }, created: Math.floor(Date.now() / 1000) + n }), null);
  return { id, outcome: await processStripeEvent(id) };
}
const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
const day = 86400;

/** A workspace subscribed to `plan` through the real consent → checkout → webhook flow. */
async function subscribed(plan: 'LAUNCH' | 'GROWTH' | 'SCALE') {
  const t = await makeTenant();
  const free = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
  const consentId = await withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, free, { userId: t.userId, plan, agreed: true }));
  const co = await withTenant(t.workspaceId, (tx) => startSubscriptionCheckout(tx, free, plan, consentId, { id: t.userId, email: t.email }));
  await completeMockCheckout(co.sessionId);
  const [s] = await ownerPool()`select s.stripe_subscription_id, s.current_period_start, w.stripe_customer_id from subscriptions s join workspaces w on w.id = s.workspace_id where s.workspace_id = ${t.workspaceId}`;
  return {
    t,
    ctx: (state = 'ACTIVE_PAID') => ctxFor(t.workspaceId, t.userId, 'OWNER', state as never),
    subId: s!.stripe_subscription_id as string,
    customer: s!.stripe_customer_id as string,
    periodKey: new Date(s!.current_period_start as string).toISOString().slice(0, 10),
  };
}

async function storyboardReady() {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const concepts = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx`;
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, concepts[0]!.id as string));
  await generateStoryboard(ctx, projectId, storyboardId, concepts[0]!.id as string);
  return { t, ctx, projectId, storyboardId, concepts: concepts.map((c) => c.id as string) };
}

describe('auto-renew consent text (plan 04 §3, L10)', () => {
  it('names the tax and the billing day as Stripe bills it', () => {
    expect(autoRenewText('GROWTH', new Date('2026-09-28T12:00:00Z'))).toBe(
      '$99/month plus applicable sales tax, charged today and on the 28th of each month until you cancel. Cancel online anytime in Settings → Billing.',
    );
    for (const [d, nth] of [[29, '29th'], [30, '30th'], [31, '31st']] as const) {
      const text = autoRenewText('LAUNCH', new Date(`2026-10-${d}T12:00:00Z`));
      expect(text).toContain(`on the ${nth} of each month (the last day of shorter months)`);
      expect(text).toMatch(/^\$49\/month plus applicable sales tax/);
    }
    expect(autoRenewText('SCALE', new Date('2026-10-01T12:00:00Z'))).toContain('on the 1st of each month until you cancel');
  });
});

describe('cancelling (plan 03 A9, plan 05 §17)', () => {
  it('keeps the reason code and the free text apart on the event', async () => {
    const { t, ctx } = await subscribed('GROWTH');
    await withTenant(t.workspaceId, (tx) => setCancellation(tx, ctx(), true, { code: 'paused_ads', detail: '  Back in spring  ' }));
    const [e] = await ownerPool()`select payload from events where workspace_id = ${t.workspaceId} and type = 'SUBSCRIPTION_CHANGED' order by seq desc limit 1`;
    expect(e!.payload).toEqual({ cancelAtPeriodEnd: true, reasonCode: 'paused_ads', detail: 'Back in spring' });
  }, 30_000);

  it('a past-due plan is cancelled immediately: Stripe stops, tests expire, the workspace is CANCELLED and can be deleted', async () => {
    const { t, ctx, subId, customer, periodKey } = await subscribed('GROWTH');
    await send('invoice.payment_failed', { id: 'in_fail', customer, subscription: subId, attempt_count: 1, next_payment_attempt: Math.floor(Date.now() / 1000) + 3 * day });
    const r = await withTenant(t.workspaceId, (tx) => setCancellation(tx, ctx('PAST_DUE'), true, { code: 'too_expensive' }));
    expect(r.immediate).toBe(true);
    expect(gw.canceled).toEqual([subId]);
    const [w] = await ownerPool()`select state, plan_code from workspaces where id = ${t.workspaceId}`;
    expect(w).toMatchObject({ state: 'CANCELLED', plan_code: null });
    await withTenant(t.workspaceId, async (tx) => {
      expect(await available(tx, 'creative_test')).toBe(0);
      expect((await periodUsage(tx, periodKey)).remaining).toBe(0);
    });
    await withTenant(t.workspaceId, (tx) => scheduleDeletion(tx, ctx('CANCELLED')));
    // Stripe's own deletion webhook arrives later: no second churn event, no email.
    await send('customer.subscription.deleted', { id: subId, customer, metadata: { workspace_id: t.workspaceId } });
    expect(await count(ownerPool()`select count(*)::int as n from events where workspace_id = ${t.workspaceId} and type = 'SUBSCRIPTION_ENDED'`)).toBe(1);
    expect(await count(ownerPool()`select count(*)::int as n from outbox where workspace_id = ${t.workspaceId} and payload->>'template' in ('cancellation_confirmed','plan_ended_payment_failed')`)).toBe(0);
  }, 30_000);

  it('a cancel the customer asked for is not confirmed a second time when the period ends; the period’s tests expire', async () => {
    const { t, ctx, subId, customer, periodKey } = await subscribed('LAUNCH');
    await withTenant(t.workspaceId, (tx) => setCancellation(tx, ctx(), true, null));
    await send('customer.subscription.deleted', { id: subId, customer, metadata: { workspace_id: t.workspaceId } });
    expect(await count(ownerPool()`select count(*)::int as n from outbox where workspace_id = ${t.workspaceId} and queue = 'send-email' and payload->>'template' = 'cancellation_confirmed'`)).toBe(0);
    const [w] = await ownerPool()`select state from workspaces where id = ${t.workspaceId}`;
    expect(w!.state).toBe('CANCELLED');
    const [x] = await ownerPool()`select amount from ledger_entries where workspace_id = ${t.workspaceId} and type = 'CREDIT_EXPIRED' and period_key = ${periodKey}`;
    expect(Number(x!.amount)).toBe(-3);
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(0);
  }, 30_000);

  it('a plan ended by failed payments gets its own notice, not "you cancelled"', async () => {
    const { t, subId, customer } = await subscribed('LAUNCH');
    await send('invoice.payment_failed', { id: 'in_fail', customer, subscription: subId, attempt_count: 4, next_payment_attempt: null });
    await send('customer.subscription.deleted', { id: subId, customer, metadata: { workspace_id: t.workspaceId }, cancellation_details: { reason: 'payment_failed' } });
    const mails = await ownerPool()`select payload->>'template' as t from outbox where workspace_id = ${t.workspaceId} and queue = 'send-email' and payload->>'template' in ('cancellation_confirmed','plan_ended_payment_failed')`;
    expect(mails.map((m) => m.t)).toEqual(['plan_ended_payment_failed']);
    const [w] = await ownerPool()`select state from workspaces where id = ${t.workspaceId}`;
    expect(w!.state).toBe('CANCELLED');
  }, 30_000);
});

describe('plan changes (plan 02 B6/B7)', () => {
  it('a downgrade switches the Stripe price now (no proration) but the plan and tests change only at renewal; "keep" withdraws it', async () => {
    const { t, ctx, subId, customer, periodKey } = await subscribed('GROWTH');
    const r = await withTenant(t.workspaceId, (tx) => changePlan(tx, ctx(), 'LAUNCH'));
    expect(r.effective).toBe('period_end');
    expect(gw.priceChanges.at(-1)).toMatchObject({ id: subId, prorate: false });
    const [w0] = await ownerPool()`select w.plan_code, s.plan_code as sub_plan, s.pending_plan_code from workspaces w join subscriptions s on s.workspace_id = w.id where w.id = ${t.workspaceId}`;
    expect(w0).toEqual({ plan_code: 'GROWTH', sub_plan: 'GROWTH', pending_plan_code: 'LAUNCH' });
    // "Keep Growth": the price goes back, nothing is pending.
    expect((await withTenant(t.workspaceId, (tx) => changePlan(tx, ctx(), 'GROWTH'))).effective).toBe('kept');
    expect(gw.priceChanges.at(-1)).toMatchObject({ id: subId, prorate: false });
    const [s1] = await ownerPool()`select pending_plan_code from subscriptions where workspace_id = ${t.workspaceId}`;
    expect(s1!.pending_plan_code).toBeNull();
    // Downgrade again; the renewal applies it.
    await withTenant(t.workspaceId, (tx) => changePlan(tx, ctx(), 'LAUNCH'));
    const next = Math.floor(new Date(`${periodKey}T00:00:00Z`).getTime() / 1000) + 31 * day;
    await send('invoice.paid', { id: 'in_cycle', customer, subscription: subId, billing_reason: 'subscription_cycle', amount_paid: 4900, lines: { data: [{ period: { start: next, end: next + 30 * day } }] } });
    const [w1] = await ownerPool()`select w.plan_code, s.plan_code as sub_plan, s.pending_plan_code from workspaces w join subscriptions s on s.workspace_id = w.id where w.id = ${t.workspaceId}`;
    expect(w1).toEqual({ plan_code: 'LAUNCH', sub_plan: 'LAUNCH', pending_plan_code: null });
    const nextKey = new Date(next * 1000).toISOString().slice(0, 10);
    await withTenant(t.workspaceId, async (tx) => {
      expect(await available(tx, 'creative_test')).toBe(3);
      expect((await periodUsage(tx, nextKey)).remaining).toBe(3);
      expect((await periodUsage(tx, periodKey)).remaining).toBe(0);
    });
  }, 30_000);

  it('two concurrent upgrades apply one after the other: the extra tests match the final plan, never double', async () => {
    const { t, ctx } = await subscribed('LAUNCH');
    const results = await Promise.allSettled([
      withTenant(t.workspaceId, (tx) => changePlan(tx, ctx(), 'GROWTH')),
      withTenant(t.workspaceId, (tx) => changePlan(tx, ctx(), 'SCALE')),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const [extra] = await ownerPool()`select coalesce(sum(amount), 0)::int as n from ledger_entries where workspace_id = ${t.workspaceId} and type = 'CREDIT_GRANTED' and idempotency_key like 'upgrade:%'`;
    // LAUNCH (3) → SCALE (16) in a period that has only just started: 13 extra tests however the two interleave.
    expect(extra!.n).toBe(13);
    const [s] = await ownerPool()`select plan_code from subscriptions where workspace_id = ${t.workspaceId}`;
    expect(s!.plan_code).toBe('SCALE');
  }, 30_000);

  it('a past-due plan offers no plan change', async () => {
    const { t, ctx, subId, customer } = await subscribed('GROWTH');
    await send('invoice.payment_failed', { id: 'in_fail', customer, subscription: subId, attempt_count: 1 });
    await expect(withTenant(t.workspaceId, (tx) => changePlan(tx, ctx('PAST_DUE'), 'SCALE'))).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 30_000);
});

describe('period expiry (x-races-08)', () => {
  it('expires the old period even when customer.subscription.updated moved the period before invoice.paid arrived', async () => {
    const { t, subId, customer, periodKey } = await subscribed('GROWTH');
    const next = Math.floor(new Date(`${periodKey}T00:00:00Z`).getTime() / 1000) + 31 * day;
    await send('customer.subscription.updated', {
      id: subId,
      customer,
      status: 'active',
      cancel_at_period_end: false,
      metadata: { workspace_id: t.workspaceId },
      items: { data: [{ price: { id: 'price_unconfigured' }, current_period_start: next, current_period_end: next + 30 * day }] },
    });
    await send('invoice.paid', { id: 'in_cycle', customer, subscription: subId, billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: next, end: next + 30 * day } }] } });
    const [x] = await ownerPool()`select amount from ledger_entries where workspace_id = ${t.workspaceId} and type = 'CREDIT_EXPIRED' and period_key = ${periodKey}`;
    expect(Number(x!.amount)).toBe(-7);
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(7);
    // A late delivery of the first period's invoice changes nothing.
    await send('invoice.paid', { id: 'in_first_late', customer, subscription: subId, billing_reason: 'subscription_create', lines: { data: [{ period: { start: next - 31 * day, end: next } }] } });
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(7);
  }, 30_000);

  it('a proration invoice (upgrade) opens no new period', async () => {
    const { t, subId, customer } = await subscribed('LAUNCH');
    const now = Math.floor(Date.now() / 1000);
    await send('invoice.paid', { id: 'in_prorate', customer, subscription: subId, billing_reason: 'subscription_update', lines: { data: [{ period: { start: now + 3600, end: now + 20 * day } }] } });
    expect(await count(ownerPool()`select count(*)::int as n from ledger_entries where workspace_id = ${t.workspaceId} and type in ('CREDIT_GRANTED','CREDIT_EXPIRED')`)).toBe(1);
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(3);
  }, 30_000);
});

describe('a workspace scheduled for deletion (plan 02 §2, §7)', () => {
  it('takes no new recurring charge, and its Stripe subscription ends before the purge', async () => {
    const { t, ctx, subId } = await subscribed('GROWTH');
    await withTenant(t.workspaceId, (tx) => setCancellation(tx, ctx(), true, null));
    const del = ctx('PURGE_SCHEDULED');
    await ownerPool()`update workspaces set state = 'PURGE_SCHEDULED', state_before_purge = 'ACTIVE_PAID', purge_at = now() + interval '5 days' where id = ${t.workspaceId}`;
    await expect(withTenant(t.workspaceId, (tx) => setCancellation(tx, del, false))).rejects.toThrow(/Cancel the deletion first/);
    await expect(withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, del, { userId: t.userId, plan: 'SCALE', agreed: true }))).rejects.toThrow(/Cancel the deletion first/);
    // Not due yet: nothing is cancelled.
    expect(await cancelSubscriptionsForPurge(t.workspaceId)).toEqual([]);
    await ownerPool()`update workspaces set purge_at = now() - interval '1 minute' where id = ${t.workspaceId}`;
    expect(await cancelSubscriptionsForPurge(t.workspaceId)).toEqual([subId]);
    expect(gw.canceled).toEqual([subId]);
    const [s] = await ownerPool()`select status from subscriptions where workspace_id = ${t.workspaceId}`;
    expect(s!.status).toBe('canceled');
  }, 30_000);
});

describe('subscriptions created in the Stripe dashboard (plan 02 B11)', () => {
  it('with matching workspace_id metadata it becomes the workspace’s plan; without it, it waits for staff', async () => {
    const t = await makeTenant();
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_staff', ${t.workspaceId})`;
    const now = Math.floor(Date.now() / 1000);
    const sub = (id: string, metadata: Record<string, string>) => ({ id, customer: 'cus_staff', status: 'active', cancel_at_period_end: false, metadata, items: { data: [{ price: { id: 'price_unconfigured' }, current_period_start: now, current_period_end: now + 30 * day }] } });
    // No metadata: unmatched (never guessed from the customer alone).
    const bare = await send('customer.subscription.created', sub('sub_bare', { plan: 'LAUNCH' }));
    expect(bare.outcome).toBe('unmatched');
    const ok = await send('customer.subscription.created', sub('sub_staff', { workspace_id: t.workspaceId, plan: 'GROWTH' }));
    expect(ok.outcome).toBe('processed');
    const [s] = await ownerPool()`select plan_code, status, source, consent_record_id from subscriptions where stripe_subscription_id = 'sub_staff'`;
    expect(s).toEqual({ plan_code: 'GROWTH', status: 'active', source: 'stripe', consent_record_id: null });
    const [w] = await ownerPool()`select state, plan_code from workspaces where id = ${t.workspaceId}`;
    expect(w).toEqual({ state: 'ACTIVE_PAID', plan_code: 'GROWTH' });
    await send('invoice.paid', { id: 'in_staff', customer: 'cus_staff', subscription: 'sub_staff', billing_reason: 'subscription_create', lines: { data: [{ period: { start: now, end: now + 30 * day } }] } });
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(7);
    // Metadata naming another workspace than the customer's mapping is never applied.
    const other = await makeTenant();
    expect((await send('customer.subscription.created', sub('sub_wrong', { workspace_id: other.workspaceId, plan: 'SCALE' }))).outcome).toBe('unmatched');
  }, 30_000);

  it('an event staff assign from the unmatched queue is processed for that workspace', async () => {
    const t = await makeTenant();
    const now = Math.floor(Date.now() / 1000);
    const ev = await send('customer.subscription.created', { id: 'sub_orphan', customer: 'cus_unmapped', status: 'active', cancel_at_period_end: false, metadata: { plan: 'LAUNCH' }, items: { data: [{ price: { id: 'price_unconfigured' }, current_period_start: now, current_period_end: now + 30 * day }] } });
    expect(ev.outcome).toBe('unmatched');
    // What the stripe.assign executor does (four-eyes): map the customer, point the event at the workspace, re-queue.
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_unmapped', ${t.workspaceId})`;
    await ownerPool()`update stripe_events set status = 'received', workspace_id = ${t.workspaceId} where id = ${ev.id}`;
    expect(await processStripeEvent(ev.id)).toBe('processed');
    const [s] = await ownerPool()`select plan_code from subscriptions where stripe_subscription_id = 'sub_orphan' and workspace_id = ${t.workspaceId}`;
    expect(s!.plan_code).toBe('LAUNCH');
  }, 30_000);
});

describe('chargebacks (plan 02 B8)', () => {
  it('a dispute names only the charge and payment: routed by the payment on file, or the charge’s customer, and locks the workspace', async () => {
    const a = await makeTenant({ state: 'ACTIVE_PAID' });
    await ownerPool()`insert into purchases (workspace_id, kind, amount_micros, stripe_checkout_session_id, stripe_payment_intent_id, status, created_by)
                      values (${a.workspaceId}, 'taste', 19000000, 'cs_disp', 'pi_x', 'paid', 'user:x')`;
    expect((await send('charge.dispute.created', { id: 'dp_1', charge: 'ch_x', payment_intent: 'pi_x', amount: 1900, reason: 'fraudulent' })).outcome).toBe('processed');
    const [wa] = await ownerPool()`select state, state_before_hold from workspaces where id = ${a.workspaceId}`;
    expect(wa).toMatchObject({ state: 'LOCKED', state_before_hold: 'ACTIVE_PAID' });

    const b = await makeTenant({ state: 'ACTIVE_PAID' });
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_b', ${b.workspaceId})`;
    gw.charges.push({ id: 'ch_y', customerId: 'cus_b', paymentIntentId: 'pi_unknown', amountCents: 9900, amountRefundedCents: 0, status: 'succeeded', disputed: true, created: 0 });
    expect((await send('charge.dispute.created', { id: 'dp_2', charge: 'ch_y', payment_intent: 'pi_unknown' })).outcome).toBe('processed');
    const [wb] = await ownerPool()`select state from workspaces where id = ${b.workspaceId}`;
    expect(wb!.state).toBe('LOCKED');
  }, 30_000);
});

describe('one-off payments (plan 02 B4/B9, M9)', () => {
  it('two paid sessions for one project processed at once: one grant, one automatic refund, and the refund webhook leaves the credit alone', async () => {
    const { t, ctx, projectId } = await storyboardReady();
    const co = await withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }));
    await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, stripe_checkout_session_id, created_by)
                      values (${t.workspaceId}, 'taste', ${projectId}, 19000000, 'cs_other_tab', 'user:x')`;
    const [w] = await ownerPool()`select stripe_customer_id from workspaces where id = ${t.workspaceId}`;
    const evt = (id: string, cs: string, pi: string) => ({ id, type: 'checkout.session.completed', data: { object: { id: cs, mode: 'payment', payment_status: 'paid', customer: w!.stripe_customer_id, metadata: { workspace_id: t.workspaceId }, payment_intent: pi } } });
    await receiveStripeWebhook(JSON.stringify(evt('evt_tab1', co.sessionId, 'pi_tab1')), null);
    await receiveStripeWebhook(JSON.stringify(evt('evt_tab2', 'cs_other_tab', 'pi_tab2')), null);
    await Promise.all([processStripeEvent('evt_tab1'), processStripeEvent('evt_tab2')]);
    expect(gw.refunds).toHaveLength(1);
    expect(await count(ownerPool()`select count(*)::int as n from ledger_entries where workspace_id = ${t.workspaceId} and type = 'CREDIT_GRANTED'`)).toBe(1);
    const refundedPi = gw.refunds[0]!.pi;
    const [dup] = await ownerPool()`select status from purchases where stripe_payment_intent_id = ${refundedPi}`;
    expect(dup!.status).toBe('refunded');
    // Stripe then reports the refund on the charge: already on file, the legitimate credit stays.
    await send('charge.refunded', { id: 'ch_dup', customer: w!.stripe_customer_id, payment_intent: refundedPi, amount_refunded: 1900, refunded: true });
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'taste'))).toBe(1);
    const [min] = await ownerPool()`select min(s)::int as m from (select sum(amount) over (order by id) as s from ledger_entries where workspace_id = ${t.workspaceId} and unit = 'taste' and type in ('CREDIT_GRANTED','CREDIT_RESERVED','CREDIT_RELEASED','CREDIT_REFUNDED','CREDIT_EXPIRED','CREDIT_ADJUSTED')) x`;
    expect(min!.m).toBeGreaterThanOrEqual(0);
  }, 90_000);

  it('a payment for a storyboard replaced while checkout was open produces the storyboard that was paid for', async () => {
    const { t, ctx, projectId, storyboardId, concepts } = await storyboardReady();
    const co = await withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }));
    const [pu] = await ownerPool()`select storyboard_id from purchases where stripe_checkout_session_id = ${co.sessionId}`;
    expect(pu!.storyboard_id).toBe(storyboardId);
    // Another tab picks a different concept: a new storyboard starts drawing.
    const next = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, concepts[1]!));
    expect(next.storyboardId).not.toBe(storyboardId);
    const [ev] = await Promise.all([completeMockCheckout(co.sessionId)]);
    const [e] = await ownerPool()`select status from stripe_events where id = ${ev[0]!}`;
    expect(e!.status).toBe('processed');
    const [p] = await ownerPool()`select state, storyboard_id from projects where id = ${projectId}`;
    expect(p).toEqual({ state: 'STORYBOARD_APPROVED', storyboard_id: storyboardId });
    const sbs = await ownerPool()`select id, status from storyboards where project_id = ${projectId} order by created_at`;
    expect(Object.fromEntries(sbs.map((s) => [s.id, s.status]))).toMatchObject({ [storyboardId]: 'approved', [next.storyboardId]: 'superseded' });
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'taste'))).toBe(1);
    // The replaced storyboard's generation finishing later doesn't take the project back.
    await generateStoryboard(ctx, projectId, next.storyboardId, concepts[1]!);
    const [p2] = await ownerPool()`select state, storyboard_id from projects where id = ${projectId}`;
    expect(p2).toEqual({ state: 'STORYBOARD_APPROVED', storyboard_id: storyboardId });
  }, 90_000);

  it('an out-of-stock product is flagged before the offer and checkout; stating a waitlist starts both (§42)', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    await analyzeProduct(ctx, skuId, projectId);
    await ownerPool()`update skus set in_stock = false where id = ${skuId}`;
    const concepts = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx`;
    const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, concepts[0]!.id as string));
    await generateStoryboard(ctx, projectId, storyboardId, concepts[0]!.id as string);
    // The storyboard is ready, but the intro window hasn't started and nothing can be bought.
    expect(await ownerPool()`select 1 from offers where workspace_id = ${t.workspaceId}`).toHaveLength(0);
    await expect(withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }))).rejects.toMatchObject({ code: 'CONFLICT', details: { outOfStock: true } });
    await withTenant(t.workspaceId, (tx) => setStockIntent(tx, ctx, skuId, 'waitlist'));
    const [offer] = await ownerPool()`select type, project_id, expires_at from offers where workspace_id = ${t.workspaceId}`;
    expect(offer).toMatchObject({ type: 'TASTE', project_id: projectId });
    const co = await withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }));
    expect(co.quote.kind).toBe('taste');
    // The funnel names the offer (and its experiment variant, none here) for per-variant readouts (plan 04 L22).
    const [f] = await ownerPool()`select props from funnel_events where workspace_id = ${t.workspaceId} and type = 'CHECKOUT_STARTED'`;
    expect(f!.props).toMatchObject({ kind: 'taste', offer: 'TASTE_19', offerVariant: null });
  }, 90_000);

  it('a refund booked as fraudulent flags the purchase (its downloads are refused)', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const [pu] = await ownerPool()`insert into purchases (workspace_id, kind, amount_micros, stripe_checkout_session_id, stripe_payment_intent_id, status, created_by)
                                   values (${t.workspaceId}, 'taste', 19000000, 'cs_f', 'pi_f', 'paid', 'user:x') returning id`;
    const [r] = await ownerPool()`insert into refunds (workspace_id, purchase_id, payment_intent_id, amount_micros, reason_code, idempotency_key)
                                  values (${t.workspaceId}, ${pu!.id}, 'pi_f', 19000000, 'fraudulent', 'k-f') returning id`;
    await withTenant(t.workspaceId, (tx) => applySucceededRefund(tx, { workspaceId: t.workspaceId, actor: { kind: 'system', id: 't' } }, r!.id as string, 're_f'));
    const [row] = await ownerPool()`select status, fraud_flagged_at from purchases where id = ${pu!.id}`;
    expect(row!.status).toBe('refunded');
    expect(row!.fraud_flagged_at).not.toBeNull();
  });
});
