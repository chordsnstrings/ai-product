import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { processStripeEvent, receiveStripeWebhook } from './billing';
import { assembleDisputeEvidence, submitDisputeEvidence } from './disputes';
import { MockStripe, setBillingGateway } from './gateway';
import { diffStripe, reconcileStripe } from './recon';

let gw: MockStripe;
beforeEach(async () => {
  await truncateAll();
  gw = new MockStripe();
  setBillingGateway(gw);
});
// Offer definitions are reference data: undo what these tests did to them.
afterEach(async () => {
  await ownerPool()`delete from offer_definitions where code not in ('TASTE_19', 'STANDALONE_29')`;
  await ownerPool()`update offer_definitions set active = true, stripe_price_id = null, paused_reason = null, stripe_price_archived_at = null where code in ('TASTE_19', 'STANDALONE_29')`;
});
afterAll(closeAll);

async function deliver(id: string, type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)) {
  await receiveStripeWebhook(JSON.stringify({ id, type, created, data: { object } }), null);
  return processStripeEvent(id);
}

async function subscribed(plan = 'LAUNCH') {
  const t = await makeTenant({ state: 'ACTIVE_PAID', plan });
  const customer = 'cus_' + t.workspaceId.slice(-12);
  const sub = 'sub_' + t.workspaceId.slice(-12);
  await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values (${customer}, ${t.workspaceId})`;
  const [s] = await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, current_period_start, current_period_end, consent_record_id)
                                values (${t.workspaceId}, ${sub}, ${plan}, 'active', now() - interval '10 days', now() + interval '20 days', gen_random_uuid()) returning id`;
  return { ...t, customer, sub, subRow: s!.id as string };
}

describe('archived Stripe Price (plan 05 §6 edge case)', () => {
  it('auto-pauses every offer charging it, raises an alert, and blocks reactivation until the Price is restored', async () => {
    await ownerPool()`update offer_definitions set stripe_price_id = 'price_taste19' where code = 'TASTE_19'`;
    await ownerPool()`insert into offer_definitions (code, type, price_micros, stripe_price_id, active, version) values ('TASTE_OLD', 'TASTE', 19000000, 'price_taste19', false, 0)`;
    expect(await deliver('evt_price_1', 'price.updated', { id: 'price_taste19', active: false })).toBe('processed');
    const rows = await ownerPool()`select code, active, paused_reason, stripe_price_archived_at is not null as archived from offer_definitions where stripe_price_id = 'price_taste19' order by code`;
    expect(rows).toEqual([
      { code: 'TASTE_19', active: false, paused_reason: 'Stripe Price price_taste19 archived', archived: true },
      { code: 'TASTE_OLD', active: false, paused_reason: null, archived: true },
    ]);
    const alerts = await ownerPool()`select kind, subject_id, severity from platform_alerts`;
    expect(alerts).toEqual([{ kind: 'offer.stripe_price_archived', subject_id: 'TASTE_19', severity: 'risk' }]);
    const [ev] = await ownerPool()`select status, workspace_id from stripe_events where id = 'evt_price_1'`;
    expect(ev).toEqual({ status: 'processed', workspace_id: null });
    // A repeat of the event changes nothing and raises no second alert.
    expect(await deliver('evt_price_2', 'price.deleted', { id: 'price_taste19' })).toBe('processed');
    expect(await ownerPool()`select 1 from platform_alerts`).toHaveLength(1);
    // Restored in Stripe: the block lifts, the offer stays paused until staff reactivate it.
    await deliver('evt_price_3', 'price.updated', { id: 'price_taste19', active: true });
    const [t] = await ownerPool()`select active, stripe_price_archived_at from offer_definitions where code = 'TASTE_19'`;
    expect(t).toEqual({ active: false, stripe_price_archived_at: null });
  });
});

