import { withSystem } from '@arkiv/db';
import type { PlanCode } from '@arkiv/shared';
import { billingGateway, priceIdFor, type StripeChargeRecord, type StripeCustomerRecord, type StripeSubscriptionRecord } from './gateway';

/**
 * Nightly full Stripe reconciliation (plan 05 §7 "Stripe mirror … synced by webhook and a nightly full
 * reconciliation"). Webhooks can be lost, delayed past our retries, or bypassed (changes made in the Stripe
 * dashboard); this compares everything Stripe holds — customers, subscriptions and recent charges — with our
 * mirror and records each difference as an exception for FINANCE. A difference that disappears (a late webhook
 * arrived, staff fixed it) is resolved by the next run. Read-only toward Stripe and toward tenant data.
 */

/** Charges are compared over this window (older ones were reconciled by earlier runs). */
export const RECON_CHARGE_WINDOW_DAYS = 35;

export interface LocalMirror {
  customers: { customerId: string; workspaceId: string }[];
  subscriptions: { id: string; workspaceId: string; status: string; plan: string; cancelAtPeriodEnd: boolean }[];
  /** Paid (or refunded) one-off purchases in the window. */
  purchases: { paymentIntentId: string; workspaceId: string; amountMicros: number; refundedMicros: number; status: string; paidAt: Date }[];
  /** Mirrored invoices with a payment. */
  invoices: { paymentIntentId: string; workspaceId: string; amountPaidCents: number }[];
  /** Succeeded refunds per payment intent (console, guarantee and Stripe-initiated). */
  refunds: { paymentIntentId: string; refundedMicros: number }[];
  disputes: { paymentIntentId: string }[];
}

export interface StripeState {
  customers: StripeCustomerRecord[];
  subscriptions: StripeSubscriptionRecord[];
  charges: StripeChargeRecord[];
}

export interface ReconException {
  kind: string;
  stripeId: string;
  workspaceId: string | null;
  detail: Record<string, unknown>;
}

/** Kinds whose objects every run re-lists in full (so a missing exception means it's fixed). */
export const FULL_SCOPE_KINDS = ['customer_unknown', 'customer_missing', 'customer_workspace_mismatch', 'subscription_missing', 'subscription_unknown_to_stripe', 'subscription_status_mismatch', 'subscription_plan_mismatch', 'subscription_cancel_mismatch'];

/** Stripe statuses a live subscription can have; anything else is over. */
const LIVE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

