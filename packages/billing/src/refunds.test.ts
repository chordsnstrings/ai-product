import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { available, decideApproval, registerExecutor, requestOrExecute, type Staff } from '@arkiv/core';
import { newId, type StaffRole } from '@arkiv/shared';
import { processStripeEvent, receiveStripeWebhook } from './billing';
import { MockStripe, setBillingGateway } from './gateway';
import { refundPayment } from './refunds';

let gw: MockStripe;
beforeEach(async () => {
  await truncateAll();
  gw = new MockStripe();
  setBillingGateway(gw);
});
afterAll(closeAll);

async function staff(roles: StaffRole[], name = roles.join('+')): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, ${name}, 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name, roles };
}

/** A paid $19 Taste purchase whose credit was granted by the checkout webhook. */
async function paidTaste() {
  const t = await makeTenant({ state: 'ACTIVE_PAID' });
  await ownerPool()`update workspaces set stripe_customer_id = ${'cus_' + t.workspaceId.slice(-8)} where id = ${t.workspaceId}`;
  await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values (${'cus_' + t.workspaceId.slice(-8)}, ${t.workspaceId})`;
  const sku = await makeSku(t.workspaceId);
  const projectId = newId();
  const purchaseId = newId();
  const pi = `pi_${purchaseId.slice(-10)}`;
  await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by) values (${projectId}, ${t.workspaceId}, ${sku}, 'taste', 'STORYBOARD_APPROVED', 'test')`;
  await ownerPool()`insert into purchases (id, workspace_id, kind, project_id, amount_micros, stripe_checkout_session_id, stripe_payment_intent_id, status, created_by, paid_at)
                    values (${purchaseId}, ${t.workspaceId}, 'taste', ${projectId}, 19000000, ${'cs_' + purchaseId.slice(-10)}, ${pi}, 'paid', 'user:x', now())`;
  await ownerPool()`insert into ledger_entries (workspace_id, type, unit, amount, project_id, reference, actor, idempotency_key)
                    values (${t.workspaceId}, 'CREDIT_GRANTED', 'taste', 1, ${projectId}, ${'cs_' + purchaseId.slice(-10)}, 'system:stripe', ${'pay:cs_' + purchaseId.slice(-10)})`;
  return { t, projectId, purchaseId, pi, customer: 'cus_' + t.workspaceId.slice(-8) };
}

const refunds = (ws: string) => ownerPool()`select amount_micros, status, reason_code, customer_note, stripe_refund_id from refunds where workspace_id = ${ws} order by created_at`;
const ledger = (ws: string) => ownerPool()`select unit, amount from ledger_entries where workspace_id = ${ws} and type = 'CREDIT_REFUNDED' order by id`;

