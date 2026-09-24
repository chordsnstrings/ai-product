import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { env } from '@arkiv/shared';

/**
 * Billing gateway: Stripe (decided). Live uses the Stripe SDK; Mock (no STRIPE_SECRET_KEY) lets dev/tests run
 * the full purchase flow — the mock checkout page synthesizes the same events Stripe would send.
 */

export interface CheckoutParams {
  mode: 'payment' | 'subscription';
  customerId: string;
  priceId?: string | null;
  amountCents?: number;
  productName: string;
  description?: string;
  metadata: Record<string, string>;
  expiresAt: Date;
  returnUrl: string;
  idempotencyKey: string;
  automaticTax: boolean;
}

/** A Stripe customer as the nightly reconciliation sees it (plan 05 §7). */
export interface StripeCustomerRecord {
  id: string;
  workspaceId: string | null;
  created: number;
}
export interface StripeSubscriptionRecord {
  id: string;
  customerId: string;
  status: string;
  priceId: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
}
export interface StripeChargeRecord {
  id: string;
  customerId: string | null;
  paymentIntentId: string | null;
  amountCents: number;
  amountRefundedCents: number;
  /** succeeded | pending | failed */
  status: string;
  disputed: boolean;
  created: number;
}

/** Evidence fields submitted with a dispute response (a subset of Stripe's dispute evidence, all text). */
export interface DisputeEvidence {
  product_description?: string;
  customer_email_address?: string;
  customer_name?: string;
  customer_purchase_ip?: string;
  service_date?: string;
  access_activity_log?: string;
  service_documentation?: string;
  refund_policy?: string;
  refund_policy_disclosure?: string;
  uncategorized_text?: string;
}

export interface BillingGateway {
  readonly live: boolean;
  createCustomer(email: string, workspaceId: string, name: string): Promise<string>;
  createCheckout(p: CheckoutParams): Promise<{ id: string; clientSecret: string | null; url: string | null }>;
  expireCheckout(id: string): Promise<void>;
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<void>;
  changeSubscriptionPrice(subscriptionId: string, priceId: string, prorate: boolean): Promise<void>;
  /** Apply a Stripe coupon to a subscription (replaces its current discount). */
  applyCoupon(subscriptionId: string, coupon: string): Promise<void>;
  portalUrl(customerId: string, returnUrl: string): Promise<string>;
  /** Refund a payment. The idempotency key makes a retried request return the same refund (never a second one). */
  refund(paymentIntentId: string, amountCents?: number, idempotencyKey?: string): Promise<string>;
  constructEvent(raw: string | Buffer, signature: string | null): Stripe.Event;
  /** Full lists for the nightly reconciliation (auto-paging). Charges are listed from `since`. */
  listCustomers(): Promise<StripeCustomerRecord[]>;
  listSubscriptions(): Promise<StripeSubscriptionRecord[]>;
  listCharges(since: Date): Promise<StripeChargeRecord[]>;
  /** Submit the evidence pack for a dispute (final: Stripe forwards it to the card network). */
  submitDisputeEvidence(disputeId: string, evidence: DisputeEvidence, idempotencyKey: string): Promise<void>;
}