/** Pure diff of Stripe's state against our mirror. `evaluated` lists the charge-level ids this run judged. */
export function diffStripe(stripe: StripeState, local: LocalMirror, opts: { missingSince?: Date } = {}): { exceptions: ReconException[]; evaluated: string[] } {
  const out: ReconException[] = [];
  const wsOfCustomer = new Map(local.customers.map((c) => [c.customerId, c.workspaceId]));
  const stripeCustomers = new Map(stripe.customers.map((c) => [c.id, c]));
  for (const c of stripe.customers) {
    const ws = wsOfCustomer.get(c.id);
    if (!ws) out.push({ kind: 'customer_unknown', stripeId: c.id, workspaceId: c.workspaceId, detail: { metadataWorkspace: c.workspaceId } });
    else if (c.workspaceId && c.workspaceId !== ws) out.push({ kind: 'customer_workspace_mismatch', stripeId: c.id, workspaceId: ws, detail: { ours: ws, stripeMetadata: c.workspaceId } });
  }
  for (const c of local.customers) if (!stripeCustomers.has(c.customerId)) out.push({ kind: 'customer_missing', stripeId: c.customerId, workspaceId: c.workspaceId, detail: {} });

  const ours = new Map(local.subscriptions.map((s) => [s.id, s]));
  const theirs = new Map(stripe.subscriptions.map((s) => [s.id, s]));
  for (const s of stripe.subscriptions) {
    const o = ours.get(s.id);
    const ws = wsOfCustomer.get(s.customerId) ?? null;
    if (!o) {
      if (LIVE.has(s.status)) out.push({ kind: 'subscription_missing', stripeId: s.id, workspaceId: ws, detail: { status: s.status, priceId: s.priceId } });
      continue;
    }
    const norm = (x: string) => (x === 'cancelled' ? 'canceled' : x);
    if (norm(o.status) !== norm(s.status)) out.push({ kind: 'subscription_status_mismatch', stripeId: s.id, workspaceId: o.workspaceId, detail: { ours: o.status, stripe: s.status } });
    const expected = priceIdFor(o.plan as PlanCode);
    if (expected && s.priceId && expected !== s.priceId && LIVE.has(s.status)) out.push({ kind: 'subscription_plan_mismatch', stripeId: s.id, workspaceId: o.workspaceId, detail: { ours: o.plan, expectedPrice: expected, stripePrice: s.priceId } });
    if (LIVE.has(s.status) && o.cancelAtPeriodEnd !== s.cancelAtPeriodEnd) out.push({ kind: 'subscription_cancel_mismatch', stripeId: s.id, workspaceId: o.workspaceId, detail: { ours: o.cancelAtPeriodEnd, stripe: s.cancelAtPeriodEnd } });
  }
  for (const o of local.subscriptions) {
    if (!theirs.has(o.id) && o.status !== 'canceled') out.push({ kind: 'subscription_unknown_to_stripe', stripeId: o.id, workspaceId: o.workspaceId, detail: { status: o.status, plan: o.plan } });
  }

  const purchases = new Map(local.purchases.map((p) => [p.paymentIntentId, p]));
  const invoices = new Map(local.invoices.map((i) => [i.paymentIntentId, i]));
  const refunded = new Map(local.refunds.map((r) => [r.paymentIntentId, r.refundedMicros]));
  const disputes = new Set(local.disputes.map((d) => d.paymentIntentId));
  const chargedPis = new Set<string>();
  const evaluated = new Set<string>();
  for (const c of stripe.charges) {
    evaluated.add(c.id);
    if (c.paymentIntentId) {
      evaluated.add(c.paymentIntentId);
      if (c.status === 'succeeded') chargedPis.add(c.paymentIntentId);
    }
    if (c.status !== 'succeeded') continue;
    const ws = (c.customerId && wsOfCustomer.get(c.customerId)) || null;
    const p = c.paymentIntentId ? purchases.get(c.paymentIntentId) : undefined;
    const inv = c.paymentIntentId ? invoices.get(c.paymentIntentId) : undefined;
    if (!p && !inv) {
      out.push({ kind: 'charge_unmatched', stripeId: c.id, workspaceId: ws, detail: { paymentIntent: c.paymentIntentId, amountCents: c.amountCents } });
      continue;
    }
    const workspaceId = p?.workspaceId ?? inv?.workspaceId ?? ws;
    // Tax is added on top of our price, so only a charge below the price we recorded is a difference.
    if (p && c.amountCents < Math.round(p.amountMicros / 10_000)) out.push({ kind: 'charge_amount_mismatch', stripeId: c.id, workspaceId, detail: { oursCents: Math.round(p.amountMicros / 10_000), stripeCents: c.amountCents } });
    const oursRefundCents = Math.round(Math.max(p?.refundedMicros ?? 0, refunded.get(c.paymentIntentId!) ?? 0) / 10_000);
    if (oursRefundCents !== c.amountRefundedCents) out.push({ kind: 'refund_mismatch', stripeId: c.id, workspaceId, detail: { oursCents: oursRefundCents, stripeCents: c.amountRefundedCents } });
    if (c.disputed && c.paymentIntentId && !disputes.has(c.paymentIntentId)) out.push({ kind: 'dispute_unmirrored', stripeId: c.id, workspaceId, detail: { paymentIntent: c.paymentIntentId } });
  }
  for (const p of local.purchases) {
    // Purchases just before the window only match charges; they are not expected among the listed charges.
    if (opts.missingSince && p.paidAt < opts.missingSince) continue;
    evaluated.add(p.paymentIntentId);
    if (!chargedPis.has(p.paymentIntentId)) out.push({ kind: 'payment_missing_in_stripe', stripeId: p.paymentIntentId, workspaceId: p.workspaceId, detail: { status: p.status, amountMicros: p.amountMicros } });
  }
  return { exceptions: out, evaluated: [...evaluated] };
}

