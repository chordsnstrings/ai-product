import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { usd } from '@arkiv/shared';
import { currentQuote, evalEligibility, expireOffers, issueTasteOffer, publicOneOffPrices, quoteAfterOffer, validateEligibility } from './offers';
import { ctxFor } from './testing';

/** Offer definitions are reference data (not truncated between tests): every test restores the seed. */
async function restoreSeed() {
  await ownerPool()`delete from offer_definitions where code not in ('TASTE_19', 'STANDALONE_29')`;
  await ownerPool()`update offer_definitions set active = true, stripe_price_id = null, next_offer_policy = '{}', experiment = null, experiment_history = '[]', paused_reason = null, stripe_price_archived_at = null where code in ('TASTE_19', 'STANDALONE_29')`;
}
async function define(code: string, type: string, price: number, version: number, extra: { ref?: string; eligibility?: unknown; next?: string; stripe?: string } = {}) {
  await ownerPool()`insert into offer_definitions (code, type, price_micros, reference_code, window_minutes, eligibility, next_offer_policy, stripe_price_id, version)
                    values (${code}, ${type}, ${usd(price)}, ${extra.ref ?? null}, 60, ${ownerPool().json((extra.eligibility ?? {}) as never)},
                            ${ownerPool().json((extra.next ? { next: extra.next } : {}) as never)}, ${extra.stripe ?? null}, ${version})`;
}

beforeEach(async () => {
  await truncateAll();
  await restoreSeed();
});
afterEach(restoreSeed);
afterAll(closeAll);

describe('eligibility rules (plan 05 §6)', () => {
  const facts = { never_purchased: true, new_workspace: true, workspace_age_days: 3, state: 'ACTIVE_FREE', plan: null, source_page: 'texture' };
  it('evaluates JSON logic and shorthand, with case-insensitive fact names', () => {
    expect(evalEligibility({}, facts)).toBe(true);
    expect(evalEligibility({ never_purchased: true }, facts)).toBe(true);
    expect(evalEligibility({ neverPurchased: false }, facts)).toBe(false);
    expect(evalEligibility({ source_page: ['texture', 'fatigue'] }, facts)).toBe(true);
    expect(evalEligibility({ and: [{ var: 'new_workspace' }, { '<': [{ var: 'workspace_age_days' }, 7] }] }, facts)).toBe(true);
    expect(evalEligibility({ or: [{ '==': [{ var: 'plan' }, 'GROWTH'] }, { '!': { var: 'never_purchased' } }] }, facts)).toBe(false);
    expect(evalEligibility({ in: [{ var: 'source_page' }, ['default']] }, facts)).toBe(false);
  });
  it('rejects rules the engine cannot evaluate', () => {
    expect(() => validateEligibility({ neverPurchased: true, newWorkspace: true })).not.toThrow();
    expect(() => validateEligibility({ and: [{ var: 'never_purchased' }] })).not.toThrow();
    expect(() => validateEligibility({ first_time_buyer: true })).toThrow(/Unknown eligibility key/);
    expect(() => validateEligibility({ var: 'country' })).toThrow(/Unknown fact/);
  });
});

