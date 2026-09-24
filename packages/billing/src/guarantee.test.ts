import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { append, authorize, available, cancelDecision, cancelProduction, failProduction, retryProduction, stopForRefund } from '@arkiv/core';
import { ctxFor } from '@arkiv/core/testing';
import { newId } from '@arkiv/shared';
import { processStripeEvent, receiveStripeWebhook, refundProjectPurchase } from './billing';
import { MockStripe, setBillingGateway } from './gateway';

/** Plan 04 L12 / plan 03 P7: "If we can't deliver an ad that passes our quality checks, you're refunded automatically." */
let gw: MockStripe;
beforeEach(async () => {
  await truncateAll();
  gw = new MockStripe();
  setBillingGateway(gw);
});
afterAll(closeAll);

async function failedPaidTaste() {
  const t = await makeTenant({ state: 'ACTIVE_FREE' });
  const ctx = ctxFor(t.workspaceId, t.userId);
  const skuId = await makeSku(t.workspaceId);
  const projectId = newId();
  await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit)
                    values (${projectId}, ${t.workspaceId}, ${skuId}, 'taste', 'RENDERING', 'test', 'taste')`;
  // As checkout completion leaves it: the purchase's session is the reference of the credit it granted.
  const [pu] = await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, stripe_checkout_session_id, stripe_payment_intent_id, status, created_by, paid_at)
                                 values (${t.workspaceId}, 'taste', ${projectId}, 19000000, 'cs_guarantee', 'pi_guarantee', 'paid', 'test', now()) returning id`;
  await withTenant(t.workspaceId, async (tx) => {
    await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, projectId, reference: 'cs_guarantee', idempotencyKey: 'pay:guarantee' });
    const a = await authorize(tx, ctx, { purpose: 'taste', projectId, lines: [{ kind: 'media', outputs: 1 }], entitlement: { unit: 'taste', amount: 1 }, idempotencyKey: `produce:${projectId}` });
    await tx`update projects set authorization_id = ${a.authorizationId} where id = ${projectId}`;
  });
  return { t, ctx, projectId, purchaseId: pu!.id as string };
}