class LiveStripe implements BillingGateway {
  readonly live = true;
  private s = new Stripe(env().STRIPE_SECRET_KEY!, { maxNetworkRetries: 2 });
  async createCustomer(email: string, workspaceId: string, name: string) {
    const c = await this.s.customers.create({ email, name, metadata: { workspace_id: workspaceId } }, { idempotencyKey: `cust:${workspaceId}` });
    return c.id;
  }
  async createCheckout(p: CheckoutParams) {
    const line: Stripe.Checkout.SessionCreateParams.LineItem = p.priceId
      ? { price: p.priceId, quantity: 1 }
      : { price_data: { currency: 'usd', unit_amount: p.amountCents!, product_data: { name: p.productName, description: p.description } }, quantity: 1 };
    const cs = await this.s.checkout.sessions.create(
      {
        mode: p.mode,
        ui_mode: 'embedded',
        customer: p.customerId,
        line_items: [line],
        metadata: p.metadata,
        ...(p.mode === 'subscription' ? { subscription_data: { metadata: p.metadata } } : { payment_intent_data: { metadata: p.metadata } }),
        expires_at: Math.floor(p.expiresAt.getTime() / 1000),
        return_url: p.returnUrl,
        automatic_tax: { enabled: p.automaticTax },
        customer_update: p.automaticTax ? { address: 'auto' } : undefined,
      },
      { idempotencyKey: p.idempotencyKey },
    );
    return { id: cs.id, clientSecret: cs.client_secret ?? null, url: cs.url ?? null };
  }
  async expireCheckout(id: string) {
    await this.s.checkout.sessions.expire(id).catch(() => {});
  }
  async setCancelAtPeriodEnd(id: string, cancel: boolean) {
    await this.s.subscriptions.update(id, { cancel_at_period_end: cancel });
  }
  async changeSubscriptionPrice(id: string, priceId: string, prorate: boolean) {
    const sub = await this.s.subscriptions.retrieve(id);
    await this.s.subscriptions.update(id, {
      items: [{ id: sub.items.data[0]!.id, price: priceId }],
      proration_behavior: prorate ? 'always_invoice' : 'none',
    });
  }
  async applyCoupon(id: string, coupon: string) {
    await this.s.subscriptions.update(id, { discounts: [{ coupon }] }, { idempotencyKey: `coupon:${id}:${coupon}` });
  }
  async portalUrl(customerId: string, returnUrl: string) {
    return (await this.s.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })).url;
  }
  async refund(paymentIntentId: string, amountCents?: number, idempotencyKey?: string) {
    return (await this.s.refunds.create({ payment_intent: paymentIntentId, amount: amountCents }, idempotencyKey ? { idempotencyKey } : undefined)).id;
  }
  constructEvent(raw: string | Buffer, signature: string | null) {
    return this.s.webhooks.constructEvent(raw, signature ?? '', env().STRIPE_WEBHOOK_SECRET!);
  }
  async listCustomers() {
    const out: StripeCustomerRecord[] = [];
    for await (const c of this.s.customers.list({ limit: 100 })) out.push({ id: c.id, workspaceId: c.metadata?.workspace_id ?? null, created: c.created });
    return out;
  }
  async listSubscriptions() {
    const out: StripeSubscriptionRecord[] = [];
    for await (const sub of this.s.subscriptions.list({ status: 'all', limit: 100 })) {
      const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
      out.push({
        id: sub.id,
        customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
        status: sub.status,
        priceId: item?.price?.id ?? null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodEnd: item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end ?? null,
      });
    }
    return out;
  }
  async listCharges(since: Date) {
    const out: StripeChargeRecord[] = [];
    for await (const c of this.s.charges.list({ created: { gte: Math.floor(since.getTime() / 1000) }, limit: 100 })) {
      out.push({
        id: c.id,
        customerId: typeof c.customer === 'string' ? c.customer : (c.customer?.id ?? null),
        paymentIntentId: typeof c.payment_intent === 'string' ? c.payment_intent : (c.payment_intent?.id ?? null),
        amountCents: c.amount,
        amountRefundedCents: c.amount_refunded,
        status: c.status,
        disputed: c.disputed,
        created: c.created,
      });
    }
    return out;
  }
  async submitDisputeEvidence(disputeId: string, evidence: DisputeEvidence, idempotencyKey: string) {
    await this.s.disputes.update(disputeId, { evidence, submit: true }, { idempotencyKey });
  }
}

export interface MockSession extends CheckoutParams {
  id: string;
  status: 'open' | 'complete' | 'expired';
}

