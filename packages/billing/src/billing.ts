import { globalTx, withSystem, withTenant, type Tx } from '@arkiv/db';
import { DomainError, PLANS, env, formatUsd, microsToCents, type PlanCode } from '@arkiv/shared';
import {
  isFlagOn,
  append,
  approveForProduction,
  assertCan,
  checkoutSessionExpiry,
  currentQuote,
  emit,
  enqueue,
  expirePeriod,
  periodUsage,
  Queues,
  projectVisitor,
  recordFunnel,
  workspaceVisitor,
  raiseAlert,
  redeemOffer,
  transition,
  transitionWorkspace,
  type TenantContext,
} from '@arkiv/core';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { billingGateway, priceIdFor, type MockStripe } from './gateway';
import { applySucceededRefund, recordChargeRefund } from './refunds';

/**
 * Billing (plan 02 §6 B1–B12, plan 04 §3 legal line):
 *  - $19 Taste / $29 Standalone are one-time payments that never auto-convert into a subscription.
 *  - Subscriptions require a separate, unchecked, affirmatively-given auto-renew consent (ROSCA, Cal. ARL),
 *    stored ≥ 3 years.
 *  - Entitlements are granted only from verified, de-duplicated webhook events.
 */

export const AUTO_RENEW_TEXT_VERSION = 'auto-renew@2026-09-23';
export function autoRenewText(plan: PlanCode, now = new Date()) {
  const p = PLANS[plan];
  const day = now.getUTCDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${formatUsd(p.priceMicros, 0)} charged today and every month on the ${day}${suffix} until you cancel. Cancel online anytime in Settings → Billing.`;
}

async function ensureCustomer(tx: Tx, ctx: TenantContext, email: string): Promise<string> {
  const [w] = await tx`select stripe_customer_id, name from workspaces where id = ${ctx.workspaceId} for update`;
  if (w?.stripe_customer_id) return w.stripe_customer_id as string;
  const id = await billingGateway().createCustomer(email, ctx.workspaceId, w?.name as string);
  await tx`update workspaces set stripe_customer_id = ${id} where id = ${ctx.workspaceId}`;
  await tx`insert into stripe_customers (customer_id, workspace_id) values (${id}, ${ctx.workspaceId}) on conflict do nothing`;
  return id;
}

/** P8: one-time checkout for the current storyboard at the quoted price (Taste if active, else $29). */
export async function startProductionCheckout(tx: Tx, ctx: TenantContext, projectId: string, user: { id: string; email: string }) {
  assertCan(ctx, 'storyboard.approve');
  if (await isFlagOn(tx, 'kill.checkout')) throw new DomainError('UNAVAILABLE', 'Checkout is paused for a few minutes for maintenance. Your storyboard is saved.');
  const [p] = await tx`select p.state, p.storyboard_id, s.name from projects p join skus s on s.id = p.sku_id where p.id = ${projectId}`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  if (p.state !== 'STORYBOARD_READY') throw new DomainError('CONFLICT', p.state === 'COMPLETE' || String(p.state).startsWith('REN') ? 'This ad is already in production.' : 'The storyboard isn’t ready yet.');
  const [paid] = await tx`select id from purchases where project_id = ${projectId} and status = 'paid'`;
  if (paid) throw new DomainError('CONFLICT', 'Already paid — production is starting.');
  const quote = await currentQuote(tx);
  const kind = quote.kind;
  const customerId = await ensureCustomer(tx, ctx, user.email);
  const idem = `checkout:${ctx.workspaceId}:${projectId}:${quote.offerId ?? 'standalone'}:${quote.priceMicros}`;
  const [existing] = await tx`select id, stripe_checkout_session_id from purchases where project_id = ${projectId} and status = 'pending'
                              and amount_micros = ${quote.priceMicros} and created_at > now() - interval '25 minutes' order by created_at desc limit 1`;
  const session = await billingGateway().createCheckout({
    mode: 'payment',
    customerId,
    // The offer definition's Stripe Price when it has one (plan 05 §6); env price for the standard $29 otherwise.
    priceId: quote.stripePriceId ?? (quote.kind === 'standalone' ? priceIdFor('STANDALONE') : null),
    amountCents: microsToCents(quote.priceMicros),
    productName: `Your ${p.name} ad · 15s`,
    description: 'One finished 15-second ad · TikTok, Reels and Feed exports · product and claims checked · one-time, no subscription',
    metadata: { workspace_id: ctx.workspaceId, project_id: projectId, kind, offer_id: quote.offerId ?? '', offer_code: quote.definitionCode ?? '' },
    expiresAt: checkoutSessionExpiry(quote),
    returnUrl: `${env().APP_URL}/produce/${projectId}?session={CHECKOUT_SESSION_ID}`,
    idempotencyKey: idem,
    automaticTax: billingGateway().live,
  });
  if (!existing || existing.stripe_checkout_session_id !== session.id) {
    await tx`insert into purchases (workspace_id, kind, offer_id, project_id, amount_micros, stripe_checkout_session_id, created_by)
             values (${ctx.workspaceId}, ${kind}, ${quote.offerId}, ${projectId}, ${quote.priceMicros}, ${session.id}, ${'user:' + user.id})
             on conflict (stripe_checkout_session_id) do nothing`;
  }
  await emit(tx, ctx, 'CHECKOUT_STARTED', { type: 'project', id: projectId }, { kind, priceMicros: quote.priceMicros });
  await recordFunnel('CHECKOUT_STARTED', { workspaceId: ctx.workspaceId, visitorId: await projectVisitor(tx, ctx.workspaceId, projectId), props: { kind } }, tx);
  return { sessionId: session.id, clientSecret: session.clientSecret, url: session.url, quote };
}

export async function recordAutoRenewConsent(
  tx: Tx,
  ctx: TenantContext,
  input: { userId: string; plan: PlanCode; agreed: boolean; ip?: string | null; userAgent?: string | null },
) {
  // Consent records are append-only; never write one for someone who cannot start the subscription.
  assertCan(ctx, 'billing.manage');
  if (!input.agreed) throw new DomainError('INVALID', 'Please tick the box to agree to the recurring charge.');
  const text = autoRenewText(input.plan);
  const [c] = await tx`insert into consent_records (workspace_id, user_id, kind, text_version, text_snapshot, context, ip, user_agent)
                       values (${ctx.workspaceId}, ${input.userId}, 'auto_renew', ${AUTO_RENEW_TEXT_VERSION}, ${text},
                               ${tx.json({ plan: input.plan, priceMicros: PLANS[input.plan].priceMicros })}, ${input.ip ?? null}, ${input.userAgent ?? null})
                       returning id`;
  return c!.id as string;
}

/** P11: subscription checkout; requires a consent record created in the same flow (plan 04 §3). */
export async function startSubscriptionCheckout(tx: Tx, ctx: TenantContext, plan: PlanCode, consentId: string, user: { id: string; email: string }) {
  assertCan(ctx, 'billing.manage');
  if (await isFlagOn(tx, 'kill.checkout')) throw new DomainError('UNAVAILABLE', 'Checkout is paused for a few minutes for maintenance.');
  const [consent] = await tx`select id, context from consent_records where id = ${consentId} and kind = 'auto_renew' and created_at > now() - interval '30 minutes'`;
  if (!consent || (consent.context as { plan: string }).plan !== plan) throw new DomainError('INVALID', 'Please confirm the recurring charge again.');
  const [active] = await tx`select id from subscriptions where status in ('active','trialing','past_due')`;
  if (active) throw new DomainError('CONFLICT', 'You already have a plan. Change it from Settings → Billing.');
  const customerId = await ensureCustomer(tx, ctx, user.email);
  const session = await billingGateway().createCheckout({
    mode: 'subscription',
    customerId,
    priceId: priceIdFor(plan),
    amountCents: microsToCents(PLANS[plan].priceMicros),
    productName: `${PLANS[plan].name} · ${PLANS[plan].creativeTestsPerMonth} Creative Tests / month`,
    metadata: { workspace_id: ctx.workspaceId, plan, consent_record_id: consentId },
    expiresAt: new Date(Date.now() + 60 * 60_000),
    returnUrl: `${env().APP_URL}/app?subscribed=1&session={CHECKOUT_SESSION_ID}`,
    idempotencyKey: `sub:${ctx.workspaceId}:${plan}:${consentId}`,
    automaticTax: billingGateway().live,
  });
  return { sessionId: session.id, clientSecret: session.clientSecret, url: session.url };
}

/** A9 cancel flow: cancels at period end (access continues); un-cancel is free before the period ends. */
export async function setCancellation(tx: Tx, ctx: TenantContext, cancel: boolean, reason?: string | null) {
  assertCan(ctx, 'billing.manage');
  const [s] = await tx`select * from subscriptions where status in ('active','trialing','past_due') order by created_at desc limit 1`;
  if (!s) throw new DomainError('NOT_FOUND', 'No active plan.');
  if (s.status === 'past_due' && cancel) {
    // Cancelling during PAST_DUE is immediate (plan 03 A9).
    await billingGateway().setCancelAtPeriodEnd(s.stripe_subscription_id as string, true);
  } else {
    await billingGateway().setCancelAtPeriodEnd(s.stripe_subscription_id as string, cancel);
  }
  await tx`update subscriptions set cancel_at_period_end = ${cancel} where id = ${s.id}`;
  await emit(tx, ctx, 'SUBSCRIPTION_CHANGED', { type: 'subscription', id: s.id as string }, { cancelAtPeriodEnd: cancel, reason: reason ?? null });
  return { endsAt: s.current_period_end as string };
}

/**
 * Upgrade now (prorated) or downgrade at period end (plan 02 B6/B7). Explicit workspace filters: the staff console
 * runs it as admin_rw (whose policies see every tenant) for a change the customer consented to.
 */
export async function changePlan(tx: Tx, ctx: TenantContext, to: PlanCode) {
  assertCan(ctx, 'billing.manage');
  const [s] = await tx`select * from subscriptions where workspace_id = ${ctx.workspaceId} and status = 'active' order by created_at desc limit 1`;
  if (!s) throw new DomainError('NOT_FOUND', 'No active plan.');
  const from = s.plan_code as PlanCode;
  if (from === to) return { effective: 'none' as const };
  const upgrade = PLANS[to].priceMicros > PLANS[from].priceMicros;
  if (upgrade) {
    await billingGateway().changeSubscriptionPrice(s.stripe_subscription_id as string, priceIdFor(to) ?? `price_${to}`, true);
    await tx`update subscriptions set plan_code = ${to}, pending_plan_code = null where id = ${s.id} and workspace_id = ${ctx.workspaceId}`;
    await tx`update workspaces set plan_code = ${to} where id = ${ctx.workspaceId}`;
    // Pro-rata extra Creative Tests for the rest of this period (rounded up).
    const start = new Date(s.current_period_start as string).getTime();
    const end = new Date(s.current_period_end as string).getTime();
    const frac = Math.max(0, Math.min(1, (end - Date.now()) / (end - start)));
    const extra = Math.ceil((PLANS[to].creativeTestsPerMonth - PLANS[from].creativeTestsPerMonth) * frac);
    const periodKey = new Date(start).toISOString().slice(0, 10);
    if (extra > 0) await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: extra, periodKey, idempotencyKey: `upgrade:${s.id}:${to}:${periodKey}`, reason: `Upgrade ${from}→${to} pro-rata` });
    await emit(tx, ctx, 'SUBSCRIPTION_CHANGED', { type: 'subscription', id: s.id as string }, { from, to, effective: 'now', extraTests: extra });
    return { effective: 'now' as const, extraTests: extra };
  }
  await tx`update subscriptions set pending_plan_code = ${to} where id = ${s.id} and workspace_id = ${ctx.workspaceId}`;
  await emit(tx, ctx, 'SUBSCRIPTION_CHANGED', { type: 'subscription', id: s.id as string }, { from, to, effective: 'period_end' });
  return { effective: 'period_end' as const, on: s.current_period_end as string };
}

// ───────────── Staff billing actions (plan 05 §2.2 Billing) ─────────────

/**
 * "Change plan (customer consent recorded)": a plan change staff make on the customer's instruction. The recurring
 * charge changes, so an auto-renew consent record is written first with the new price and where the customer
 * agreed (ticket/email reference); then the same upgrade-now / downgrade-at-period-end rules as the customer's own
 * change apply.
 */
export async function staffChangePlan(tx: Tx, ctx: TenantContext, to: PlanCode, consent: { reference: string; staffId: string }) {
  if (consent.reference.trim().length < 4) throw new DomainError('INVALID', 'Reference where the customer agreed (ticket or email).');
  const [s] = await tx`select plan_code from subscriptions where workspace_id = ${ctx.workspaceId} and status = 'active' order by created_at desc limit 1`;
  if (!s) throw new DomainError('NOT_FOUND', 'No active plan to change.');
  if (s.plan_code === to) throw new DomainError('CONFLICT', `Already on ${PLANS[to].name}.`);
  const [c] = await tx`insert into consent_records (workspace_id, user_id, kind, text_version, text_snapshot, context)
                       values (${ctx.workspaceId}, null, 'auto_renew', ${AUTO_RENEW_TEXT_VERSION}, ${autoRenewText(to)},
                               ${tx.json({ plan: to, priceMicros: PLANS[to].priceMicros, from: s.plan_code as string, via: 'staff', staffId: consent.staffId, reference: consent.reference.trim() })})
                       returning id`;
  const r = await changePlan(tx, ctx, to);
  return { ...r, consentRecordId: c!.id as string };
}

/** "Apply coupon": a Stripe coupon on the workspace's active subscription, mirrored on the row and as an event. */
export async function applySubscriptionCoupon(tx: Tx, ctx: TenantContext, coupon: string) {
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(coupon)) throw new DomainError('INVALID', 'Coupon ids are letters, digits, - and _.');
  const [s] = await tx`select id, stripe_subscription_id, coupon from subscriptions where workspace_id = ${ctx.workspaceId} and status in ('active','trialing','past_due')
                       order by created_at desc limit 1 for update`;
  if (!s?.stripe_subscription_id) throw new DomainError('NOT_FOUND', 'No active subscription to discount.');
  await billingGateway().applyCoupon(s.stripe_subscription_id as string, coupon);
  await tx`update subscriptions set coupon = ${coupon} where id = ${s.id} and workspace_id = ${ctx.workspaceId}`;
  await emit(tx, ctx, 'SUBSCRIPTION_CHANGED', { type: 'subscription', id: s.id as string }, { coupon, previousCoupon: (s.coupon as string) ?? null });
  return { subscriptionId: s.id as string, previous: (s.coupon as string) ?? null };
}

// ───────────── Webhooks ─────────────

/** Receive: verify signature, store raw event (dedupe by id), return fast; processing is async (B1–B2). */
export async function receiveStripeWebhook(raw: string, signature: string | null): Promise<{ id: string; duplicate: boolean }> {
  let event: Stripe.Event;
  try {
    event = billingGateway().constructEvent(raw, signature);
  } catch {
    throw new DomainError('FORBIDDEN', 'Invalid signature');
  }
  // Stored through a dedupe function: the app role can insert events but never read other tenants' payloads.
  const [r] = await globalTx((tx) => tx`select stripe_event_receive(${event.id}, ${event.type}, ${tx.json(event as never)}) as inserted`);
  return { id: event.id, duplicate: !r?.inserted };
}

async function resolveWorkspace(tx: Tx, customerId: string | null, metaWorkspace: string | null, paymentIntent: string | null = null): Promise<string | null> {
  if (customerId) {
    const [m] = await tx`select workspace_id from stripe_customers where customer_id = ${customerId}`;
    if (m) {
      // Metadata must agree with the mapping; a mismatch is never guessed (B3/B11).
      if (metaWorkspace && metaWorkspace !== m.workspace_id) return null;
      return m.workspace_id as string;
    }
    return null;
  }
  // Disputes carry no customer, only the payment: route them by the payment we recorded (a one-off purchase or
  // a mirrored invoice). Two workspaces claiming the same payment is never guessed.
  if (paymentIntent) {
    const ws = await tx`select workspace_id from purchases where stripe_payment_intent_id = ${paymentIntent}
                        union select workspace_id from stripe_invoices where payment_intent_id = ${paymentIntent}`;
    if (ws.length === 1 && (!metaWorkspace || metaWorkspace === ws[0]!.workspace_id)) return ws[0]!.workspace_id as string;
  }
  return null;
}

type InvoiceLike = {
  id: string;
  status?: string | null;
  billing_reason?: string | null;
  currency?: string | null;
  amount_due?: number | null;
  amount_paid?: number | null;
  amount_remaining?: number | null;
  hosted_invoice_url?: string | null;
  created?: number | null;
  payment_intent?: string | { id: string } | null;
  payments?: { data?: { payment?: { payment_intent?: string } }[] };
  lines?: { data?: { period?: { start: number; end: number } }[] };
};

/** An invoice event's status when the payload leaves it out (older API versions, test fixtures). */
const INVOICE_STATUS_FROM_EVENT: Record<string, string> = { 'invoice.paid': 'paid', 'invoice.payment_failed': 'open', 'invoice.voided': 'void', 'invoice.marked_uncollectible': 'uncollectible', 'invoice.finalized': 'open', 'invoice.created': 'draft' };
const unix = (s: number | null | undefined) => (s ? new Date(s * 1000) : null);

/**
 * Stripe mirror (plan 05 §2.2 Billing, §7): every invoice event upserts the invoice row. An event older than the one
 * already applied never overwrites it, so late deliveries can't roll a paid invoice back to open.
 */
export async function mirrorInvoice(tx: Tx, workspaceId: string, event: { id: string; type: string; created?: number }, inv: InvoiceLike) {
  const pi = typeof inv.payment_intent === 'string' ? inv.payment_intent : (inv.payment_intent?.id ?? inv.payments?.data?.[0]?.payment?.payment_intent ?? null);
  const period = inv.lines?.data?.[0]?.period;
  const at = unix(event.created) ?? new Date();
  await tx`
    insert into stripe_invoices (id, workspace_id, stripe_subscription_id, status, billing_reason, currency, amount_due_cents, amount_paid_cents, amount_remaining_cents,
                                 payment_intent_id, hosted_invoice_url, period_start, period_end, stripe_created_at, last_event_id, last_event_at)
    values (${inv.id}, ${workspaceId}, ${subscriptionIdOf(inv as never)}, ${inv.status ?? INVOICE_STATUS_FROM_EVENT[event.type] ?? 'open'}, ${inv.billing_reason ?? null},
            ${inv.currency ?? 'usd'}, ${inv.amount_due ?? inv.amount_paid ?? 0}, ${inv.amount_paid ?? 0}, ${inv.amount_remaining ?? 0}, ${pi}, ${inv.hosted_invoice_url ?? null},
            ${unix(period?.start)}, ${unix(period?.end)}, ${unix(inv.created) ?? at}, ${event.id}, ${at})
    on conflict (id) do update set status = excluded.status, billing_reason = coalesce(excluded.billing_reason, stripe_invoices.billing_reason),
      amount_due_cents = excluded.amount_due_cents, amount_paid_cents = excluded.amount_paid_cents, amount_remaining_cents = excluded.amount_remaining_cents,
      payment_intent_id = coalesce(excluded.payment_intent_id, stripe_invoices.payment_intent_id), hosted_invoice_url = coalesce(excluded.hosted_invoice_url, stripe_invoices.hosted_invoice_url),
      period_start = coalesce(excluded.period_start, stripe_invoices.period_start), period_end = coalesce(excluded.period_end, stripe_invoices.period_end),
      last_event_id = excluded.last_event_id, last_event_at = excluded.last_event_at, updated_at = now()
    where stripe_invoices.workspace_id = excluded.workspace_id and (stripe_invoices.last_event_at is null or stripe_invoices.last_event_at <= excluded.last_event_at)`;
}

type DisputeLike = { id: string; charge?: string | { id: string } | null; payment_intent?: string | { id: string } | null; amount?: number | null; currency?: string | null; reason?: string | null; status?: string | null; created?: number | null; evidence_details?: { due_by?: number | null } | null };

/** Dispute mirror (plan 05 §2.2 Billing, §7 Disputes): the latest state of each dispute. */
export async function mirrorDispute(tx: Tx, workspaceId: string, event: { id: string; type: string; created?: number }, d: DisputeLike) {
  const idOf = (x: string | { id: string } | null | undefined) => (typeof x === 'string' ? x : (x?.id ?? null));
  const at = unix(event.created) ?? new Date();
  await tx`
    insert into stripe_disputes (id, workspace_id, charge_id, payment_intent_id, amount_cents, currency, reason, status, evidence_due_by, stripe_created_at, last_event_id, last_event_at)
    values (${d.id}, ${workspaceId}, ${idOf(d.charge)}, ${idOf(d.payment_intent)}, ${d.amount ?? 0}, ${d.currency ?? 'usd'}, ${d.reason ?? null},
            ${d.status ?? (event.type === 'charge.dispute.closed' ? 'closed' : 'needs_response')}, ${unix(d.evidence_details?.due_by)}, ${unix(d.created) ?? at}, ${event.id}, ${at})
    on conflict (id) do update set status = excluded.status, reason = coalesce(excluded.reason, stripe_disputes.reason), amount_cents = excluded.amount_cents,
      evidence_due_by = coalesce(excluded.evidence_due_by, stripe_disputes.evidence_due_by), last_event_id = excluded.last_event_id, last_event_at = excluded.last_event_at, updated_at = now()
    where stripe_disputes.workspace_id = excluded.workspace_id and (stripe_disputes.last_event_at is null or stripe_disputes.last_event_at <= excluded.last_event_at)`;
}

const sysCtx = (workspaceId: string, state = 'ACTIVE_PAID'): TenantContext => ({
  workspaceId,
  workspaceState: state as never,
  role: 'OWNER',
  actor: { kind: 'system', id: 'stripe' },
  requestId: 'stripe',
});

/** A claim older than this is presumed dead (crashed worker) and may be taken over. */
export const STRIPE_CLAIM_STALE_MINUTES = 5;

/** The claim was taken over (stale) while this run was still going: roll back, the new holder finishes. */
class ClaimLost extends Error {}

const INVOICE_EVENTS = ['invoice.created', 'invoice.finalized', 'invoice.updated', 'invoice.paid', 'invoice.payment_failed', 'invoice.voided', 'invoice.marked_uncollectible'];
const DISPUTE_EVENTS = ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'];
/** Platform-level events (no customer, no tenant): a Stripe Price was archived, deleted or restored. */
const PRICE_EVENTS = ['price.updated', 'price.deleted'];
const HANDLED_TYPES = ['checkout.session.completed', 'checkout.session.expired', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded', ...INVOICE_EVENTS, ...DISPUTE_EVENTS, ...PRICE_EVENTS];

export type StripeOutcome = 'processed' | 'unmatched' | 'ignored' | 'retry' | 'in_progress';

/**
 * Process one stored event (system job). Exactly once, whichever of the webhook route, the worker poller or an
 * admin replay gets there first (plan 02 B1/B2, standard §35):
 *  1. claim atomically (received/unmatched/failed → processing, or a stale processing claim); a caller that
 *     loses the race returns at once;
 *  2. apply the event in one tenant transaction whose last statement marks it processed (under the same
 *     claim), so its side effects (ledger, events, funnel, emails) commit together with the mark — a crash
 *     before the commit re-runs everything, a crash after it re-runs nothing.
 */
export async function processStripeEvent(eventId: string): Promise<StripeOutcome> {
  const claim = randomUUID();
  const [row] = await withSystem((tx) => tx`
    update stripe_events set status = 'processing', claimed_at = now(), claim_token = ${claim}, attempts = attempts + 1
    where id = ${eventId}
      and (status in ('received', 'unmatched', 'failed')
           or (status = 'processing' and claimed_at < now() - make_interval(mins => ${STRIPE_CLAIM_STALE_MINUTES})))
    returning *`);
  if (!row) {
    const [cur] = await withSystem((tx) => tx`select status from stripe_events where id = ${eventId}`);
    return cur?.status === 'processing' ? 'in_progress' : 'processed';
  }
  // Every later write is conditional on still holding the claim.
  const release = (status: 'received' | 'unmatched' | 'ignored' | 'failed', error: string | null = null) =>
    withSystem((tx) => tx`update stripe_events set status = ${status}, claim_token = null, error = ${error},
                           processed_at = ${status === 'ignored' ? new Date() : null}
                          where id = ${eventId} and claim_token = ${claim}`);
  const event = row.payload as Stripe.Event;
  const obj = event.data.object as unknown as Record<string, unknown>;
  if (PRICE_EVENTS.includes(event.type)) {
    // Not a tenant's event: applied as the system role, and marked processed in the same transaction.
    try {
      return await withSystem(async (tx) => {
        await onPriceChanged(tx, event.type, obj as { id: string; active?: boolean | null });
        const [done] = await tx`update stripe_events set status = 'processed', processed_at = now(), error = null, claim_token = null
                                where id = ${eventId} and status = 'processing' and claim_token = ${claim} returning id`;
        if (!done) throw new ClaimLost();
        return 'processed' as const;
      });
    } catch (e) {
      if (e instanceof ClaimLost) return 'in_progress';
      await release('failed', (e as Error).message.slice(0, 500));
      throw e;
    }
  }
  const customerId = (obj.customer as string) ?? null;
  const meta = (obj.metadata as Record<string, string>) ?? {};
  const paymentIntent = typeof obj.payment_intent === 'string' ? obj.payment_intent : ((obj.payment_intent as { id?: string } | null)?.id ?? null);
  const workspaceId = await withSystem((tx) => resolveWorkspace(tx, customerId, meta.workspace_id ?? null, paymentIntent));
  if (!HANDLED_TYPES.includes(event.type)) {
    await release('ignored');
    return 'ignored';
  }
  if (!workspaceId) {
    await release('unmatched');
    return 'unmatched';
  }
  try {
    return await withTenant(workspaceId, async (tx) => {
      const outcome = await applyStripeEvent(tx, workspaceId, event, obj);
      const [done] = await tx`select stripe_event_complete(${eventId}, ${claim}) as ok`;
      if (!done?.ok) throw new ClaimLost();
      return outcome;
    });
  } catch (e) {
    if (e instanceof ClaimLost) return 'in_progress';
    if (e instanceof DomainError && e.code === 'NOT_FOUND') {
      // B1: webhook before our row committed — back to received; the poller retries (admin queue after 10 min).
      await release('received', e.message);
      return 'retry';
    }
    await release('failed', (e as Error).message.slice(0, 500));
    throw e;
  }
}

/** Apply one event inside the tenant transaction. Every enqueue carries a key derived from Stripe ids. */
async function applyStripeEvent(tx: Tx, workspaceId: string, event: Stripe.Event, obj: Record<string, unknown>): Promise<'processed'> {
  const [ws] = await tx`select state, name from workspaces where id = ${workspaceId}`;
  const ctx = sysCtx(workspaceId, ws!.state as string);
  // Mirror first (plan 05 §7): the invoice/dispute row reflects Stripe even when the side effects below no-op.
  if (INVOICE_EVENTS.includes(event.type)) await mirrorInvoice(tx, workspaceId, event, obj as unknown as InvoiceLike);
  if (DISPUTE_EVENTS.includes(event.type)) await mirrorDispute(tx, workspaceId, event, obj as unknown as DisputeLike);
  switch (event.type) {
    case 'checkout.session.completed': {
      const cs = obj as unknown as Stripe.Checkout.Session;
      if (cs.mode === 'payment') return onPaymentCompleted(tx, ctx, cs);
      if (cs.mode === 'subscription') return onSubscriptionCheckout(tx, ctx, cs);
      return 'processed';
    }
    case 'checkout.session.expired':
      await tx`update purchases set status = 'expired' where stripe_checkout_session_id = ${obj.id as string} and status = 'pending'`;
      return 'processed';
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return upsertSubscription(tx, ctx, obj as unknown as Stripe.Subscription);
    case 'customer.subscription.deleted': {
      const sub = obj as unknown as Stripe.Subscription;
      const [ended] = await tx`update subscriptions set status = 'canceled', next_payment_attempt = null
                               where stripe_subscription_id = ${sub.id} and workspace_id = ${workspaceId} and status <> 'canceled' returning id, plan_code`;
      // Churn movement (plan 05 §7 revenue): the plan's MRR leaves when the subscription ends, not when it's scheduled.
      if (ended) await emit(tx, ctx, 'SUBSCRIPTION_ENDED', { type: 'subscription', id: ended.id as string }, { plan: ended.plan_code as string, stripeSubscriptionId: sub.id, reason: (sub as unknown as { cancellation_details?: { reason?: string | null } }).cancellation_details?.reason ?? null });
      await tx`update workspaces set plan_code = null where id = ${workspaceId}`;
      if (['ACTIVE_PAID', 'PAST_DUE'].includes(ws!.state as string)) await transitionWorkspace(tx, ctx, 'CANCELLED', 'subscription ended');
      await enqueue(tx, workspaceId, Queues.sendEmail, { template: 'cancellation_confirmed', subscriptionId: sub.id }, { singletonKey: `cancelled:${sub.id}` });
      return 'processed';
    }
    case 'invoice.paid':
      return onInvoicePaid(tx, ctx, obj as unknown as Stripe.Invoice);
    case 'invoice.payment_failed': {
      if (ws!.state === 'ACTIVE_PAID') await transitionWorkspace(tx, ctx, 'PAST_DUE', 'invoice payment failed');
      // Dunning view (plan 05 §7 "retry schedule"): Stripe's attempt count and next retry (null = no more retries).
      // A late, older event (lower attempt count) never overwrites a newer schedule.
      const inv = obj as { attempt_count?: number | null; next_payment_attempt?: number | null };
      const attempt = Math.max(1, Number(inv.attempt_count ?? 1));
      await tx`update subscriptions set status = 'past_due',
                 next_payment_attempt = case when ${attempt} >= payment_attempt_count then ${unix(inv.next_payment_attempt)} else next_payment_attempt end,
                 payment_attempt_count = greatest(payment_attempt_count, ${attempt})
               where stripe_subscription_id = ${subscriptionIdOf(obj as never)} and workspace_id = ${workspaceId}`;
      await enqueue(tx, workspaceId, Queues.sendEmail, { template: 'payment_failed' }, { singletonKey: `payfail:${event.id}` });
      return 'processed';
    }
    case 'charge.refunded': {
      // Refunds made from the console are already on file; anything else (Stripe dashboard) is recorded
      // here with the same bookkeeping: mirror row, partial amounts, CREDIT_REFUNDED (B9 credit withdrawal).
      const ch = obj as unknown as Stripe.Charge;
      await recordChargeRefund(tx, ctx, { id: ch.id, payment_intent: (ch.payment_intent as string) ?? null, amount_refunded: ch.amount_refunded ?? null, refunded: ch.refunded ?? null });
      return 'processed';
    }
    case 'charge.dispute.created':
      // Lock a live workspace; one already on hold or being purged keeps that state (and the event still processes).
      if (['ACTIVE_FREE', 'ACTIVE_PAID', 'PAST_DUE', 'CANCELLED'].includes(ws!.state as string)) await transitionWorkspace(tx, ctx, 'LOCKED', 'chargeback opened');
      return 'processed';
    case 'charge.dispute.closed': {
      const d = obj as unknown as Stripe.Dispute;
      if (d.status === 'won' && ws!.state === 'LOCKED') {
        const [w] = await tx`select state_before_hold from workspaces where id = ${workspaceId}`;
        if (w?.state_before_hold) await transitionWorkspace(tx, ctx, w.state_before_hold as never, 'dispute won');
      }
      return 'processed';
    }
  }
  return 'processed';
}

/**
 * Plan 05 §6 edge case: "Stripe Price archived while an offer references it → offer auto-pauses and alerts". Every
 * offer version charging that Price is paused (and can't be reactivated until the Price is restored or a new
 * version is created); an archived plan or one-off Price configured in env raises an alert too. Restoring the Price
 * only lifts the block: reactivating stays a staff decision. System role: offer definitions are platform config.
 */
export async function onPriceChanged(tx: Tx, type: string, price: { id: string; active?: boolean | null }) {
  const archived = type === 'price.deleted' || price.active === false;
  if (!archived) {
    await tx`update offer_definitions set stripe_price_archived_at = null, updated_at = now() where stripe_price_id = ${price.id} and stripe_price_archived_at is not null`;
    return { paused: [] as string[] };
  }
  const how = type === 'price.deleted' ? 'deleted' : 'archived';
  const offers = await tx`select code, active from offer_definitions where stripe_price_id = ${price.id} order by code for update`;
  const paused: string[] = [];
  for (const o of offers) {
    await tx`update offer_definitions set active = false, stripe_price_archived_at = coalesce(stripe_price_archived_at, now()),
               paused_reason = case when active then ${`Stripe Price ${price.id} ${how}`} else paused_reason end, updated_at = now()
             where code = ${o.code}`;
    if (!o.active) continue;
    paused.push(o.code as string);
    await raiseAlert(tx, {
      kind: 'offer.stripe_price_archived',
      severity: 'risk',
      subject: { type: 'offer', id: o.code as string },
      message: `${o.code as string} auto-paused: its Stripe Price ${price.id} was ${how}. Create a new version with a live Price.`,
      details: { priceId: price.id, event: type },
    });
  }
  const configured = (['TASTE', 'STANDALONE', 'LAUNCH', 'GROWTH', 'SCALE'] as const).find((c) => priceIdFor(c) === price.id);
  if (configured) {
    await raiseAlert(tx, { kind: 'stripe.configured_price_archived', severity: 'risk', subject: { type: 'stripe_price', id: price.id }, message: `The Stripe Price configured for ${configured} (${price.id}) was ${how}; checkouts that use it will fail. Update STRIPE_PRICE_${configured}.`, details: { code: configured } });
  }
  return { paused };
}

function subscriptionIdOf(inv: { subscription?: string | { id: string } | null; parent?: { subscription_details?: { subscription?: string } } }) {
  if (typeof inv.subscription === 'string') return inv.subscription;
  if (inv.subscription && typeof inv.subscription === 'object') return inv.subscription.id;
  return inv.parent?.subscription_details?.subscription ?? null;
}

async function onPaymentCompleted(tx: Tx, ctx: TenantContext, cs: Stripe.Checkout.Session): Promise<'processed'> {
  const [pu] = await tx`select * from purchases where stripe_checkout_session_id = ${cs.id} for update`;
  if (!pu) throw new DomainError('NOT_FOUND', 'purchase row not committed yet');
  if (pu.status === 'paid') return 'processed';
  if (cs.payment_status !== 'paid') return 'processed';
  // Two sessions for one project completing at once (B4) are serialized on the project: exactly one grants.
  await tx`select 1 from projects where id = ${pu.project_id} for update`;
  const [otherPaid] = await tx`select id from purchases where project_id = ${pu.project_id} and status = 'paid' and id <> ${pu.id}`;
  await tx`update purchases set status = 'paid', paid_at = now(), stripe_payment_intent_id = ${(cs.payment_intent as string) ?? null} where id = ${pu.id}`;
  if (otherPaid) {
    // B4: two tabs both paid — refund the second automatically (idempotent on the session) and record it.
    if (cs.payment_intent) {
      const refundId = await billingGateway().refund(cs.payment_intent as string, undefined, `dup:${cs.id}`);
      const [row] = await tx`insert into refunds (workspace_id, purchase_id, payment_intent_id, amount_micros, reason_code, customer_note, idempotency_key)
                             values (${ctx.workspaceId}, ${pu.id}, ${cs.payment_intent as string}, ${pu.amount_micros}, 'duplicate', 'Second payment for the same ad', ${`dup:${cs.id}`})
                             on conflict (workspace_id, idempotency_key) do nothing returning id`;
      if (row) await applySucceededRefund(tx, ctx, row.id as string, refundId);
    }
    return 'processed';
  }
  const unit = pu.kind as 'taste' | 'standalone';
  await append(tx, ctx, { type: 'CREDIT_GRANTED', unit, amount: 1, projectId: pu.project_id as string, reference: cs.id, idempotencyKey: `pay:${cs.id}` });
  if (pu.offer_id) await redeemOffer(tx, ctx, pu.offer_id as string);
  if (ctx.workspaceState === 'ACTIVE_FREE') await transitionWorkspace(tx, ctx, 'ACTIVE_PAID', 'one-off purchase');
  await approveForProduction(tx, { ...ctx, workspaceState: 'ACTIVE_PAID' }, pu.project_id as string, unit);
  await emit(tx, ctx, 'TASTE_PAID', { type: 'project', id: pu.project_id as string }, { kind: unit, amountMicros: Number(pu.amount_micros) });
  await recordFunnel('TASTE_PAID', { workspaceId: ctx.workspaceId, visitorId: await projectVisitor(tx, ctx.workspaceId, pu.project_id as string), props: { kind: unit } }, tx);
  await enqueue(tx, ctx.workspaceId, Queues.sendEmail, { template: 'receipt', purchaseId: pu.id }, { singletonKey: `receipt:${pu.id}` });
  return 'processed';
}

async function onSubscriptionCheckout(tx: Tx, ctx: TenantContext, cs: Stripe.Checkout.Session): Promise<'processed'> {
  const plan = (cs.metadata?.plan as PlanCode) ?? null;
  const consentId = cs.metadata?.consent_record_id ?? null;
  const subId = typeof cs.subscription === 'string' ? cs.subscription : (cs.subscription?.id ?? null);
  if (!plan || !consentId || !subId) return 'processed';
  const [subRow] = await tx`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, consent_record_id, current_period_start, current_period_end)
           values (${ctx.workspaceId}, ${subId}, ${plan}, 'active', ${consentId}, now(), now() + interval '1 month')
           on conflict (stripe_subscription_id) do update set plan_code = excluded.plan_code, consent_record_id = excluded.consent_record_id
           returning id`;
  await tx`update workspaces set plan_code = ${plan} where id = ${ctx.workspaceId}`;
  if (ctx.workspaceState !== 'ACTIVE_PAID') await transitionWorkspace(tx, ctx, 'ACTIVE_PAID', 'subscription started');
  await emit(tx, ctx, 'SUBSCRIPTION_STARTED', { type: 'subscription', id: subRow!.id as string }, { plan, stripeSubscriptionId: subId });
  await recordFunnel('SUBSCRIPTION_STARTED', { workspaceId: ctx.workspaceId, visitorId: await workspaceVisitor(tx, ctx.workspaceId), props: { plan } }, tx);
  await enqueue(tx, ctx.workspaceId, Queues.sendEmail, { template: 'subscription_started', plan }, { singletonKey: `sub-started:${subId}` });
  return 'processed';
}

async function upsertSubscription(tx: Tx, ctx: TenantContext, sub: Stripe.Subscription): Promise<'processed'> {
  const item = sub.items?.data?.[0];
  // The Price identifies the plan; checkout metadata is only a fallback (it keeps the plan the customer started on).
  const pricedPlan = (Object.keys(PLANS) as PlanCode[]).find((p) => priceIdFor(p) && priceIdFor(p) === item?.price?.id) ?? null;
  const planFromPrice = pricedPlan ?? ((sub.metadata?.plan as PlanCode) || null);
  const periodStart = (item as unknown as { current_period_start?: number })?.current_period_start ?? (sub as unknown as { current_period_start?: number }).current_period_start;
  const periodEnd = (item as unknown as { current_period_end?: number })?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  const [existing] = await tx`select id, plan_code from subscriptions where stripe_subscription_id = ${sub.id}`;
  if (!existing) return 'processed'; // created via checkout handler (consent linkage); nothing to update yet
  await tx`update subscriptions set status = ${sub.status}, cancel_at_period_end = ${sub.cancel_at_period_end},
             plan_code = coalesce(${planFromPrice}, plan_code),
             current_period_start = coalesce(to_timestamp(${periodStart ?? null}), current_period_start),
             current_period_end = coalesce(to_timestamp(${periodEnd ?? null}), current_period_end)
           where id = ${existing.id}`;
  if (pricedPlan && pricedPlan !== existing.plan_code) {
    // A plan change made in Stripe itself (dashboard, portal) is an MRR movement like one made here.
    await tx`update workspaces set plan_code = ${pricedPlan} where id = ${ctx.workspaceId} and plan_code is distinct from ${pricedPlan}`;
    await emit(tx, ctx, 'SUBSCRIPTION_CHANGED', { type: 'subscription', id: existing.id as string }, { from: existing.plan_code as string, to: pricedPlan, effective: 'now', source: 'stripe' });
  }
  if (sub.status === 'active' && ctx.workspaceState === 'PAST_DUE') await transitionWorkspace(tx, ctx, 'ACTIVE_PAID', 'payment recovered');
  return 'processed';
}

/** New billing period → grant this period's Creative Tests, expire the previous period's leftovers. */
async function onInvoicePaid(tx: Tx, ctx: TenantContext, inv: Stripe.Invoice): Promise<'processed'> {
  const subId = subscriptionIdOf(inv as never);
  if (!subId) return 'processed';
  const [s] = await tx`select * from subscriptions where stripe_subscription_id = ${subId}`;
  if (!s) throw new DomainError('NOT_FOUND', 'subscription row not committed yet');
  const line = inv.lines?.data?.[0] as unknown as { period?: { start: number; end: number } } | undefined;
  const start = new Date((line?.period?.start ?? Math.floor(Date.now() / 1000)) * 1000);
  const end = new Date((line?.period?.end ?? Math.floor(Date.now() / 1000) + 30 * 86400) * 1000);
  let plan = s.plan_code as PlanCode;
  if (s.pending_plan_code && (inv as unknown as { billing_reason?: string }).billing_reason === 'subscription_cycle') {
    // B7: downgrade takes effect at the period boundary.
    plan = s.pending_plan_code as PlanCode;
    await billingGateway().changeSubscriptionPrice(subId, priceIdFor(plan) ?? `price_${plan}`, false);
    await tx`update subscriptions set plan_code = ${plan}, pending_plan_code = null where id = ${s.id}`;
    await tx`update workspaces set plan_code = ${plan} where id = ${ctx.workspaceId}`;
    // The scheduled downgrade takes effect now: this is when its MRR contraction happens (plan 05 §7).
    if (plan !== s.plan_code) await emit(tx, ctx, 'SUBSCRIPTION_CHANGED', { type: 'subscription', id: s.id as string }, { from: s.plan_code as string, to: plan, effective: 'applied' });
  }
  const periodKey = start.toISOString().slice(0, 10);
  const prev = s.current_period_start ? new Date(s.current_period_start as string).toISOString().slice(0, 10) : null;
  if (prev && prev !== periodKey) await expirePeriod(tx, ctx, prev);
  await tx`update subscriptions set status = 'active', current_period_start = ${start}, current_period_end = ${end}, next_payment_attempt = null, payment_attempt_count = 0 where id = ${s.id}`;
  const already = await periodUsage(tx, periodKey);
  if (already.granted === 0) {
    await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: PLANS[plan].creativeTestsPerMonth, periodKey, reference: inv.id, idempotencyKey: `grant:${subId}:${periodKey}` });
  }
  if (ctx.workspaceState === 'PAST_DUE' || ctx.workspaceState === 'ACTIVE_FREE' || ctx.workspaceState === 'CANCELLED') await transitionWorkspace(tx, ctx, 'ACTIVE_PAID', 'invoice paid');
  return 'processed';
}

// ───────────── Quality guarantee (plan 04 L12, plan 03 P7) ─────────────

/**
 * Worker job `refund-purchase`, queued in the same transaction that failed a paid Taste/Standalone production:
 * "if we can't deliver an ad that passes our checks, you're refunded automatically". Ordered so it is safe to
 * retry at any point, and booked through the same refund mirror as console and Stripe-initiated refunds:
 * (1) the project moves to REFUNDED (so it can no longer be retried and delivered) and a pending `refunds` row
 *     is committed, so a charge.refunded webhook arriving mid-way finds the refund already on file;
 * (2) Stripe refunds with the same idempotency key;
 * (3) the mirror row, the purchase, the CREDIT_REFUNDED ledger entry and the email follow in one transaction.
 * The failed production already returned the entitlement, so it is taken back out: money or credit, never both.
 */
export async function refundProjectPurchase(ctx: TenantContext, purchaseId: string, reason = 'guarantee'): Promise<'refunded' | 'skipped'> {
  const ws = ctx.workspaceId;
  const idem = `guarantee:${purchaseId}`;
  const pu = await withTenant(ws, async (tx) => {
    const [row] = await tx`select pu.*, p.state from purchases pu join projects p on p.id = pu.project_id
                           where pu.id = ${purchaseId} and pu.workspace_id = ${ws} for update of p`;
    if (!row || row.status !== 'paid' || !['PROVIDER_FAILED', 'REFUNDED'].includes(row.state as string)) return null;
    await transition(tx, ctx, row.project_id as string, 'REFUNDED', { from: 'PROVIDER_FAILED', reason: 'Refunded automatically: this ad didn’t pass our quality checks.' });
    const remaining = Number(row.amount_micros) - Number(row.refunded_micros ?? 0);
    if (row.stripe_payment_intent_id && remaining > 0) {
      await tx`insert into refunds (workspace_id, purchase_id, payment_intent_id, amount_micros, reason_code, customer_note, idempotency_key)
               values (${ws}, ${purchaseId}, ${row.stripe_payment_intent_id as string}, ${remaining}, 'service_failure', 'Quality guarantee: the ad did not pass our checks', ${idem})
               on conflict (workspace_id, idempotency_key) do nothing`;
    }
    return row;
  });
  if (!pu) return 'skipped';
  const [mirror] = await withTenant(ws, (tx) => tx`select id from refunds where workspace_id = ${ws} and idempotency_key = ${idem}`);
  const refundId = mirror ? await billingGateway().refund(pu.stripe_payment_intent_id as string, undefined, idem) : null;
  const done = await withTenant(ws, async (tx) => {
    if (mirror) {
      const r = await applySucceededRefund(tx, ctx, mirror.id as string, refundId);
      if (r.replayed) return false;
    } else {
      // No captured payment on record: nothing goes back through Stripe, only the entitlement is withdrawn.
      const [upd] = await tx`update purchases set status = 'refunded', refunded_at = now() where id = ${purchaseId} and status = 'paid' returning id`;
      if (!upd) return false;
      const [consumed] = await tx`select 1 from ledger_entries where workspace_id = ${ws} and project_id = ${pu.project_id} and type = 'CREDIT_CONSUMED' limit 1`;
      await append(tx, ctx, { type: 'CREDIT_REFUNDED', unit: pu.kind as 'taste' | 'standalone', amount: consumed ? 0 : -1, projectId: pu.project_id as string, idempotencyKey: `refund:purchase:${purchaseId}`, reference: idem, reason: 'Guarantee refund: payment returned instead of the credit' });
    }
    await emit(tx, ctx, 'CREDIT_REFUNDED', { type: 'project', id: pu.project_id as string }, { purchaseId, amountMicros: Number(pu.amount_micros), refundId, reason });
    await enqueue(tx, ws, Queues.sendEmail, { template: 'refund_issued', purchaseId }, { singletonKey: `refund-email:${purchaseId}` });
    return true;
  });
  return done ? 'refunded' : 'skipped';
}

// ───────────── Mock checkout (dev/test) ─────────────

/** Simulates Stripe completing a session: emits the same events Stripe would, through the same pipeline. */
export async function completeMockCheckout(sessionId: string): Promise<string[]> {
  const gw = billingGateway() as MockStripe;
  if (gw.live) throw new DomainError('FORBIDDEN', 'Mock checkout is disabled when Stripe is configured.');
  const s = gw.sessions.get(sessionId);
  if (!s) throw new DomainError('NOT_FOUND', 'Checkout session not found');
  if (s.status === 'expired' || s.expiresAt < new Date()) throw new DomainError('CONFLICT', 'This checkout expired.');
  s.status = 'complete';
  const ids: string[] = [];
  const evt = (type: string, object: Record<string, unknown>) => ({ id: `evt_mock_${Math.random().toString(16).slice(2)}`, type, data: { object }, created: Math.floor(Date.now() / 1000) });
  const events =
    s.mode === 'payment'
      ? [evt('checkout.session.completed', { id: s.id, mode: 'payment', payment_status: 'paid', customer: s.customerId, metadata: s.metadata, payment_intent: `pi_mock_${s.id.slice(-8)}` })]
      : (() => {
          const subId = `sub_mock_${s.id.slice(-10)}`;
          const now = Math.floor(Date.now() / 1000);
          return [
            evt('checkout.session.completed', { id: s.id, mode: 'subscription', customer: s.customerId, metadata: s.metadata, subscription: subId }),
            evt('invoice.paid', { id: `in_mock_${s.id.slice(-8)}`, customer: s.customerId, subscription: subId, billing_reason: 'subscription_create', amount_paid: s.amountCents ?? 0, payment_intent: `pi_mock_in_${s.id.slice(-8)}`, lines: { data: [{ period: { start: now, end: now + 30 * 86400 } }] } }),
          ];
        })();
  // What Stripe now holds, for the nightly reconciliation: the charge, and for a plan the subscription.
  const now = Math.floor(Date.now() / 1000);
  const first = events[0]!.data.object as Record<string, unknown>;
  if (s.mode === 'payment') {
    gw.charges.push({ id: `ch_mock_${s.id.slice(-8)}`, customerId: s.customerId, paymentIntentId: first.payment_intent as string, amountCents: s.amountCents ?? 0, amountRefundedCents: 0, status: 'succeeded', disputed: false, created: now });
  } else {
    const inv = events[1]!.data.object as Record<string, unknown>;
    gw.subscriptions.push({ id: first.subscription as string, customerId: s.customerId, status: 'active', priceId: s.priceId ?? null, cancelAtPeriodEnd: false, currentPeriodEnd: now + 30 * 86400 });
    gw.charges.push({ id: `ch_mock_in_${s.id.slice(-8)}`, customerId: s.customerId, paymentIntentId: inv.payment_intent as string, amountCents: s.amountCents ?? 0, amountRefundedCents: 0, status: 'succeeded', disputed: false, created: now });
  }
  for (const e of events) {
    const r = await receiveStripeWebhook(JSON.stringify(e), null);
    await processStripeEvent(r.id);
    ids.push(r.id);
  }
  return ids;
}
