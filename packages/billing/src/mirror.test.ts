import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { ctxFor } from '@arkiv/core/testing';
import { applySubscriptionCoupon, processStripeEvent, receiveStripeWebhook, staffChangePlan } from './billing';
import { MockStripe, setBillingGateway } from './gateway';

let gw: MockStripe;
beforeEach(async () => {
  await truncateAll();
  gw = new MockStripe();
  setBillingGateway(gw);
});
afterAll(closeAll);

async function deliver(id: string, type: string, object: Record<string, unknown>, created: number) {
  await receiveStripeWebhook(JSON.stringify({ id, type, created, data: { object } }), null);
  return processStripeEvent(id);
}

async function subscribed(plan = 'LAUNCH') {
  const t = await makeTenant({ state: 'ACTIVE_PAID', plan });
  await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values (${'cus_' + t.workspaceId.slice(-12)}, ${t.workspaceId})`;
  const [s] = await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, current_period_start, current_period_end, consent_record_id)
                                values (${t.workspaceId}, ${'sub_' + t.workspaceId.slice(-12)}, ${plan}, 'active', now() - interval '10 days', now() + interval '20 days', gen_random_uuid()) returning id`;
  return { ...t, customer: 'cus_' + t.workspaceId.slice(-12), sub: 'sub_' + t.workspaceId.slice(-12), subRow: s!.id as string };
}

