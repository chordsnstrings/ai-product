import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, available, generateStoryboard, ingestBytes, selectConcept, startPreview } from '@arkiv/core';
import { ctxFor, productPhoto } from '@arkiv/core/testing';
import {
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

let gw: MockStripe;
beforeEach(async () => {
  await truncateAll();
  gw = new MockStripe();
  setBillingGateway(gw);
});
afterAll(closeAll);

async function storyboardReady() {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
  await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
  return { t, ctx, projectId };
}

describe('Taste checkout (P7/P8, plan 02 B1–B5)', () => {
  it('charges the live $19 intro price, grants one Taste only from the webhook, and queues production', async () => {
    const { t, ctx, projectId } = await storyboardReady();
    const co = await withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }));
    expect(co.quote.priceMicros).toBe(19_000_000);
    expect(gw.sessions.get(co.sessionId)!.mode).toBe('payment'); // never a subscription
    expect(gw.sessions.get(co.sessionId)!.amountCents).toBe(1900);
    // Nothing granted until the webhook arrives.
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'taste'))).toBe(0);
    await completeMockCheckout(co.sessionId);
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state from projects where id = ${projectId}`;
      expect(p!.state).toBe('STORYBOARD_APPROVED');
      const [pu] = await tx`select status from purchases where project_id = ${projectId}`;
      expect(pu!.status).toBe('paid');
      const jobs = await tx`select queue from outbox where queue in ('produce-project','send-email')`;
      expect(jobs.map((j) => j.queue).sort()).toEqual(['produce-project', 'send-email']);
      const [o] = await tx`select status from offers`;
      expect(o!.status).toBe('redeemed');
      const [w] = await tx`select state from workspaces`;
      expect(w!.state).toBe('ACTIVE_PAID');
    });
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'taste'))).toBe(1);
  }, 60_000);

  it('ignores duplicate webhooks and parks unknown customers in the unmatched queue', async () => {
    const e = { id: 'evt_dup', type: 'checkout.session.completed', data: { object: { id: 'cs_x', mode: 'payment', customer: 'cus_unknown', metadata: {} } } };
    const a = await receiveStripeWebhook(JSON.stringify(e), null);
    const b = await receiveStripeWebhook(JSON.stringify(e), null);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(await processStripeEvent('evt_dup')).toBe('unmatched');
  });

  it('re-uses the same checkout for a second tab (idempotent) and refunds a duplicate payment', async () => {
    const { t, ctx, projectId } = await storyboardReady();
    const a = await withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }));
    const b = await withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }));
    expect(b.sessionId).toBe(a.sessionId);
    // Force a genuinely separate second payment (e.g. a session created before a price change).
    await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, stripe_checkout_session_id, created_by)
                      values (${t.workspaceId}, 'taste', ${projectId}, 19000000, 'cs_second', 'user:x')`;
    await completeMockCheckout(a.sessionId);
    const second = { id: 'evt_second', type: 'checkout.session.completed', data: { object: { id: 'cs_second', mode: 'payment', payment_status: 'paid', customer: (await ownerPool()`select stripe_customer_id from workspaces where id = ${t.workspaceId}`)[0]!.stripe_customer_id, metadata: { workspace_id: t.workspaceId }, payment_intent: 'pi_second' } } };
    await receiveStripeWebhook(JSON.stringify(second), null);
    await processStripeEvent('evt_second');
    expect(gw.refunds.map((r) => r.pi)).toContain('pi_second');
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'taste'))).toBe(1);
  }, 60_000);
});

describe('subscriptions (P11, plan 04 §3)', () => {
  it('requires explicit auto-renew consent, grants the period tests, supports upgrade + cancel', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    await expect(withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, ctx, { userId: t.userId, plan: 'GROWTH', agreed: false }))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(withTenant(t.workspaceId, (tx) => startSubscriptionCheckout(tx, ctx, 'GROWTH', '00000000-0000-0000-0000-000000000000', { id: t.userId, email: t.email }))).rejects.toMatchObject({ code: 'INVALID' });
    const consentId = await withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, ctx, { userId: t.userId, plan: 'GROWTH', agreed: true, ip: '1.1.1.1' }));
    const [consent] = await ownerPool()`select text_snapshot from consent_records where id = ${consentId}`;
    expect(consent!.text_snapshot).toMatch(/\$99 charged today and every month/);
    const co = await withTenant(t.workspaceId, (tx) => startSubscriptionCheckout(tx, ctx, 'GROWTH', consentId, { id: t.userId, email: t.email }));
    await completeMockCheckout(co.sessionId);
    const paid = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await withTenant(t.workspaceId, async (tx) => {
      expect(await available(tx, 'creative_test')).toBe(7);
      const [w] = await tx`select state, plan_code from workspaces`;
      expect(w).toMatchObject({ state: 'ACTIVE_PAID', plan_code: 'GROWTH' });
      const [s] = await tx`select consent_record_id from subscriptions`;
      expect(s!.consent_record_id).toBe(consentId);
    });
    const up = await withTenant(t.workspaceId, (tx) => changePlan(tx, paid, 'SCALE'));
    expect(up.effective).toBe('now');
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBeGreaterThan(7);
    await withTenant(t.workspaceId, (tx) => setCancellation(tx, paid, true, 'seasonal'));
    const [sub] = await ownerPool()`select cancel_at_period_end from subscriptions`;
    expect(sub!.cancel_at_period_end).toBe(true);
    await withTenant(t.workspaceId, (tx) => setCancellation(tx, paid, false));
    expect([...gw.cancelFlags.values()].at(-1)).toBe(false);
  });

  it('locks the workspace on a chargeback', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    await ownerPool()`update workspaces set stripe_customer_id = 'cus_d' where id = ${t.workspaceId}`;
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_d', ${t.workspaceId})`;
    await receiveStripeWebhook(JSON.stringify({ id: 'evt_disp', type: 'charge.dispute.created', data: { object: { id: 'dp_1', customer: 'cus_d', metadata: {} } } }), null);
    await processStripeEvent('evt_disp');
    const [w] = await ownerPool()`select state, state_before_hold from workspaces where id = ${t.workspaceId}`;
    expect(w).toMatchObject({ state: 'LOCKED', state_before_hold: 'ACTIVE_PAID' });
  });
});