describe('offer engine uses versioned definitions (plan 05 §6)', () => {
  it('issues the latest active eligible TASTE version and records its code', async () => {
    await define('TASTE_24_V2', 'TASTE', 24, 2, { ref: 'STANDALONE_29', eligibility: { never_purchased: true }, stripe: 'price_taste24' });
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const q = await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctx, t.workspaceId));
    expect(q).toMatchObject({ kind: 'taste', priceMicros: usd(24), referencePriceMicros: usd(29), definitionCode: 'TASTE_24_V2', stripePriceId: 'price_taste24' });
    const [o] = await ownerPool()`select definition_code from offers where workspace_id = ${t.workspaceId}`;
    expect(o!.definition_code).toBe('TASTE_24_V2');
    const [e] = await ownerPool()`select payload from events where workspace_id = ${t.workspaceId} and type = 'OFFER_ISSUED'`;
    expect(e!.payload).toMatchObject({ code: 'TASTE_24_V2', version: 2 });
  });

  it('skips versions whose eligibility does not match', async () => {
    await define('TASTE_TEXTURE_V2', 'TASTE', 15, 2, { ref: 'STANDALONE_29', eligibility: { source_page: ['texture'] } });
    const a = await makeTenant();
    const qa = await withTenant(a.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(a.workspaceId, a.userId), a.workspaceId));
    expect(qa.definitionCode).toBe('TASTE_19');
    const b = await makeTenant();
    const qb = await withTenant(b.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(b.workspaceId, b.userId), b.workspaceId, { source_page: 'texture' }));
    expect(qb).toMatchObject({ definitionCode: 'TASTE_TEXTURE_V2', priceMicros: usd(15) });
  });

  it('never anchors to a superseded price, and quotes the standalone version actually charged', async () => {
    await define('STANDALONE_35_V2', 'STANDALONE', 35, 2);
    const t = await makeTenant();
    const q = await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(t.workspaceId, t.userId), t.workspaceId));
    expect(q.priceMicros).toBe(usd(19));
    expect(q.referencePriceMicros).toBeNull(); // $29 is no longer what we charge
    await ownerPool()`update offers set expires_at = now() - interval '1 minute' where workspace_id = ${t.workspaceId}`;
    const now = await withTenant(t.workspaceId, (tx) => currentQuote(tx));
    expect(now).toMatchObject({ kind: 'standalone', priceMicros: usd(35), definitionCode: 'STANDALONE_35_V2' });
  });

  it('follows the next-eligible-offer policy once the Taste offer is over', async () => {
    await define('STANDALONE_25_WINBACK', 'STANDALONE', 25, 0, { eligibility: { plan: 'NEVER' } }); // not resolvable on its own
    await ownerPool()`update offer_definitions set next_offer_policy = '{"next": "STANDALONE_25_WINBACK"}' where code = 'TASTE_19'`;
    const t = await makeTenant();
    await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(t.workspaceId, t.userId), t.workspaceId));
    expect((await withTenant(t.workspaceId, (tx) => currentQuote(tx))).kind).toBe('taste');
    await ownerPool()`update offers set expires_at = now() - interval '1 minute' where workspace_id = ${t.workspaceId}`;
    expect(await withTenant(t.workspaceId, (tx) => currentQuote(tx))).toMatchObject({ kind: 'standalone', priceMicros: usd(25), definitionCode: 'STANDALONE_25_WINBACK' });
  });
});

describe('offer expiry (standard §7, §36)', () => {
  it('an expired offer is marked expired once, with an OFFER_EXPIRED event for its own workspace', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    for (const t of [a, b]) await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(t.workspaceId, t.userId), t.workspaceId));
    await ownerPool()`update offers set expires_at = now() - interval '1 minute' where workspace_id = ${a.workspaceId}`;
    expect(await withSystem((tx) => expireOffers(tx))).toBe(1);
    expect(await withSystem((tx) => expireOffers(tx))).toBe(0);
    const evs = await ownerPool()`select workspace_id, subject_id, payload, actor from events where type = 'OFFER_EXPIRED'`;
    const [o] = await ownerPool()`select id from offers where workspace_id = ${a.workspaceId}`;
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ workspace_id: a.workspaceId, subject_id: o!.id, payload: { code: 'TASTE_19' } });
    // Expired offers remain expired: issuing again returns the same, expired offer.
    const q = await withTenant(a.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(a.workspaceId, a.userId), a.workspaceId));
    expect(q).toMatchObject({ offerId: o!.id, status: 'expired' });
  });
});

describe('stated prices come from the live offer versions (plan 04 L9, biz-16)', () => {
  it('the public one-off prices follow a new standalone version and a paused Taste offer', async () => {
    expect(await withSystem((tx) => publicOneOffPrices(tx))).toEqual({ standaloneMicros: usd(29), tasteMicros: usd(19), tasteWindowMinutes: 60 });
    await define('STANDALONE_35', 'STANDALONE', 35, 9);
    await ownerPool()`update offer_definitions set active = false where code = 'TASTE_19'`;
    expect(await withSystem((tx) => publicOneOffPrices(tx))).toEqual({ standaloneMicros: usd(35), tasteMicros: null, tasteWindowMinutes: null });
  });

  it('the price after the offer is the next-offer version or the live standalone, even while the offer runs', async () => {
    const t = await makeTenant();
    await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctxFor(t.workspaceId, t.userId), t.workspaceId));
    await define('STANDALONE_35', 'STANDALONE', 35, 9);
    await withTenant(t.workspaceId, async (tx) => {
      expect((await currentQuote(tx)).priceMicros).toBe(usd(19));
      expect((await quoteAfterOffer(tx)).priceMicros).toBe(usd(35));
    });
  });
});
