import type { Tx } from '@arkiv/db';
import { DomainError, PLANS, PlanCode, type Micros } from '@arkiv/shared';
import { assertStaff, audit, type Staff } from './admin';
import { enqueue, Queues } from './outbox';

/**
 * Versioned plan prices (plan 04 §3 "Price-change notices to subscribers are required (Cal. ARL)"). The constants
 * in packages/shared plans.ts are the price until a version exists. A new version takes effect no sooner than
 * PRICE_NOTICE_DAYS after it is scheduled: new subscribers pay it from its effective date; each existing subscriber
 * is told (price_change_notices) and moves to it at their first renewal on or after their notice's date.
 */
export const PRICE_NOTICE_DAYS = 30;

export interface PlanPrice {
  plan: PlanCode;
  priceMicros: Micros;
  stripePriceId: string | null;
  /** The plan_prices version, or null for the built-in price. */
  versionId: string | null;
}

/** The price of a plan in effect at a moment (default now). Any role that can read plan_prices. */
export async function planPriceAt(tx: Tx, plan: PlanCode, at: Date | string = new Date()): Promise<PlanPrice> {
  const [v] = await tx`select id, price_micros, stripe_price_id from plan_prices where plan_code = ${plan} and effective_from <= ${at}
                       order by effective_from desc limit 1`;
  return v
    ? { plan, priceMicros: Number(v.price_micros), stripePriceId: (v.stripe_price_id as string | null) ?? null, versionId: v.id as string }
    : { plan, priceMicros: PLANS[plan].priceMicros, stripePriceId: null, versionId: null };
}

/** Every plan's current price (pricing pages, checkout, funnel analytics). */
export async function currentPlanPrices(tx: Tx): Promise<Record<PlanCode, Micros>> {
  const out = Object.fromEntries(PlanCode.map((p) => [p, PLANS[p].priceMicros])) as Record<PlanCode, Micros>;
  const rows = await tx`select distinct on (plan_code) plan_code, price_micros from plan_prices where effective_from <= now() order by plan_code, effective_from desc`;
  for (const r of rows) out[r.plan_code as PlanCode] = Number(r.price_micros);
  return out;
}

/**
 * What a subscription pays now: the price its latest applied notice moved it to, else the plan's price when it
 * started. Explicit workspace filter (callers may be staff or system).
 */
export async function subscriptionPrice(tx: Tx, sub: { id: string; workspaceId: string; planCode: PlanCode; createdAt: Date | string }): Promise<PlanPrice> {
  const [n] = await tx`select n.new_price_micros, v.id, v.stripe_price_id from price_change_notices n join plan_prices v on v.id = n.plan_price_id
                       where n.workspace_id = ${sub.workspaceId} and n.subscription_id = ${sub.id} and n.plan_code = ${sub.planCode} and n.applied_at is not null
                       order by n.effective_from desc limit 1`;
  if (n) return { plan: sub.planCode, priceMicros: Number(n.new_price_micros), stripePriceId: (n.stripe_price_id as string | null) ?? null, versionId: n.id as string };
  return planPriceAt(tx, sub.planCode, sub.createdAt);
}

/** A notified, not yet applied price change for a subscription (the customer's billing page shows it). */
export async function pendingPriceChange(tx: Tx, workspaceId: string, subscriptionId: string) {
  const [n] = await tx`select old_price_micros, new_price_micros, effective_from, plan_code from price_change_notices
                       where workspace_id = ${workspaceId} and subscription_id = ${subscriptionId} and applied_at is null order by effective_from limit 1`;
  return n ? { oldPriceMicros: Number(n.old_price_micros), newPriceMicros: Number(n.new_price_micros), effectiveFrom: new Date(n.effective_from as string), plan: n.plan_code as PlanCode } : null;
}

