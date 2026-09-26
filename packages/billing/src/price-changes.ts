import { withSystem, type Tx } from '@arkiv/db';
import { emit, planPriceAt, subscriptionPrice, systemContext } from '@arkiv/core';
import type { PlanCode } from '@arkiv/shared';
import { billingGateway, priceIdFor } from './gateway';

/**
 * The Stripe price a plan is sold at now: the current plan_prices version's, else the configured one. Pricing and
 * checkout use it so a scheduled change reaches new subscribers on its effective date.
 */
export async function currentStripePrice(tx: Tx, plan: PlanCode): Promise<{ priceId: string | null; priceMicros: number }> {
  const p = await planPriceAt(tx, plan);
  return { priceId: p.stripePriceId ?? priceIdFor(plan), priceMicros: p.priceMicros };
}

/** The Stripe price a subscription is billed at (its applied price change, else its plan's configured price). */
export async function subscriptionStripePrice(tx: Tx, sub: { id: string; workspaceId: string; planCode: PlanCode; createdAt: Date | string }): Promise<string> {
  const p = await subscriptionPrice(tx, sub);
  return p.stripePriceId ?? priceIdFor(sub.planCode) ?? `price_${sub.planCode}`;
}

/**
 * Plan 04 §3 price changes, the switch (system sweep): each notified change whose date has come is applied by
 * moving the subscription's Stripe price without proration, so the customer's next renewal is the first one at the
 * new price. A subscription that ended, moved plan, or has a downgrade scheduled (Stripe already holds the lower
 * plan's price) is closed without a switch. Every query names the workspace (system role).
 */
export async function applyDuePriceChanges(): Promise<number> {
  const due = await withSystem((tx) => tx`select n.id, n.workspace_id, n.subscription_id, n.plan_code, n.plan_price_id, n.old_price_micros, n.new_price_micros
                                          from price_change_notices n where n.applied_at is null and n.effective_from <= now() order by n.effective_from limit 200`);
  let applied = 0;
  for (const n of due) {
    const ws = n.workspace_id as string;
    await withSystem(async (tx) => {
      const [locked] = await tx`select applied_at from price_change_notices where id = ${n.id as string} and workspace_id = ${ws} for update`;
      if (!locked || locked.applied_at) return;
      const [s] = await tx`select id, stripe_subscription_id, plan_code, status, pending_plan_code from subscriptions where id = ${n.subscription_id as string} and workspace_id = ${ws} for update`;
      const live = s && ['active', 'trialing', 'past_due'].includes(s.status as string) && s.plan_code === n.plan_code && !s.pending_plan_code && s.stripe_subscription_id;
      if (live) {
        const [v] = await tx`select stripe_price_id from plan_prices where id = ${n.plan_price_id as string}`;
        const priceId = (v?.stripe_price_id as string | null) ?? priceIdFor(n.plan_code as PlanCode) ?? `price_${n.plan_code as string}`;
        await billingGateway().changeSubscriptionPrice(s!.stripe_subscription_id as string, priceId, false);
        await emit(tx, systemContext(ws, 'price-change'), 'SUBSCRIPTION_CHANGED', { type: 'subscription', id: s!.id as string }, {
          priceChange: { from: Number(n.old_price_micros), to: Number(n.new_price_micros), planPriceId: n.plan_price_id as string, noticeId: n.id as string },
        });
        applied++;
      }
      await tx`update price_change_notices set applied_at = now() where id = ${n.id as string} and workspace_id = ${ws}`;
    });
  }
  return applied;
}
