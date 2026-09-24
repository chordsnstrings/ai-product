import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, usd, type StaffRole } from '@arkiv/shared';
import type { Staff } from './admin';
import { guardrailBreach, offerExperimentReadout, offerExperimentResults, setOfferExperiment, sweepOfferGuardrails, type OfferVariantResult } from './offer-experiments';
import { issueTasteOffer } from './offers';
import { ctxFor } from './testing';

/** Offer definitions are reference data (not truncated): restore the seed around every test. */
async function restoreSeed() {
  await ownerPool()`delete from offer_definitions where code not in ('TASTE_19', 'STANDALONE_29')`;
  await ownerPool()`update offer_definitions set active = true, experiment = null, experiment_history = '[]', paused_reason = null, stripe_price_archived_at = null where code in ('TASTE_19', 'STANDALONE_29')`;
}
beforeEach(async () => {
  await truncateAll();
  await restoreSeed();
});
afterEach(restoreSeed);
afterAll(closeAll);

async function staff(roles: StaffRole[] = ['GROWTH']): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, 'Growth', 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: 'Growth', roles };
}

const priceTest = {
  key: 'taste-price-q4',
  variants: [
    { key: 'p19', weight: 1, priceMicros: usd(19) },
    { key: 'p24', weight: 1, priceMicros: usd(24), windowMinutes: 120 },
  ],
  guardrails: { maxRefundRate: 0.2, minSample: 5 },
};

describe('offer experiments (plan 05 §6)', () => {
  it('validates the definition: Taste only, honest anchor, a guardrail, keys never reused', async () => {
    const s = await staff();
    await expect(withAdmin((tx) => setOfferExperiment(tx, s, 'STANDALONE_29', priceTest, 'price test'))).rejects.toThrow(/Only the Taste offer/);
    await expect(withAdmin((tx) => setOfferExperiment(tx, s, 'TASTE_19', { ...priceTest, variants: [{ key: 'a', weight: 1 }, { key: 'b', weight: 1, priceMicros: usd(29) }] }, 'x'))).rejects.toThrow(/less than the regular price/);
    await expect(withAdmin((tx) => setOfferExperiment(tx, s, 'TASTE_19', { ...priceTest, guardrails: { minSample: 10 } }, 'x'))).rejects.toThrow(/at least one guardrail/);
    await expect(withAdmin((tx) => setOfferExperiment(tx, s, 'TASTE_19', { ...priceTest, variants: [{ key: 'a', weight: 1 }, { key: 'b', weight: 1, windowMinutes: 10 }] }, 'x'))).rejects.toThrow();
    await withAdmin((tx) => setOfferExperiment(tx, s, 'TASTE_19', priceTest, 'is $24 still converting?'));
    await expect(withAdmin((tx) => setOfferExperiment(tx, s, 'TASTE_19', priceTest, 'again'))).rejects.toThrow(/already used/);
    // Replacing keeps the old one in the history.
    await withAdmin((tx) => setOfferExperiment(tx, s, 'TASTE_19', { ...priceTest, key: 'taste-timer-q4', variants: [{ key: 't30', weight: 1, windowMinutes: 30 }, { key: 't60', weight: 1, windowMinutes: 60 }] }, 'timer test'));
    const [d] = await ownerPool()`select experiment, experiment_history from offer_definitions where code = 'TASTE_19'`;
    expect((d!.experiment as { key: string }).key).toBe('taste-timer-q4');
    expect((d!.experiment_history as { key: string; reason: string }[]).map((h) => [h.key, h.reason])).toEqual([['taste-price-q4', 'replaced by taste-timer-q4: timer test']]);
    const audits = await ownerPool()`select action from admin_audit_log where target_id = 'TASTE_19' order by id`;
    expect(audits.map((a) => a.action)).toEqual(['offer.experiment_start', 'offer.experiment_start']);
  });

  it('the engine issues each workspace one variant, recorded with its experiment', async () => {
    const s = await staff();
    await withAdmin((tx) => setOfferExperiment(tx, s, 'TASTE_19', priceTest, 'price test'));
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const t = await makeTenant();
      const q = await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(t.workspaceId, t.userId), newId()));
      const [o] = await ownerPool()`select variant, experiment_key, price_micros, expires_at - created_at as window from offers where workspace_id = ${t.workspaceId}`;
      expect(o!.experiment_key).toBe('taste-price-q4');
      seen.add(o!.variant as string);
      expect(q.priceMicros).toBe(o!.variant === 'p24' ? usd(24) : usd(19));
    }
    expect([...seen].sort()).toEqual(['p19', 'p24']);
    const results = await withAdmin((tx) => offerExperimentResults(tx, 'TASTE_19', 'taste-price-q4'));
    expect(results.reduce((a, r) => a + r.issued, 0)).toBe(12);
  });

  it('judges guardrails only past the minimum sample', () => {
    const row = (v: string, paid: number, refunded: number, issued = paid, support = 0) => ({ variant: v, issued, redeemed: paid, expired: 0, checkoutStarted: paid, paid, refunded, disputed: 0, support, conversion: 1, checkoutRate: 1, paidConversion: 1, refundRate: paid ? refunded / paid : null, disputeRate: 0, supportRate: issued ? support / issued : null });
    const g = { maxRefundRate: 0.1, maxSupportRate: 0.2, minSample: 20 };
    expect(guardrailBreach([row('a', 10, 5)], g)).toBeNull(); // 50% refunds, but only 10 paid
    expect(guardrailBreach([row('a', 40, 2), row('b', 40, 8)], g)).toMatch(/refund rate 20% on variant b/);
    expect(guardrailBreach([row('a', 5, 0, 40, 10)], g)).toMatch(/support tickets from 25%/);
  });

  it('the guardrail sweep stops a degrading experiment, keeps its results and raises an alert', async () => {
    const s = await staff();
    await withAdmin((tx) => setOfferExperiment(tx, s, 'TASTE_19', priceTest, 'price test'));
    // Paid offers on each variant; refunds pile up on one of them.
    // Assignment is a hash of the workspace id: issue until each variant has more than the minimum sample.
    const count = { p19: 0, p24: 0 };
    for (let n = 0; n < 200 && (count.p19 < 6 || count.p24 < 6); n++) {
      const t = await makeTenant();
      await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(t.workspaceId, t.userId), newId()));
      const [o] = await ownerPool()`select id, variant from offers where workspace_id = ${t.workspaceId}`;
      const refunded = o!.variant === 'p24';
      await ownerPool()`insert into purchases (workspace_id, kind, offer_id, amount_micros, status, created_by, paid_at, refunded_micros)
                        values (${t.workspaceId}, 'taste', ${o!.id}, ${usd(19)}, ${refunded ? 'refunded' : 'paid'}, 'test', now(), ${refunded ? usd(19) : 0})`;
      count[o!.variant as 'p19' | 'p24']++;
    }
    expect(await withSystem((tx) => sweepOfferGuardrails(tx))).toEqual([{ code: 'TASTE_19', experiment: 'taste-price-q4', why: expect.stringMatching(/refund rate 100% on variant p24/) }]);
    const [d] = await ownerPool()`select experiment, experiment_history from offer_definitions where code = 'TASTE_19'`;
    expect(d!.experiment).toBeNull();
    const h = (d!.experiment_history as { key: string; endedBy: string; results: unknown[] }[])[0]!;
    expect(h).toMatchObject({ key: 'taste-price-q4', endedBy: 'system:offer-guardrails' });
    expect(h.results.length).toBe(2);
    const [alert] = await ownerPool()`select kind, severity, subject_id from platform_alerts`;
    expect(alert).toEqual({ kind: 'offer.experiment_stopped', severity: 'risk', subject_id: 'TASTE_19:taste-price-q4' });
    const [audit] = await ownerPool()`select action, staff_id from admin_audit_log where action like 'system.%'`;
    expect(audit).toEqual({ action: 'system.offer.experiment_stopped', staff_id: null });
    // New offers go back to the base price.
    const t = await makeTenant();
    const q = await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(t.workspaceId, t.userId), newId()));
    expect(q.priceMicros).toBe(usd(19));
    expect(await withSystem((tx) => sweepOfferGuardrails(tx))).toEqual([]);
  });
});