/** Schedule a new price version (staff, after four-eyes approval). Notices go out through notifyPriceChanges. */
export async function schedulePlanPrice(tx: Tx, s: Staff, input: { plan: PlanCode; priceMicros: Micros; stripePriceId: string | null; effectiveFrom: Date; reason: string }) {
  assertStaff(s, 'billing.manage');
  if (!(PlanCode as readonly string[]).includes(input.plan)) throw new DomainError('INVALID', 'Unknown plan');
  if (!Number.isInteger(input.priceMicros) || input.priceMicros <= 0) throw new DomainError('INVALID', 'The price must be positive.');
  if (input.effectiveFrom.getTime() < Date.now() + PRICE_NOTICE_DAYS * 86400_000 - 60_000) {
    throw new DomainError('INVALID', `A price change takes effect at least ${PRICE_NOTICE_DAYS} days out, so every subscriber gets notice first.`);
  }
  const current = await planPriceAt(tx, input.plan);
  const [v] = await tx`insert into plan_prices (plan_code, price_micros, stripe_price_id, effective_from, reason, created_by)
                       values (${input.plan}, ${input.priceMicros}, ${input.stripePriceId}, ${input.effectiveFrom}, ${input.reason}, ${s.staffId})
                       on conflict (plan_code, effective_from) do nothing returning id`;
  if (!v) throw new DomainError('CONFLICT', 'A price version already takes effect at that moment.');
  await audit(tx, s, 'plan.price_scheduled', { type: 'plan_price', id: v.id as string }, { reason: input.reason, before: { plan: input.plan, priceMicros: current.priceMicros }, after: { plan: input.plan, priceMicros: input.priceMicros, effectiveFrom: input.effectiveFrom.toISOString(), stripePriceId: input.stripePriceId } });
  return { versionId: v.id as string };
}

/**
 * Tell every live subscriber of a plan with a future price version (staff or system role): one notice per
 * subscription × version, effective at the version's date or PRICE_NOTICE_DAYS from now, whichever is later (a
 * subscriber who joined after the change was scheduled still gets full notice), and the email through the outbox.
 * Idempotent. Returns the notices created.
 */
export async function notifyPriceChanges(tx: Tx): Promise<{ noticeId: string; workspaceId: string }[]> {
  const due = await tx`
    select v.id as version_id, v.plan_code, v.price_micros, v.effective_from, s.id as subscription_id, s.workspace_id, s.created_at
    from plan_prices v
    join subscriptions s on s.plan_code = v.plan_code and s.status in ('active', 'trialing', 'past_due')
    where v.effective_from > now()
      and not exists (select 1 from price_change_notices n where n.workspace_id = s.workspace_id and n.subscription_id = s.id and n.plan_price_id = v.id)
    order by v.effective_from`;
  const out: { noticeId: string; workspaceId: string }[] = [];
  for (const d of due) {
    const ws = d.workspace_id as string;
    const old = await subscriptionPrice(tx, { id: d.subscription_id as string, workspaceId: ws, planCode: d.plan_code as PlanCode, createdAt: d.created_at as string });
    if (old.priceMicros === Number(d.price_micros)) continue;
    const [n] = await tx`insert into price_change_notices (workspace_id, subscription_id, plan_price_id, plan_code, old_price_micros, new_price_micros, effective_from)
                         values (${ws}, ${d.subscription_id as string}, ${d.version_id as string}, ${d.plan_code as string}, ${old.priceMicros}, ${Number(d.price_micros)},
                                 greatest(${d.effective_from as string}::timestamptz, now() + make_interval(days => ${PRICE_NOTICE_DAYS})))
                         on conflict (subscription_id, plan_price_id) do nothing returning id`;
    if (!n) continue;
    await enqueue(tx, ws, Queues.sendEmail, { template: 'price_change_notice', noticeId: n.id as string }, { singletonKey: `price-notice:${n.id as string}` });
    out.push({ noticeId: n.id as string, workspaceId: ws });
  }
  return out;
}