describe('dunning and MRR events (plan 05 §7)', () => {
  it('records Stripe’s retry schedule on a failed payment and clears it when paid', async () => {
    const t = await subscribed();
    const next = Math.floor(Date.now() / 1000) + 3 * 86400;
    await deliver('evt_f1', 'invoice.payment_failed', { id: 'in_f', customer: t.customer, subscription: t.sub, attempt_count: 2, next_payment_attempt: next });
    // A late, older failure doesn't move the schedule back.
    await deliver('evt_f0', 'invoice.payment_failed', { id: 'in_f', customer: t.customer, subscription: t.sub, attempt_count: 1, next_payment_attempt: next - 86400 });
    let [s] = await ownerPool()`select status, payment_attempt_count, next_payment_attempt from subscriptions where id = ${t.subRow}`;
    expect(s).toMatchObject({ status: 'past_due', payment_attempt_count: 2 });
    expect(new Date(s!.next_payment_attempt as string).getTime()).toBe(next * 1000);
    await deliver('evt_p', 'invoice.paid', { id: 'in_f', customer: t.customer, subscription: t.sub, billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: next - 86400, end: next + 29 * 86400 } }] } });
    [s] = await ownerPool()`select status, payment_attempt_count, next_payment_attempt from subscriptions where id = ${t.subRow}`;
    expect(s).toEqual({ status: 'active', payment_attempt_count: 0, next_payment_attempt: null });
  });

  it('emits SUBSCRIPTION_ENDED once when Stripe deletes the subscription, and a change event for an applied downgrade', async () => {
    const t = await subscribed('GROWTH');
    await ownerPool()`update subscriptions set pending_plan_code = 'LAUNCH' where id = ${t.subRow}`;
    const now = Math.floor(Date.now() / 1000);
    await deliver('evt_cycle', 'invoice.paid', { id: 'in_c', customer: t.customer, subscription: t.sub, billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: now, end: now + 30 * 86400 } }] } });
    await deliver('evt_del', 'customer.subscription.deleted', { id: t.sub, customer: t.customer, status: 'canceled' });
    await deliver('evt_del2', 'customer.subscription.deleted', { id: t.sub, customer: t.customer, status: 'canceled' });
    const evs = await ownerPool()`select type, payload from events where workspace_id = ${t.workspaceId} and type like 'SUBSCRIPTION_%' order by seq`;
    expect(evs.map((e) => [e.type, e.payload.effective ?? e.payload.plan])).toEqual([['SUBSCRIPTION_CHANGED', 'applied'], ['SUBSCRIPTION_ENDED', 'LAUNCH']]);
  });
});

describe('dispute evidence (plan 05 §7)', () => {
  it('assembles delivery, exports, consent with IP and receipts for the disputed payment, and submits once', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const other = await makeTenant({ state: 'ACTIVE_PAID' });
    const project = newId();
    await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, stripe_checkout_session_id, stripe_payment_intent_id, status, created_by, paid_at)
                      values (${t.workspaceId}, 'taste', ${project}, 19000000, 'cs_ev', 'pi_ev', 'paid', ${'user:' + t.userId}, now() - interval '2 days')`;
    await ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload, at) values (${t.workspaceId}, 'COMPOSITION_COMPLETED', 'system:test', 'project', ${project}, '{}', now() - interval '1 day')`;
    const asset = newId();
    await ownerPool()`insert into assets (id, workspace_id, kind, storage_key, mime, bytes, checksum_sha256, source, lineage) values (${asset}, ${t.workspaceId}, 'final_export', ${'k/' + asset}, 'video/mp4', 1, 'x', 'composed', ${ownerPool().json({ projectId: project })})`;
    await ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload, at) values (${t.workspaceId}, 'ASSET_EXPORTED', ${'user:' + t.userId}, 'asset', ${asset}, '{}', now() - interval '20 hours')`;
    // Another tenant's activity must never appear in this pack.
    await ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${other.workspaceId}, 'ASSET_EXPORTED', 'user:x', 'asset', ${newId()}, '{}')`;
    await ownerPool()`insert into consent_records (workspace_id, user_id, kind, text_version, text_snapshot, ip) values (${t.workspaceId}, ${t.userId}, 'terms', 'terms@2026-09', 'I agree to the Terms.', '203.0.113.7')`;
    await ownerPool()`insert into stripe_disputes (id, workspace_id, charge_id, payment_intent_id, amount_cents, reason, status, evidence_due_by)
                      values ('dp_ev', ${t.workspaceId}, 'ch_ev', 'pi_ev', 1900, 'product_not_received', 'needs_response', now() + interval '5 days')`;

    const pack = await withAdmin((tx) => assembleDisputeEvidence(tx, t.workspaceId, 'dp_ev'));
    expect(pack.payment).toMatchObject({ kind: 'one_off' });
    expect(pack.deliveries).toHaveLength(1);
    expect(pack.exports).toEqual([{ at: expect.any(String), assetId: asset, by: 'user:' + t.userId }]);
    expect(pack.customer).toMatchObject({ email: t.email, ip: '203.0.113.7' });
    expect(pack.evidence).toMatchObject({ customer_email_address: t.email, customer_purchase_ip: '203.0.113.7' });
    expect(pack.evidence.access_activity_log).toMatch(/Downloaded ad file/);
    expect(pack.evidence.uncategorized_text).toMatch(/terms terms@2026-09/);
    // Another tenant can't be asked for this dispute.
    await expect(withAdmin((tx) => assembleDisputeEvidence(tx, other.workspaceId, 'dp_ev'))).rejects.toThrow(/not found/);

    await withAdmin((tx) => submitDisputeEvidence(tx, t.workspaceId, 'dp_ev', newId(), 'Customer downloaded the ad the day after delivery.'));
    expect(gw.disputeSubmissions).toHaveLength(1);
    expect(gw.disputeSubmissions[0]!.evidence.uncategorized_text).toMatch(/^Customer downloaded/);
    const [d] = await ownerPool()`select status, evidence is not null as has, evidence_submitted_at is not null as submitted from stripe_disputes where id = 'dp_ev'`;
    expect(d).toEqual({ status: 'under_review', has: true, submitted: true });
    await expect(withAdmin((tx) => submitDisputeEvidence(tx, t.workspaceId, 'dp_ev', newId()))).rejects.toThrow(/already submitted/);
  });
});

