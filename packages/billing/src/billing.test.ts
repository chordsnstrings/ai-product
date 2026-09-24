import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, available, funnelBySlice, generateStoryboard, ingestBytes, moveProvisionalSkus, recordFunnel, selectConcept, startPreview } from '@arkiv/core';
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
    // Refunding the duplicate leaves the order it duplicated alone: still paid, still going to production.
    const [p] = await ownerPool()`select state, cancel_requested_at from projects where id = ${projectId}`;
    expect(p).toMatchObject({ state: 'STORYBOARD_APPROVED', cancel_requested_at: null });
  }, 60_000);
});

describe('exactly-once Stripe processing (plan 02 B1/B2, x-races-03)', () => {
  it('the webhook route, the poller and an admin replay racing on one event apply its side effects once', async () => {
    const { t, ctx, projectId } = await storyboardReady();
    const co = await withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }));
    const [w] = await ownerPool()`select stripe_customer_id from workspaces where id = ${t.workspaceId}`;
    const evt = { id: 'evt_race', type: 'checkout.session.completed', data: { object: { id: co.sessionId, mode: 'payment', payment_status: 'paid', customer: w!.stripe_customer_id, metadata: { workspace_id: t.workspaceId }, payment_intent: 'pi_race' } } };
    await receiveStripeWebhook(JSON.stringify(evt), null);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => processStripeEvent('evt_race')));
    expect(outcomes).toContain('processed');
    expect(outcomes.every((o) => o === 'processed' || o === 'in_progress')).toBe(true);
    // Replays after the fact are no-ops too.
    expect(await processStripeEvent('evt_race')).toBe('processed');
    const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
    expect(await count(ownerPool()`select count(*)::int as n from events where workspace_id = ${t.workspaceId} and type = 'TASTE_PAID'`)).toBe(1);
    expect(await count(ownerPool()`select count(*)::int as n from funnel_events where workspace_id = ${t.workspaceId} and type = 'TASTE_PAID'`)).toBe(1);
    expect(await count(ownerPool()`select count(*)::int as n from outbox where workspace_id = ${t.workspaceId} and queue = 'send-email' and payload->>'template' = 'receipt'`)).toBe(1);
    expect(await count(ownerPool()`select count(*)::int as n from ledger_entries where workspace_id = ${t.workspaceId} and type = 'CREDIT_GRANTED'`)).toBe(1);
    const [row] = await ownerPool()`select status, workspace_id, claim_token, attempts from stripe_events where id = 'evt_race'`;
    expect(row).toMatchObject({ status: 'processed', workspace_id: t.workspaceId, claim_token: null });
  }, 60_000);

  it('takes over a claim abandoned by a crashed process; the old holder can no longer complete it', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_stale', ${t.workspaceId})`;
    await receiveStripeWebhook(JSON.stringify({ id: 'evt_stale', type: 'invoice.payment_failed', data: { object: { id: 'in_s', customer: 'cus_stale', subscription: 'sub_s' } } }), null);
    const dead = '00000000-0000-4000-8000-000000000001';
    // A live claim is left alone…
    await ownerPool()`update stripe_events set status = 'processing', claimed_at = now(), claim_token = ${dead} where id = 'evt_stale'`;
    expect(await processStripeEvent('evt_stale')).toBe('in_progress');
    // …a stale one is taken over and applied once.
    await ownerPool()`update stripe_events set claimed_at = now() - interval '6 minutes' where id = 'evt_stale'`;
    expect(await processStripeEvent('evt_stale')).toBe('processed');
    const [done] = await withTenant(t.workspaceId, (tx) => tx`select stripe_event_complete('evt_stale', ${dead}) as ok`);
    expect(done!.ok).toBe(false);
    const mails = await ownerPool()`select count(*)::int as n from outbox where workspace_id = ${t.workspaceId} and payload->>'template' = 'payment_failed'`;
    expect(mails[0]!.n).toBe(1);
    const [w] = await ownerPool()`select state from workspaces where id = ${t.workspaceId}`;
    expect(w!.state).toBe('PAST_DUE');
  });

  it('an event that arrives before our row commits goes back to received for a later retry', async () => {
    const t = await makeTenant();
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_early', ${t.workspaceId})`;
    await receiveStripeWebhook(JSON.stringify({ id: 'evt_early', type: 'checkout.session.completed', data: { object: { id: 'cs_not_yet', mode: 'payment', payment_status: 'paid', customer: 'cus_early', metadata: {} } } }), null);
    expect(await processStripeEvent('evt_early')).toBe('retry');
    const [row] = await ownerPool()`select status, claim_token, attempts, error from stripe_events where id = 'evt_early'`;
    expect(row).toMatchObject({ status: 'received', claim_token: null, attempts: 1 });
    expect(row!.error).toMatch(/not committed/);
  });
});

describe('kill switches (plan 05 §20)', () => {
  it('kill.checkout pauses checkout without losing the storyboard', async () => {
    const { t, ctx, projectId } = await storyboardReady();
    await ownerPool()`update feature_flags set enabled = true where key = 'kill.checkout'`;
    await expect(withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }))).rejects.toThrow(/paused/);
    await ownerPool()`update feature_flags set enabled = false where key = 'kill.checkout'`;
    const co = await withTenant(t.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: t.userId, email: t.email }));
    expect(co.sessionId).toBeTruthy();
  });
});