describe('quality guarantee refund', () => {
  it('failing the production queues the refund; the refund returns the money once and never also the credit', async () => {
    const { t, ctx, projectId, purchaseId } = await failedPaidTaste();
    await withTenant(t.workspaceId, (tx) => failProduction(tx, ctx, projectId, 'Final QA failed: audio missing'));
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state, failure_reason from projects where id = ${projectId}`;
      expect(p!.state).toBe('PROVIDER_FAILED');
      expect(p!.failure_reason).not.toMatch(/audio/); // the internal cause stays internal (it is on the event)
      expect(await available(tx, 'taste')).toBe(1); // entitlement returned by the failure…
      const [job] = await tx`select payload from outbox where queue = 'refund-purchase'`;
      expect(job!.payload).toMatchObject({ projectId, purchaseId });
    });

    expect(await refundProjectPurchase(ctx, purchaseId)).toBe('refunded');
    expect(gw.refunds).toEqual([{ pi: 'pi_guarantee', amount: undefined, id: expect.any(String), idempotencyKey: `guarantee:${purchaseId}` }]);
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state from projects where id = ${projectId}`;
      expect(p!.state).toBe('REFUNDED');
      const [pu] = await tx`select status, refunded_at from purchases where id = ${purchaseId}`;
      expect(pu!.status).toBe('refunded');
      // Booked like every other refund: a succeeded mirror row for the full amount.
      const [mirror] = await tx`select status, amount_micros, reason_code from refunds where purchase_id = ${purchaseId}`;
      expect(mirror).toMatchObject({ status: 'succeeded', reason_code: 'service_failure' });
      expect(Number(mirror!.amount_micros)).toBe(19_000_000);
      expect(await available(tx, 'taste')).toBe(0); // …and taken back out: the money went back instead
      expect(await tx`select 1 from events where type = 'CREDIT_REFUNDED' and payload->>'purchaseId' = ${purchaseId}`).toHaveLength(1);
      expect(await tx`select 1 from outbox where queue = 'send-email' and payload->>'template' = 'refund_issued'`).toHaveLength(1);
    });
    // A redelivered job changes nothing.
    expect(await refundProjectPurchase(ctx, purchaseId)).toBe('skipped');
    expect(gw.refunds).toHaveLength(1);
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'taste'))).toBe(0);
  });

  it('Stripe’s charge.refunded webhook for the guarantee refund changes nothing (it is already on file)', async () => {
    const { t, ctx, projectId, purchaseId } = await failedPaidTaste();
    await withTenant(t.workspaceId, (tx) => failProduction(tx, ctx, projectId, 'Final QA failed'));
    expect(await refundProjectPurchase(ctx, purchaseId)).toBe('refunded');
    const customer = `cus_${t.workspaceId.slice(-8)}`;
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values (${customer}, ${t.workspaceId})`;
    const hook = JSON.stringify({ id: 'evt_guarantee', type: 'charge.refunded', data: { object: { id: 'ch_guarantee', payment_intent: 'pi_guarantee', customer, amount_refunded: 1900, refunded: true, metadata: {} } } });
    await receiveStripeWebhook(hook, null);
    expect(await processStripeEvent('evt_guarantee')).toBe('processed');
    await withTenant(t.workspaceId, async (tx) => {
      expect(await tx`select 1 from refunds where purchase_id = ${purchaseId}`).toHaveLength(1);
      const [pu] = await tx`select refunded_micros from purchases where id = ${purchaseId}`;
      expect(Number(pu!.refunded_micros)).toBe(19_000_000);
      expect(await available(tx, 'taste')).toBe(0); // the credit is withdrawn once, not twice
    });
  });

  it('does not refund an order the merchant already retried', async () => {
    const { t, ctx, projectId, purchaseId } = await failedPaidTaste();
    await withTenant(t.workspaceId, (tx) => failProduction(tx, ctx, projectId, 'provider down'));
    await withTenant(t.workspaceId, (tx) => retryProduction(tx, ctx, projectId));
    expect(await refundProjectPurchase(ctx, purchaseId)).toBe('skipped');
    expect(gw.refunds).toHaveLength(0);
  });

  it('cancelling before dispatch refunds a paid one-off in full and takes the credit back (arch-11)', async () => {
    const { t, ctx, projectId, purchaseId } = await failedPaidTaste();
    const preview = await withTenant(t.workspaceId, (tx) => cancelDecision(tx, t.workspaceId, projectId));
    expect(preview).toMatchObject({ allowed: true, outcome: 'release', refund: true, dispatched: false });
    const r = await withTenant(t.workspaceId, (tx) => cancelProduction(tx, ctx, projectId, { reason: 'changed my mind' }));
    expect(r.status).toBe('refunded');
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state, cancel_request from projects where id = ${projectId}`;
      expect(p!.state).toBe('REFUNDED');
      expect(p!.cancel_request).toMatchObject({ by: `user:${t.userId}`, reason: 'changed my mind' });
      expect((await tx`select status from cost_authorizations where project_id = ${projectId}`).map((a) => a.status)).toEqual(['released']);
      const [job] = await tx`select payload from outbox where queue = 'refund-purchase'`;
      expect(job!.payload).toMatchObject({ projectId, purchaseId, reason: 'cancelled' });
    });
    expect(await refundProjectPurchase(ctx, purchaseId, 'cancelled')).toBe('refunded');
    await withTenant(t.workspaceId, async (tx) => {
      const [mirror] = await tx`select reason_code from refunds where purchase_id = ${purchaseId}`;
      expect(mirror!.reason_code).toBe('requested_by_customer');
      expect(await available(tx, 'taste')).toBe(0); // money back, credit withdrawn: never both
    });
    await expect(withTenant(t.workspaceId, (tx) => cancelProduction(tx, ctx, projectId))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('cancelling after most of the budget was spent uses the credit and promises no refund (§46)', async () => {
    const { t, ctx, projectId } = await failedPaidTaste();
    const [a] = await ownerPool()`select id, estimate->>'totalMicros' as total from cost_authorizations where project_id = ${projectId}`;
    await ownerPool()`insert into provider_jobs (workspace_id, project_id, provider, task, model, request_hash, status, authorization_id, estimate_micros, actual_micros)
                      values (${t.workspaceId}, ${projectId}, 'byteplus', 'video.scene', 'm', 'h', 'succeeded', ${a!.id}, ${Number(a!.total)}, ${Number(a!.total)})`;
    const preview = await withTenant(t.workspaceId, (tx) => cancelDecision(tx, t.workspaceId, projectId));
    expect(preview).toMatchObject({ allowed: true, outcome: 'consume', refund: false, dispatched: true });
    expect(preview.message).toMatch(/nothing is refunded/);
    expect((await withTenant(t.workspaceId, (tx) => cancelProduction(tx, ctx, projectId))).status).toBe('cancelled');
    await withTenant(t.workspaceId, async (tx) => {
      expect((await tx`select state from projects where id = ${projectId}`)[0]!.state).toBe('CANCELLED');
      expect((await tx`select status from cost_authorizations where project_id = ${projectId}`)[0]!.status).toBe('settled');
      expect(await tx`select 1 from outbox where queue = 'refund-purchase'`).toHaveLength(0);
      expect(await available(tx, 'taste')).toBe(0);
    });
  });

  it('a refund that lands while the ad is in production stops it and withdraws the credit once (arch-11)', async () => {
    const { t, projectId, purchaseId } = await failedPaidTaste();
    const customer = `cus_${t.workspaceId.slice(-8)}`;
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values (${customer}, ${t.workspaceId})`;
    // A run is producing right now: the stop is recorded and taken at its next checkpoint.
    await ownerPool()`insert into workspace_leases (workspace_id, resource, holder, expires_at) values (${t.workspaceId}, ${'produce:' + projectId}, 'run-1', now() + interval '5 minutes')`;
    const hook = JSON.stringify({ id: 'evt_refund_live', type: 'charge.refunded', data: { object: { id: 'ch_live', payment_intent: 'pi_guarantee', customer, amount_refunded: 1900, refunded: true, metadata: {} } } });
    await receiveStripeWebhook(hook, null);
    expect(await processStripeEvent('evt_refund_live')).toBe('processed');
    const [live] = await ownerPool()`select state, cancel_requested_at, cancel_request from projects where id = ${projectId}`;
    expect(live).toMatchObject({ state: 'RENDERING', cancel_request: { by: 'refund', purchaseId } });
    expect(live!.cancel_requested_at).toBeTruthy();
    // The run is gone (crashed or stopped); the next delivery settles the stop.
    await ownerPool()`delete from workspace_leases where resource = ${'produce:' + projectId}`;
    await withTenant(t.workspaceId, (tx) => stopForRefund(tx, ctxFor(t.workspaceId, t.userId), projectId, purchaseId));
    await withTenant(t.workspaceId, async (tx) => {
      expect((await tx`select state from projects where id = ${projectId}`)[0]!.state).toBe('REFUNDED');
      expect((await tx`select status from cost_authorizations where project_id = ${projectId}`)[0]!.status).toBe('released');
      expect(await available(tx, 'taste')).toBe(0); // not -1 (debited twice) and not 1 (money and credit)
      const withdrawn = await tx`select amount from ledger_entries where project_id = ${projectId} and type = 'CREDIT_REFUNDED' and amount < 0`;
      expect(withdrawn).toHaveLength(1);
    });
  });

  it('subscription creative tests are never money-refunded (the credit comes back instead)', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const skuId = await makeSku(t.workspaceId);
    const projectId = newId();
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit)
                      values (${projectId}, ${t.workspaceId}, ${skuId}, 'creative_test', 'RENDERING', 'test', 'creative_test')`;
    await withTenant(t.workspaceId, (tx) => failProduction(tx, ctx, projectId, 'provider down'));
    expect(await ownerPool()`select 1 from outbox where queue = 'refund-purchase'`).toHaveLength(0);
  });
});
