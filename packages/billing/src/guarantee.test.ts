import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { append, authorize, available, failProduction, retryProduction } from '@arkiv/core';
import { ctxFor } from '@arkiv/core/testing';
import { newId } from '@arkiv/shared';
import { refundProjectPurchase } from './billing';
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

  it('does not refund an order the merchant already retried', async () => {
    const { t, ctx, projectId, purchaseId } = await failedPaidTaste();
    await withTenant(t.workspaceId, (tx) => failProduction(tx, ctx, projectId, 'provider down'));
    await withTenant(t.workspaceId, (tx) => retryProduction(tx, ctx, projectId));
    expect(await refundProjectPurchase(ctx, purchaseId)).toBe('skipped');
    expect(gw.refunds).toHaveLength(0);
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
