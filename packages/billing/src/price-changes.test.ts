import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { currentPlanPrices, notifyPriceChanges, pendingPriceChange, schedulePlanPrice, subscriptionPrice, type Staff } from '@arkiv/core';
import { ctxFor } from '@arkiv/core/testing';
import { newId } from '@arkiv/shared';
import { changePlan, completeMockCheckout, recordAutoRenewConsent, startSubscriptionCheckout } from './billing';
import { MockStripe, setBillingGateway } from './gateway';
import { applyDuePriceChanges } from './price-changes';

/** Plan 04 §3 (Cal. ARL): subscribers get notice of a price change before it applies, and it applies at renewal. */
let gw: MockStripe;
beforeEach(async () => {
  await truncateAll();
  gw = new MockStripe();
  setBillingGateway(gw);
});
afterAll(closeAll);

async function finance(): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, 'Fin', 'x', ${['FINANCE']})`;
  return { staffId: id, roles: ['FINANCE'], name: 'Fin' } as Staff;
}

async function subscribed(plan: 'LAUNCH' | 'GROWTH' | 'SCALE') {
  const t = await makeTenant();
  const free = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
  const consentId = await withTenant(t.workspaceId, (tx) => recordAutoRenewConsent(tx, free, { userId: t.userId, plan, agreed: true }));
  const co = await withTenant(t.workspaceId, (tx) => startSubscriptionCheckout(tx, free, plan, consentId, { id: t.userId, email: t.email }));
  await completeMockCheckout(co.sessionId);
  const [s] = await ownerPool()`select id, stripe_subscription_id, created_at from subscriptions where workspace_id = ${t.workspaceId}`;
  return { t, sub: { id: s!.id as string, stripeId: s!.stripe_subscription_id as string, createdAt: s!.created_at as Date }, consentId };
}

const days = (n: number) => new Date(Date.now() + n * 86400_000);

describe('subscriber price changes (plan 04 §3)', () => {
  it('schedules at least 30 days out, notifies every subscriber once, and switches their Stripe price when the date comes', async () => {
    const a = await subscribed('GROWTH');
    const fin = await finance();
    await expect(withAdmin((tx) => schedulePlanPrice(tx, fin, { plan: 'GROWTH', priceMicros: 129_000_000, stripePriceId: 'price_growth_129', effectiveFrom: days(10), reason: 'repricing' }))).rejects.toThrow(/at least 30 days/);
    await withAdmin((tx) => schedulePlanPrice(tx, fin, { plan: 'GROWTH', priceMicros: 129_000_000, stripePriceId: 'price_growth_129', effectiveFrom: days(31), reason: 'repricing' }));
    const sent = await withAdmin((tx) => notifyPriceChanges(tx));
    expect(sent).toEqual([{ noticeId: expect.any(String), workspaceId: a.t.workspaceId }]);
    expect(await withAdmin((tx) => notifyPriceChanges(tx))).toEqual([]); // once per subscription × version
    const [o] = await ownerPool()`select payload from outbox where workspace_id = ${a.t.workspaceId} and queue = 'send-email' and payload->>'template' = 'price_change_notice'`;
    expect(o!.payload).toMatchObject({ noticeId: sent[0]!.noticeId });
    const change = await withTenant(a.t.workspaceId, (tx) => pendingPriceChange(tx, a.t.workspaceId, a.sub.id));
    expect(change).toMatchObject({ oldPriceMicros: 99_000_000, newPriceMicros: 129_000_000 });

    // Until the date, the plan still sells (and the customer still pays) the old price; someone who subscribes
    // meanwhile consents to the old price and gets full notice too.
    expect((await withAdmin((tx) => currentPlanPrices(tx))).GROWTH).toBe(99_000_000);
    const b = await subscribed('GROWTH');
    const [bNotice] = await withSystem((tx) => notifyPriceChanges(tx));
    expect(bNotice!.workspaceId).toBe(b.t.workspaceId);
    const [late] = await ownerPool()`select effective_from from price_change_notices where id = ${bNotice!.noticeId}`;
    expect(new Date(late!.effective_from as string).getTime()).toBeGreaterThanOrEqual(days(30).getTime() - 60_000);

    // Nothing applies early.
    expect(await applyDuePriceChanges()).toBe(0);
    // The date comes: the switch moves the Stripe price with no proration (next renewal is the first at the new price).
    await ownerPool()`update plan_prices set effective_from = now() - interval '1 minute'`;
    await ownerPool()`update price_change_notices set effective_from = now() - interval '1 minute' where workspace_id = ${a.t.workspaceId}`;
    expect(await applyDuePriceChanges()).toBe(1);
    expect(gw.priceChanges).toEqual([{ id: a.sub.stripeId, priceId: 'price_growth_129', prorate: false }]);
    expect(await applyDuePriceChanges()).toBe(0);
    const own = await withTenant(a.t.workspaceId, (tx) => subscriptionPrice(tx, { id: a.sub.id, workspaceId: a.t.workspaceId, planCode: 'GROWTH', createdAt: a.sub.createdAt }));
    expect(own.priceMicros).toBe(129_000_000);
    const [ev] = await ownerPool()`select payload from events where workspace_id = ${a.t.workspaceId} and type = 'SUBSCRIPTION_CHANGED' and payload ? 'priceChange'`;
    expect(ev!.payload).toMatchObject({ priceChange: { from: 99_000_000, to: 129_000_000 } });
    // b's notice is still pending (its own 30 days).
    expect(await withTenant(b.t.workspaceId, (tx) => pendingPriceChange(tx, b.t.workspaceId, b.sub.id))).toBeTruthy();

    // New subscribers now consent to, and check out at, the new price.
    expect((await withAdmin((tx) => currentPlanPrices(tx))).GROWTH).toBe(129_000_000);
    const c = await subscribed('GROWTH');
    const [consent] = await ownerPool()`select text_snapshot, context from consent_records where id = ${c.consentId}`;
    expect(consent!.text_snapshot).toMatch(/^\$129\/month/);
    expect(consent!.context).toMatchObject({ priceMicros: 129_000_000 });
  });

  it('skips a subscription that moved plan or has a downgrade scheduled (Stripe already holds that price)', async () => {
    const a = await subscribed('GROWTH');
    const fin = await finance();
    await withAdmin((tx) => schedulePlanPrice(tx, fin, { plan: 'GROWTH', priceMicros: 129_000_000, stripePriceId: 'price_growth_129', effectiveFrom: days(31), reason: 'repricing' }));
    await withAdmin((tx) => notifyPriceChanges(tx));
    await withTenant(a.t.workspaceId, (tx) => changePlan(tx, ctxFor(a.t.workspaceId, a.t.userId, 'OWNER', 'ACTIVE_PAID'), 'LAUNCH'));
    gw.priceChanges.length = 0;
    await ownerPool()`update price_change_notices set effective_from = now() - interval '1 minute'`;
    expect(await applyDuePriceChanges()).toBe(0);
    expect(gw.priceChanges).toEqual([]);
    expect(await ownerPool()`select applied_at is not null as done from price_change_notices`).toEqual([{ done: true }]);
  });
});