/** Our mirror, across tenants (system role: this is a platform-wide comparison; nothing is written to tenant rows). */
async function loadMirror(since: Date): Promise<LocalMirror> {
  return withSystem(async (tx) => ({
    customers: (await tx`select customer_id, workspace_id from stripe_customers`).map((r) => ({ customerId: r.customer_id as string, workspaceId: r.workspace_id as string })),
    subscriptions: (await tx`select stripe_subscription_id, workspace_id, status, plan_code, cancel_at_period_end from subscriptions where stripe_subscription_id is not null`).map((r) => ({
      id: r.stripe_subscription_id as string,
      workspaceId: r.workspace_id as string,
      status: r.status as string,
      plan: r.plan_code as string,
      cancelAtPeriodEnd: !!r.cancel_at_period_end,
    })),
    purchases: (await tx`select stripe_payment_intent_id, workspace_id, amount_micros, refunded_micros, status, paid_at from purchases
                         where status in ('paid','refunded') and stripe_payment_intent_id is not null and paid_at >= ${new Date(since.getTime() - 4 * 86400_000)}`).map((r) => ({
      paymentIntentId: r.stripe_payment_intent_id as string,
      workspaceId: r.workspace_id as string,
      amountMicros: Number(r.amount_micros),
      refundedMicros: Number(r.refunded_micros),
      status: r.status as string,
      paidAt: new Date(r.paid_at as string),
    })),
    invoices: (await tx`select payment_intent_id, workspace_id, amount_paid_cents from stripe_invoices where payment_intent_id is not null`).map((r) => ({ paymentIntentId: r.payment_intent_id as string, workspaceId: r.workspace_id as string, amountPaidCents: Number(r.amount_paid_cents) })),
    refunds: (await tx`select payment_intent_id, sum(amount_micros)::bigint as micros from refunds where status = 'succeeded' group by 1`).map((r) => ({ paymentIntentId: r.payment_intent_id as string, refundedMicros: Number(r.micros) })),
    disputes: (await tx`select distinct payment_intent_id from stripe_disputes where payment_intent_id is not null`).map((r) => ({ paymentIntentId: r.payment_intent_id as string })),
  }));
}

export interface ReconRun {
  runId: string;
  status: 'completed' | 'skipped' | 'failed';
  counts: Record<string, number>;
}

/**
 * One reconciliation run. Without Stripe configured (mock gateway in dev) there is nothing real to compare with, so
 * the run is recorded as skipped unless `force` (tests drive a seeded mock).
 */
export async function reconcileStripe(opts: { force?: boolean; now?: Date } = {}): Promise<ReconRun> {
  const gw = billingGateway();
  const [run] = await withSystem((tx) => tx`insert into stripe_recon_runs default values returning id`);
  const runId = run!.id as string;
  if (!gw.live && !opts.force) {
    await withSystem((tx) => tx`update stripe_recon_runs set status = 'skipped', finished_at = now(), error = 'Stripe is not configured (mock gateway)' where id = ${runId}`);
    return { runId, status: 'skipped', counts: {} };
  }
  try {
    const since = new Date((opts.now ?? new Date()).getTime() - RECON_CHARGE_WINDOW_DAYS * 86400_000);
    // Charges from two days before the window (purchases from four): a payment captured near the edge and recorded
    // by its webhook later still pairs with its charge; only purchases inside the window must appear in Stripe.
    const stripe: StripeState = { customers: await gw.listCustomers(), subscriptions: await gw.listSubscriptions(), charges: await gw.listCharges(new Date(since.getTime() - 2 * 86400_000)) };
    const local = await loadMirror(since);
    const { exceptions, evaluated } = diffStripe(stripe, local, { missingSince: since });
    const counts: Record<string, number> = { customers: stripe.customers.length, subscriptions: stripe.subscriptions.length, charges: stripe.charges.length, exceptions: exceptions.length };
    await withSystem(async (tx) => {
      let opened = 0;
      for (const e of exceptions) {
        const [row] = await tx`
          insert into stripe_recon_exceptions (run_id, kind, stripe_id, workspace_id, detail)
          values (${runId}, ${e.kind}, ${e.stripeId}, ${e.workspaceId}, ${tx.json(e.detail as never)})
          on conflict (kind, stripe_id) where resolved_at is null
          do update set run_id = excluded.run_id, last_seen_at = now(), detail = excluded.detail, workspace_id = coalesce(excluded.workspace_id, stripe_recon_exceptions.workspace_id)
          returning (xmax = 0) as inserted`;
        if (row?.inserted) opened++;
      }
      // Differences this run re-checked and no longer found are resolved.
      const cleared = await tx`
        update stripe_recon_exceptions set resolved_at = now(), resolution = ${`cleared by reconciliation ${runId.slice(0, 8)}`}
        where resolved_at is null and run_id <> ${runId}
          and (kind in ${tx(FULL_SCOPE_KINDS)} or stripe_id in ${tx(evaluated.length ? evaluated : ['-'])})
        returning id`;
      counts.opened = opened;
      counts.cleared = cleared.length;
      await tx`update stripe_recon_runs set status = 'completed', finished_at = now(), counts = ${tx.json(counts)} where id = ${runId}`;
    });
    return { runId, status: 'completed', counts };
  } catch (e) {
    await withSystem((tx) => tx`update stripe_recon_runs set status = 'failed', finished_at = now(), error = ${(e as Error).message.slice(0, 500)} where id = ${runId}`);
    throw e;
  }
}