describe('Stripe mirror (plan 05 §2.2 Billing, §7)', () => {
  it('upserts invoices from every invoice event and never lets an older event roll a paid invoice back', async () => {
    const t = await subscribed();
    const base = { id: 'in_1', customer: t.customer, subscription: t.sub, billing_reason: 'subscription_cycle', currency: 'usd', amount_due: 14900, lines: { data: [{ period: { start: 1_790_000_000, end: 1_792_592_000 } }] } };
    expect(await deliver('evt_fin', 'invoice.finalized', { ...base, status: 'open', amount_paid: 0, amount_remaining: 14900, hosted_invoice_url: 'https://invoice.stripe.com/i/x' }, 1_790_000_100)).toBe('processed');
    await deliver('evt_paid', 'invoice.paid', { ...base, status: 'paid', amount_paid: 14900, amount_remaining: 0, payment_intent: 'pi_inv_1' }, 1_790_000_200);
    // A late, older "updated" event arrives after the payment.
    await deliver('evt_late', 'invoice.updated', { ...base, status: 'open', amount_paid: 0, amount_remaining: 14900 }, 1_790_000_150);
    const [inv] = await ownerPool()`select workspace_id, status, amount_paid_cents, amount_remaining_cents, payment_intent_id, hosted_invoice_url, last_event_id, period_start from stripe_invoices where id = 'in_1'`;
    expect(inv).toMatchObject({ workspace_id: t.workspaceId, status: 'paid', amount_paid_cents: 14900, amount_remaining_cents: 0, payment_intent_id: 'pi_inv_1', hosted_invoice_url: 'https://invoice.stripe.com/i/x', last_event_id: 'evt_paid' });
    expect(new Date(inv!.period_start as string).getTime()).toBe(1_790_000_000_000);
    await deliver('evt_void', 'invoice.voided', { id: 'in_2', customer: t.customer, subscription: t.sub, amount_due: 14900 }, 1_790_000_300);
    const [v] = await ownerPool()`select status from stripe_invoices where id = 'in_2'`;
    expect(v!.status).toBe('void');
    // The tenant reads only its own mirror.
    const other = await makeTenant();
    expect(await withTenant(other.workspaceId, (tx) => tx`select 1 from stripe_invoices`)).toHaveLength(0);
    expect(await withTenant(t.workspaceId, (tx) => tx`select id from stripe_invoices order by id`)).toHaveLength(2);
  });

  it('routes disputes (which carry no customer) by the recorded payment, mirrors their state and locks the workspace', async () => {
    const t = await subscribed();
    await ownerPool()`insert into purchases (workspace_id, kind, amount_micros, stripe_checkout_session_id, stripe_payment_intent_id, status, created_by, paid_at)
                      values (${t.workspaceId}, 'taste', 19000000, 'cs_d', 'pi_disputed', 'paid', 'user:x', now())`;
    const dispute = { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_disputed', amount: 1900, currency: 'usd', reason: 'fraudulent', created: 1_790_000_000, evidence_details: { due_by: 1_790_900_000 } };
    expect(await deliver('evt_dp1', 'charge.dispute.created', { ...dispute, status: 'needs_response' }, 1_790_000_010)).toBe('processed');
    const [w] = await ownerPool()`select state from workspaces where id = ${t.workspaceId}`;
    expect(w!.state).toBe('LOCKED');
    await deliver('evt_dp2', 'charge.dispute.closed', { ...dispute, status: 'won' }, 1_790_000_020);
    const [d] = await ownerPool()`select workspace_id, status, reason, amount_cents, payment_intent_id, evidence_due_by from stripe_disputes where id = 'dp_1'`;
    expect(d).toMatchObject({ workspace_id: t.workspaceId, status: 'won', reason: 'fraudulent', amount_cents: 1900, payment_intent_id: 'pi_disputed' });
    const [after] = await ownerPool()`select state from workspaces where id = ${t.workspaceId}`;
    expect(after!.state).toBe('ACTIVE_PAID'); // dispute won lifts the lock
    // A payment nobody recorded stays in the unmatched queue.
    expect(await deliver('evt_dp3', 'charge.dispute.created', { id: 'dp_2', payment_intent: 'pi_unknown', amount: 100, status: 'needs_response' }, 1_790_000_030)).toBe('unmatched');
  });
});

describe('staff billing actions (plan 05 §2.2 Billing)', () => {
  it('applies a coupon to the tenant’s own subscription only', async () => {
    const a = await subscribed();
    const b = await subscribed();
    const ctx = { ...ctxFor(a.workspaceId, a.userId, 'OWNER', 'ACTIVE_PAID'), actor: { kind: 'staff' as const, id: 'staff-1' } };
    await withAdmin((tx) => applySubscriptionCoupon(tx, ctx, 'SORRY_20'));
    expect(gw.coupons).toEqual([{ id: a.sub, coupon: 'SORRY_20' }]);
    const rows = await ownerPool()`select workspace_id, coupon from subscriptions order by coupon nulls last`;
    expect(rows).toEqual([{ workspace_id: a.workspaceId, coupon: 'SORRY_20' }, { workspace_id: b.workspaceId, coupon: null }]);
    const [ev] = await ownerPool()`select actor, payload from events where workspace_id = ${a.workspaceId} and type = 'SUBSCRIPTION_CHANGED'`;
    expect(ev).toEqual({ actor: 'staff:staff-1', payload: { coupon: 'SORRY_20', previousCoupon: null } });
    await expect(withAdmin((tx) => applySubscriptionCoupon(tx, ctx, 'bad coupon!'))).rejects.toThrow(/letters, digits/);
    const none = await makeTenant();
    await expect(withAdmin((tx) => applySubscriptionCoupon(tx, { ...ctx, workspaceId: none.workspaceId }, 'X1'))).rejects.toThrow(/No active subscription/);
  });

  it('changes plan with a consent record naming where the customer agreed, and never touches another tenant', async () => {
    const a = await subscribed('LAUNCH');
    const b = await subscribed('LAUNCH');
    const ctx = { ...ctxFor(a.workspaceId, a.userId, 'OWNER', 'ACTIVE_PAID'), actor: { kind: 'staff' as const, id: 'staff-1' } };
    await expect(withAdmin((tx) => staffChangePlan(tx, ctx, 'GROWTH', { reference: '', staffId: 'staff-1' }))).rejects.toThrow(/Reference/);
    const r = await withAdmin((tx) => staffChangePlan(tx, ctx, 'GROWTH', { reference: 'Ticket #401 (email 12 Sep)', staffId: 'staff-1' }));
    expect(r.effective).toBe('now');
    expect(gw.priceChanges.map((p) => p.id)).toEqual([a.sub]);
    const [sa] = await ownerPool()`select plan_code from subscriptions where workspace_id = ${a.workspaceId}`;
    const [sb] = await ownerPool()`select plan_code from subscriptions where workspace_id = ${b.workspaceId}`;
    expect([sa!.plan_code, sb!.plan_code]).toEqual(['GROWTH', 'LAUNCH']);
    const [c] = await ownerPool()`select kind, text_snapshot, context from consent_records where id = ${r.consentRecordId}`;
    expect(c).toMatchObject({ kind: 'auto_renew', context: { plan: 'GROWTH', from: 'LAUNCH', via: 'staff', reference: 'Ticket #401 (email 12 Sep)' } });
    expect(c!.text_snapshot).toMatch(/every month/);
    await expect(withAdmin((tx) => staffChangePlan(tx, ctx, 'GROWTH', { reference: 'Ticket #402', staffId: 'staff-1' }))).rejects.toThrow(/Already on/);
  });
});