describe('refund tool (plan 05 §7)', () => {
  it('refunds partially then fully, idempotently, with CREDIT_REFUNDED and the customer note', async () => {
    const { t, purchaseId } = await paidTaste();
    const fin = await staff(['FINANCE']);
    const who = { requester: fin, approver: fin };
    const base = { workspaceId: t.workspaceId, purchaseId, reasonCode: 'goodwill' as const, reason: 'late delivery' };
    const first = await refundPayment({ ...base, amountMicros: 5_000_000, customerNote: 'Sorry about the wait on your ad.', nonce: 'n1' }, who);
    expect(first).toMatchObject({ amountMicros: 5_000_000, creditWithdrawn: false });
    // A replay of the same request (retry, double click, re-run approval) never refunds twice.
    expect(await refundPayment({ ...base, amountMicros: 5_000_000, nonce: 'n1' }, who)).toMatchObject({ replayed: true });
    expect(gw.refunds).toHaveLength(1);
    expect(gw.refunds[0]).toMatchObject({ amount: 500, idempotencyKey: `refund:${purchaseId}:n1` });
    let [pu] = await ownerPool()`select status, refunded_micros from purchases where id = ${purchaseId}`;
    expect(pu).toMatchObject({ status: 'paid', refunded_micros: 5000000 });
    expect(await ledger(t.workspaceId)).toEqual([{ unit: 'taste', amount: 0 }]);
    const [mail] = await ownerPool()`select template from email_log where workspace_id = ${t.workspaceId}`;
    expect(mail!.template).toBe('refund_issued');

    await expect(refundPayment({ ...base, amountMicros: 15_000_000, nonce: 'n2' }, who)).rejects.toThrow(/\$14\.00/);
    const full = await refundPayment({ ...base, amountMicros: 14_000_000, reasonCode: 'requested_by_customer', nonce: 'n3' }, who);
    expect(full.creditWithdrawn).toBe(true); // never used → withdrawn
    [pu] = await ownerPool()`select status, refunded_micros from purchases where id = ${purchaseId}`;
    expect(pu).toMatchObject({ status: 'refunded', refunded_micros: 19000000 });
    expect(await ledger(t.workspaceId)).toEqual([{ unit: 'taste', amount: 0 }, { unit: 'taste', amount: -1 }]);
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'taste'))).toBe(0);
    expect((await refunds(t.workspaceId)).map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('keeps delivered work: a used credit is not withdrawn', async () => {
    const { t, purchaseId, projectId } = await paidTaste();
    await ownerPool()`insert into ledger_entries (workspace_id, type, unit, amount, project_id, actor, idempotency_key) values (${t.workspaceId}, 'CREDIT_CONSUMED', 'taste', 1, ${projectId}, 'system:x', 'settle:x')`;
    const fin = await staff(['FINANCE']);
    const r = await refundPayment({ workspaceId: t.workspaceId, purchaseId, amountMicros: 19_000_000, reasonCode: 'service_failure', nonce: 'n', reason: 'quality' }, { requester: fin, approver: fin });
    expect(r.creditWithdrawn).toBe(false);
    expect(await ledger(t.workspaceId)).toEqual([{ unit: 'taste', amount: 0 }]);
  });

  it('the charge.refunded webhook does not double-count a console refund but records dashboard refunds', async () => {
    const a = await paidTaste();
    const fin = await staff(['FINANCE']);
    await refundPayment({ workspaceId: a.t.workspaceId, purchaseId: a.purchaseId, amountMicros: 19_000_000, reasonCode: 'duplicate', nonce: 'x', reason: 'dup' }, { requester: fin, approver: fin });
    const hook = (id: string, pi: string, customer: string, cents: number) => JSON.stringify({ id, type: 'charge.refunded', data: { object: { id: `ch_${id}`, payment_intent: pi, customer, amount_refunded: cents, refunded: true, metadata: {} } } });
    await receiveStripeWebhook(hook('evt_a', a.pi, a.customer, 1900), null);
    expect(await processStripeEvent('evt_a')).toBe('processed');
    expect(await refunds(a.t.workspaceId)).toHaveLength(1);
    expect(await ledger(a.t.workspaceId)).toHaveLength(1);

    const b = await paidTaste();
    await receiveStripeWebhook(hook('evt_b', b.pi, b.customer, 1000), null); // $10 refunded in the Stripe dashboard
    await processStripeEvent('evt_b');
    await receiveStripeWebhook(hook('evt_b2', b.pi, b.customer, 1900), null); // then the rest
    await processStripeEvent('evt_b2');
    const rows = await refunds(b.t.workspaceId);
    expect(rows.map((r) => [Number(r.amount_micros), r.reason_code])).toEqual([[10_000_000, 'other'], [9_000_000, 'other']]);
    expect(await ledger(b.t.workspaceId)).toEqual([{ unit: 'taste', amount: 0 }, { unit: 'taste', amount: -1 }]);
    const [pu] = await ownerPool()`select status from purchases where id = ${b.purchaseId}`;
    expect(pu!.status).toBe('refunded');
  });

  it('refunds a subscription payment and records a failed Stripe call without side effects', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    await ownerPool()`insert into stripe_events (id, type, payload, workspace_id, status) values ('evt_inv', 'invoice.paid', ${ownerPool().json({ data: { object: { id: 'in_1', amount_paid: 9900, payment_intent: 'pi_inv' } } })}, ${t.workspaceId}, 'processed')`;
    const fin = await staff(['FINANCE']);
    const who = { requester: fin, approver: fin };
    const r = await refundPayment({ workspaceId: t.workspaceId, invoiceEventId: 'evt_inv', amountMicros: 99_000_000, reasonCode: 'requested_by_customer', nonce: 'i1', reason: 'cancelled on day 1' }, who);
    expect(r.amountMicros).toBe(99_000_000);
    expect(await ledger(t.workspaceId)).toEqual([{ unit: 'creative_test', amount: 0 }]);
    await expect(refundPayment({ workspaceId: t.workspaceId, invoiceEventId: 'evt_inv', amountMicros: 1_000_000, reasonCode: 'other', nonce: 'i2', reason: 'again' }, who)).rejects.toThrow(/\$0\.00/);

    const p = await paidTaste();
    gw.refund = async () => {
      throw new Error('card_declined_for_refund');
    };
    await expect(refundPayment({ workspaceId: p.t.workspaceId, purchaseId: p.purchaseId, amountMicros: 1_000_000, reasonCode: 'other', nonce: 'f', reason: 'x' }, who)).rejects.toThrow(/card_declined/);
    expect((await refunds(p.t.workspaceId)).map((x) => x.status)).toEqual(['failed']);
    expect(await ledger(p.t.workspaceId)).toEqual([]);
    await expect(refundPayment({ workspaceId: p.t.workspaceId, purchaseId: p.purchaseId, amountMicros: 1_000_000, reasonCode: 'other', nonce: 'f', reason: 'x' }, who)).rejects.toThrow(/already failed/);
  });

  it('refunds over $200 wait for a second FINANCE approver', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'SCALE' });
    await ownerPool()`insert into stripe_events (id, type, payload, workspace_id, status) values ('evt_big', 'invoice.paid', ${ownerPool().json({ data: { object: { id: 'in_2', amount_paid: 39800, payment_intent: 'pi_big' } } })}, ${t.workspaceId}, 'processed')`;
    registerExecutor('billing.refund', (p, who) => refundPayment(p as never, who));
    const a = await staff(['FINANCE'], 'Fin A');
    const b = await staff(['FINANCE'], 'Fin B');
    const req = await requestOrExecute(a, 'billing.refund', { workspaceId: t.workspaceId, invoiceEventId: 'evt_big', amountMicros: 398_000_000, reasonCode: 'service_failure', customerNote: null, nonce: 'big' }, 'two months of outages');
    expect(req.status).toBe('pending');
    expect(gw.refunds).toHaveLength(0);
    await decideApproval(b, (req as { approvalId: string }).approvalId, true);
    expect(gw.refunds).toHaveLength(1);
    const [row] = await ownerPool()`select requested_by, approved_by from refunds where workspace_id = ${t.workspaceId}`;
    expect(row).toMatchObject({ requested_by: a.staffId, approved_by: b.staffId });
  });
});