/** In-memory Stripe stand-in. Sessions complete via `completeMockCheckout` (mock checkout page / tests). */
export class MockStripe implements BillingGateway {
  readonly live = false;
  sessions = new Map<string, MockSession>();
  cancelFlags = new Map<string, boolean>();
  priceChanges: { id: string; priceId: string; prorate: boolean }[] = [];
  coupons: { id: string; coupon: string }[] = [];
  refunds: { pi: string; amount?: number; id: string; idempotencyKey?: string }[] = [];
  // What Stripe holds, for the nightly reconciliation: customers, subscriptions and charges this mock created
  // (tests may add or edit rows to simulate drift).
  customers: StripeCustomerRecord[] = [];
  subscriptions: StripeSubscriptionRecord[] = [];
  charges: StripeChargeRecord[] = [];
  disputeSubmissions: { disputeId: string; evidence: DisputeEvidence; idempotencyKey: string }[] = [];
  async createCustomer(_email: string, workspaceId: string) {
    const id = `cus_mock_${workspaceId.replace(/-/g, '').slice(0, 14)}`;
    if (!this.customers.some((c) => c.id === id)) this.customers.push({ id, workspaceId, created: Math.floor(Date.now() / 1000) });
    return id;
  }
  async createCheckout(p: CheckoutParams) {
    const existing = [...this.sessions.values()].find((s) => s.idempotencyKey === p.idempotencyKey);
    if (existing) return { id: existing.id, clientSecret: `mock_secret_${existing.id}`, url: `${env().APP_URL}/checkout/mock/${existing.id}` };
    const id = `cs_mock_${randomBytes(8).toString('hex')}`;
    this.sessions.set(id, { ...p, id, status: 'open' });
    return { id, clientSecret: `mock_secret_${id}`, url: `${env().APP_URL}/checkout/mock/${id}` };
  }
  async expireCheckout(id: string) {
    const s = this.sessions.get(id);
    if (s && s.status === 'open') s.status = 'expired';
  }
  async setCancelAtPeriodEnd(id: string, cancel: boolean) {
    this.cancelFlags.set(id, cancel);
    const sub = this.subscriptions.find((x) => x.id === id);
    if (sub) sub.cancelAtPeriodEnd = cancel;
  }
  async changeSubscriptionPrice(id: string, priceId: string, prorate: boolean) {
    this.priceChanges.push({ id, priceId, prorate });
    const sub = this.subscriptions.find((x) => x.id === id);
    if (sub) sub.priceId = priceId;
  }
  async applyCoupon(id: string, coupon: string) {
    this.coupons.push({ id, coupon });
  }
  async portalUrl(_c: string, returnUrl: string) {
    return `${returnUrl}?portal=mock`;
  }
  async refund(pi: string, amount?: number, idempotencyKey?: string) {
    // Same semantics as Stripe's Idempotency-Key: a replay returns the original refund.
    const prior = idempotencyKey ? this.refunds.find((r) => r.idempotencyKey === idempotencyKey) : undefined;
    if (prior) return prior.id;
    const id = `re_mock_${randomBytes(4).toString('hex')}`;
    this.refunds.push({ pi, amount, id, idempotencyKey });
    const charge = this.charges.find((c) => c.paymentIntentId === pi);
    if (charge) charge.amountRefundedCents = Math.min(charge.amountCents, charge.amountRefundedCents + (amount ?? charge.amountCents - charge.amountRefundedCents));
    return id;
  }
  constructEvent(raw: string | Buffer): Stripe.Event {
    return JSON.parse(raw.toString()) as Stripe.Event;
  }
  async listCustomers() {
    return this.customers.map((c) => ({ ...c }));
  }
  async listSubscriptions() {
    return this.subscriptions.map((x) => ({ ...x }));
  }
  async listCharges(since: Date) {
    return this.charges.filter((c) => c.created >= Math.floor(since.getTime() / 1000)).map((c) => ({ ...c }));
  }
  async submitDisputeEvidence(disputeId: string, evidence: DisputeEvidence, idempotencyKey: string) {
    if (this.disputeSubmissions.some((d) => d.idempotencyKey === idempotencyKey)) return;
    this.disputeSubmissions.push({ disputeId, evidence, idempotencyKey });
  }
}

// Held on globalThis so every bundle layer in one process (Next route handlers + server components) shares the
// same instance — the mock's in-memory sessions depend on it.
const slot = globalThis as { __arkivBilling?: BillingGateway };
export function billingGateway(): BillingGateway {
  if (!slot.__arkivBilling) slot.__arkivBilling = env().STRIPE_SECRET_KEY ? new LiveStripe() : new MockStripe();
  return slot.__arkivBilling;
}
export function setBillingGateway(g: BillingGateway | undefined) {
  slot.__arkivBilling = g;
}

export function priceIdFor(code: 'TASTE' | 'STANDALONE' | 'LAUNCH' | 'GROWTH' | 'SCALE'): string | null {
  const e = env();
  return ({ TASTE: e.STRIPE_PRICE_TASTE, STANDALONE: e.STRIPE_PRICE_STANDALONE, LAUNCH: e.STRIPE_PRICE_LAUNCH, GROWTH: e.STRIPE_PRICE_GROWTH, SCALE: e.STRIPE_PRICE_SCALE }[code] ?? null) as string | null;
}
