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

export interface BillingGateway {
  readonly live: boolean;
  createCustomer(email: string, workspaceId: string, name: string): Promise<string>;
  createCheckout(p: CheckoutParams): Promise<{ id: string; clientSecret: string | null; url: string | null }>;
  expireCheckout(id: string): Promise<void>;
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<void>;
  changeSubscriptionPrice(subscriptionId: string, priceId: string, prorate: boolean): Promise<void>;
  portalUrl(customerId: string, returnUrl: string): Promise<string>;
  refund(paymentIntentId: string, amountCents?: number): Promise<string>;
  constructEvent(raw: string | Buffer, signature: string | null): Stripe.Event;
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
  async portalUrl(customerId: string, returnUrl: string) {
    return (await this.s.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })).url;
  }
  async refund(paymentIntentId: string, amountCents?: number) {
    return (await this.s.refunds.create({ payment_intent: paymentIntentId, amount: amountCents })).id;
  }
  constructEvent(raw: string | Buffer, signature: string | null) {
    return this.s.webhooks.constructEvent(raw, signature ?? '', env().STRIPE_WEBHOOK_SECRET!);
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
  refunds: { pi: string; amount?: number }[] = [];
  async createCustomer(_email: string, workspaceId: string) {
    return `cus_mock_${workspaceId.replace(/-/g, '').slice(0, 14)}`;
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
  }
  async changeSubscriptionPrice(id: string, priceId: string, prorate: boolean) {
    this.priceChanges.push({ id, priceId, prorate });
  }
  async portalUrl(_c: string, returnUrl: string) {
    return `${returnUrl}?portal=mock`;
  }
  async refund(pi: string, amount?: number) {
    this.refunds.push({ pi, amount });
    return `re_mock_${randomBytes(4).toString('hex')}`;
  }
  constructEvent(raw: string | Buffer): Stripe.Event {
    return JSON.parse(raw.toString()) as Stripe.Event;
  }
}

let gw: BillingGateway | undefined;
export function billingGateway(): BillingGateway {
  if (!gw) gw = env().STRIPE_SECRET_KEY ? new LiveStripe() : new MockStripe();
  return gw;
}
export function setBillingGateway(g: BillingGateway | undefined) {
  gw = g;
}

export function priceIdFor(code: 'TASTE' | 'STANDALONE' | 'LAUNCH' | 'GROWTH' | 'SCALE'): string | null {
  const e = env();
  return ({ TASTE: e.STRIPE_PRICE_TASTE, STANDALONE: e.STRIPE_PRICE_STANDALONE, LAUNCH: e.STRIPE_PRICE_LAUNCH, GROWTH: e.STRIPE_PRICE_GROWTH, SCALE: e.STRIPE_PRICE_SCALE }[code] ?? null) as string | null;
}