describe('nightly Stripe reconciliation (plan 05 §7)', () => {
  it('diffs customers, subscriptions and charges against the mirror', () => {
    const since = new Date(Date.now() - 30 * 86400_000);
    const now = Math.floor(Date.now() / 1000);
    const { exceptions } = diffStripe(
      {
        customers: [{ id: 'cus_a', workspaceId: 'ws-a', created: now }, { id: 'cus_x', workspaceId: null, created: now }],
        subscriptions: [
          { id: 'sub_a', customerId: 'cus_a', status: 'past_due', priceId: null, cancelAtPeriodEnd: true, currentPeriodEnd: now },
          { id: 'sub_new', customerId: 'cus_a', status: 'active', priceId: null, cancelAtPeriodEnd: false, currentPeriodEnd: now },
        ],
        charges: [
          { id: 'ch_1', customerId: 'cus_a', paymentIntentId: 'pi_1', amountCents: 1900, amountRefundedCents: 1900, status: 'succeeded', disputed: true, created: now },
          { id: 'ch_2', customerId: 'cus_a', paymentIntentId: 'pi_2', amountCents: 2900, amountRefundedCents: 0, status: 'succeeded', disputed: false, created: now },
          { id: 'ch_3', customerId: 'cus_a', paymentIntentId: 'pi_3', amountCents: 2900, amountRefundedCents: 0, status: 'failed', disputed: false, created: now },
        ],
      },
      {
        customers: [{ customerId: 'cus_a', workspaceId: 'ws-a' }, { customerId: 'cus_gone', workspaceId: 'ws-b' }],
        subscriptions: [{ id: 'sub_a', workspaceId: 'ws-a', status: 'active', plan: 'LAUNCH', cancelAtPeriodEnd: false }, { id: 'sub_lost', workspaceId: 'ws-b', status: 'active', plan: 'GROWTH', cancelAtPeriodEnd: false }],
        purchases: [
          { paymentIntentId: 'pi_1', workspaceId: 'ws-a', amountMicros: 19_000_000, refundedMicros: 0, status: 'paid', paidAt: new Date() },
          { paymentIntentId: 'pi_missing', workspaceId: 'ws-a', amountMicros: 29_000_000, refundedMicros: 0, status: 'paid', paidAt: new Date() },
          { paymentIntentId: 'pi_old', workspaceId: 'ws-a', amountMicros: 29_000_000, refundedMicros: 0, status: 'paid', paidAt: new Date(since.getTime() - 86400_000) },
        ],
        invoices: [],
        refunds: [],
        disputes: [],
      },
      { missingSince: since },
    );
    expect(exceptions.map((e) => `${e.kind}:${e.stripeId}`).sort()).toEqual([
      'charge_unmatched:ch_2',
      'customer_missing:cus_gone',
      'customer_unknown:cus_x',
      'dispute_unmirrored:ch_1',
      'payment_missing_in_stripe:pi_missing',
      'refund_mismatch:ch_1',
      'subscription_cancel_mismatch:sub_a',
      'subscription_missing:sub_new',
      'subscription_status_mismatch:sub_a',
      'subscription_unknown_to_stripe:sub_lost',
    ]);
  });

  it('records exceptions, keeps one open row per difference, and resolves what a later run no longer finds', async () => {
    // Without Stripe configured, the nightly run is skipped (nothing real to compare with).
    expect((await reconcileStripe()).status).toBe('skipped');
    const t = await subscribed();
    gw.customers.push({ id: t.customer, workspaceId: t.workspaceId, created: 1 });
    gw.subscriptions.push({ id: t.sub, customerId: t.customer, status: 'active', priceId: null, cancelAtPeriodEnd: true, currentPeriodEnd: null });
    const first = await reconcileStripe({ force: true });
    expect(first).toMatchObject({ status: 'completed', counts: { exceptions: 1, opened: 1, cleared: 0 } });
    await reconcileStripe({ force: true });
    const open = await ownerPool()`select kind, stripe_id, workspace_id from stripe_recon_exceptions where resolved_at is null`;
    expect(open).toEqual([{ kind: 'subscription_cancel_mismatch', stripe_id: t.sub, workspace_id: t.workspaceId }]);
    // The webhook that was missed arrives (or staff fix it): the next run resolves the exception.
    await ownerPool()`update subscriptions set cancel_at_period_end = true where id = ${t.subRow}`;
    const third = await reconcileStripe({ force: true });
    expect(third.counts).toMatchObject({ exceptions: 0, cleared: 1 });
    expect(await ownerPool()`select 1 from stripe_recon_exceptions where resolved_at is null`).toHaveLength(0);
    const runs = await ownerPool()`select status from stripe_recon_runs order by started_at`;
    expect(runs.map((r) => r.status)).toEqual(['skipped', 'completed', 'completed', 'completed']);
  });
});