describe('offer experiment readout (plan 04 L22: pre-registered metric, minimum sample)', () => {
  const r = (variant: string, issued: number, checkoutStarted: number, paid: number): OfferVariantResult => ({
    variant, issued, redeemed: paid, expired: 0, checkoutStarted, paid, refunded: 0, disputed: 0, support: 0,
    conversion: paid / issued, checkoutRate: checkoutStarted / issued, paidConversion: paid / issued, refundRate: 0, disputeRate: 0, supportRate: 0,
  });
  const exp = { primaryMetric: 'paid_conversion' as const, minSamplePerVariant: 200, variants: [{ key: 'p19', weight: 1 }, { key: 'p24', weight: 1 }] };

  it('calls nothing before every variant has its sample', () => {
    const out = offerExperimentReadout([r('p19', 250, 100, 60), r('p24', 150, 40, 10)], exp);
    expect(out).toMatchObject({ ready: false, leader: null });
    expect(out.note).toMatch(/p24 150\/200/);
  });

  it('names a leader only when the 95% interval excludes no difference, on the registered metric', () => {
    expect(offerExperimentReadout([r('p19', 400, 120, 80), r('p24', 400, 118, 78)], exp)).toMatchObject({ ready: true, leader: null });
    const clear = offerExperimentReadout([r('p19', 400, 120, 40), r('p24', 400, 160, 90)], exp);
    expect(clear.leader).toBe('p24');
    expect(clear.variants[1]!.low).toBeGreaterThan(0);
    // The same data read on checkout rate, as pre-registered for another experiment.
    expect(offerExperimentReadout([r('p19', 400, 160, 40), r('p24', 400, 100, 90)], { ...exp, primaryMetric: 'checkout_rate' }).leader).toBe('p19');
  });

  it('counts opened checkouts per variant from the purchases of each offer', async () => {
    const s = await staff();
    await withAdmin((tx) => setOfferExperiment(tx, s, 'TASTE_19', priceTest, 'price test'));
    const t = await makeTenant();
    await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(t.workspaceId, t.userId), newId()));
    const [o] = await ownerPool()`select id, variant from offers where workspace_id = ${t.workspaceId}`;
    await ownerPool()`insert into purchases (workspace_id, kind, offer_id, amount_micros, stripe_checkout_session_id, created_by) values (${t.workspaceId}, 'taste', ${o!.id}, 19000000, 'cs_ro_1', 'user:x')`;
    await ownerPool()`insert into purchases (workspace_id, kind, offer_id, amount_micros, stripe_checkout_session_id, created_by) values (${t.workspaceId}, 'taste', ${o!.id}, 19000000, 'cs_ro_2', 'user:x')`;
    const results = await withAdmin((tx) => offerExperimentResults(tx, 'TASTE_19', 'taste-price-q4'));
    expect(results.find((x) => x.variant === o!.variant)).toMatchObject({ issued: 1, checkoutStarted: 1, paid: 0, checkoutRate: 1 });
    // The stored experiment carries its pre-registered metric (defaulted).
    const [d] = await ownerPool()`select experiment from offer_definitions where code = 'TASTE_19'`;
    expect(d!.experiment).toMatchObject({ primaryMetric: 'paid_conversion', minSamplePerVariant: 100 });
  });
});