describe('subscriptions (P11, plan 04 §3)', () => {
  it('requires explicit auto-renew consent, grants the period tests, supports upgrade + cancel', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    await expect(withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, ctx, { userId: t.userId, plan: 'GROWTH', agreed: false }))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(withTenant(t.workspaceId, (tx) => startSubscriptionCheckout(tx, ctx, 'GROWTH', '00000000-0000-0000-0000-000000000000', { id: t.userId, email: t.email }))).rejects.toMatchObject({ code: 'INVALID' });
    const consentId = await withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, ctx, { userId: t.userId, plan: 'GROWTH', agreed: true, ip: '1.1.1.1' }));
    const [consent] = await ownerPool()`select text_snapshot from consent_records where id = ${consentId}`;
    expect(consent!.text_snapshot).toMatch(/^\$99\/month plus applicable sales tax, charged today and on the \d+(st|nd|rd|th) of each month/);
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
    await withTenant(t.workspaceId, (tx) => setCancellation(tx, paid, true, { code: 'paused_ads', detail: 'seasonal' }));
    const [sub] = await ownerPool()`select cancel_at_period_end from subscriptions`;
    expect(sub!.cancel_at_period_end).toBe(true);
    await withTenant(t.workspaceId, (tx) => setCancellation(tx, paid, false));
    expect([...gw.cancelFlags.values()].at(-1)).toBe(false);
  });

  it('locks the workspace on a chargeback', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    await ownerPool()`update workspaces set stripe_customer_id = 'cus_d' where id = ${t.workspaceId}`;
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_d', ${t.workspaceId})`;
    await ownerPool()`insert into purchases (workspace_id, kind, amount_micros, stripe_checkout_session_id, stripe_payment_intent_id, status, created_by)
                      values (${t.workspaceId}, 'taste', 19000000, 'cs_d', 'pi_x', 'paid', 'user:x')`;
    // A Stripe Dispute carries no customer: only its charge and payment.
    await receiveStripeWebhook(JSON.stringify({ id: 'evt_disp', type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_x', payment_intent: 'pi_x' } } }), null);
    await processStripeEvent('evt_disp');
    const [w] = await ownerPool()`select state, state_before_hold from workspaces where id = ${t.workspaceId}`;
    expect(w).toMatchObject({ state: 'LOCKED', state_before_hold: 'ACTIVE_PAID' });
  });
});

describe('funnel attribution across a preview merge (plan 04 §1, plan 05 §4)', () => {
  it('credits later stages of a preview moved into an existing account to the previewing visitor', async () => {
    const V = 'vis-texture';
    const V0 = 'vis-founder';
    // The existing account first arrived earlier from the founder page and tried a product then.
    const existing = await makeTenant();
    await recordFunnel('LP_VIEWED', { visitorId: V0, page: 'founder' });
    await recordFunnel('UPLOAD_COMPLETED', { visitorId: V0, workspaceId: existing.workspaceId });
    // Today the same person, signed out, lands on the texture page and previews a product.
    await recordFunnel('LP_VIEWED', { visitorId: V, page: 'texture' });
    const prov = await makeTenant({ state: 'PROVISIONAL' });
    const pctx = ctxFor(prov.workspaceId, prov.userId, 'OWNER', 'PROVISIONAL');
    const asset = await withTenant(prov.workspaceId, async (tx) => ingestBytes(tx, pctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId } = await withTenant(prov.workspaceId, (tx) => startPreview(tx, pctx, { photoAssetIds: [asset.id], visitorId: V }));
    await analyzeProduct(pctx, skuId, projectId);
    // Signing in as the existing user moves the SKU (and its project) into their workspace.
    await moveProvisionalSkus(prov.workspaceId, existing.workspaceId, existing.userId);
    const ctx = ctxFor(existing.workspaceId, existing.userId);
    const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
    const { storyboardId } = await withTenant(existing.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
    await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
    const co = await withTenant(existing.workspaceId, (tx) => startProductionCheckout(tx, ctx, projectId, { id: existing.userId, email: existing.email }));
    await completeMockCheckout(co.sessionId);
    const later = await ownerPool()`select type, visitor_id, workspace_id from funnel_events where type in ('STORYBOARD_READY','CHECKOUT_STARTED','TASTE_PAID') order by id`;
    expect(later.map((e) => `${e.type}:${e.visitor_id}`)).toEqual([`STORYBOARD_READY:${V}`, `CHECKOUT_STARTED:${V}`, `TASTE_PAID:${V}`]);
    expect(later.every((e) => e.workspace_id === existing.workspaceId)).toBe(true);
    // The console's funnel credits the payment to the texture page, not the account's original first touch.
    const slices = await withAdmin((tx) => funnelBySlice(tx, { by: 'page', days: 30 }));
    const n = (slice: string, type: string) => slices.find((r) => r.slice === slice && r.type === type)?.n ?? 0;
    expect(n('texture', 'TASTE_PAID')).toBe(1);
    expect(n('texture', 'STORYBOARD_READY')).toBe(1);
    expect(n('founder', 'TASTE_PAID')).toBe(0);
  }, 90_000);
});
