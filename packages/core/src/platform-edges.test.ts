import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { normalizeMetaInsight, type NormalizedObservation, type ShopifyProduct } from '@arkiv/integrations';
import { detectSalesAnomalies, detectSpikes, type SkuDay } from './anomalies';
import { compatibleScope, computeResults, createExperiment, decideConfounder, markConfounder, withConfounders } from './experiments';
import { measureFatigue, type DailyDelivery } from './fatigue';
import { mockConcepts } from './mock-intel';
import { applyShopifyProduct, connectSelectedAccounts, fxRate, ingestObservations, parsePerformanceCsv, pendingConnection, stashPendingConnection } from './performance';
import { refreshProposals, scoreProposal, scoringContext } from './recommendations';
import { ctxFor } from './testing';

/**
 * Platform edge cases (standard §45, §47): confounders by overlap and from automatic signals, sales anomalies,
 * placements and compatible campaign contexts, measured fatigue and controlled refreshes, the ad-account picker,
 * reporting currency and source timezones.
 */
beforeEach(truncateAll);
afterAll(closeAll);

const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const proposal = () => mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;

function obs(adId: string, adName: string, date: string, holdShare: number, over: Partial<NormalizedObservation> = {}): NormalizedObservation {
  const starts = 2400;
  const impressions = Math.round(starts / 0.6);
  return {
    platform: 'meta', accountId: 'act_1', campaignId: 'c1', adgroupId: 'as1', adId, adName, date, currency: 'USD',
    spendMicros: impressions * 12_000, impressions, reach: null, frequency: null, clicks: 48, outboundClicks: null,
    videoStarts: starts, video25: null, video50: null, video75: Math.round(starts * holdShare), video100: null, avgWatchMs: null,
    addToCart: null, checkout: null, purchases: 1, purchaseValueMicros: 38_000_000,
    attributionModel: 'meta_default', attributionWindow: '7d_click_1d_view', optimizationEvent: 'OFFSITE_CONVERSIONS', campaignType: 'OUTCOME_SALES',
    measurementContext: 'META_PAID_ATTRIBUTED', ...over,
  };
}

async function tenant() {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const skuId = await makeSku(t.workspaceId);
  return { t, ctx, skuId };
}

async function liveExperiment(env: Awaited<ReturnType<typeof tenant>>) {
  const { t, ctx, skuId } = env;
  const { experimentId } = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: proposal(), slot: 'EXPAND' }));
  await ownerPool()`update experiments set state = 'READY_TO_RUN' where id = ${experimentId}`;
  const variants = await ownerPool()`select id, code, label from variants where experiment_id = ${experimentId} order by code`;
  /** Days 2..(from+days) ago by default; `from` shifts the whole run back in time. */
  const ingest = (hold: number[], opts: { days?: number; from?: number; over?: Partial<NormalizedObservation>; prefix?: string } = {}) => {
    const rows: NormalizedObservation[] = [];
    for (let d = 1; d <= (opts.days ?? 6); d++) variants.forEach((v, i) => rows.push(obs(`${opts.prefix ?? experimentId}-${i}`, `Serum ${v.code}`, day(d + (opts.from ?? 1)), hold[i]!, opts.over)));
    return withTenant(t.workspaceId, (tx) => ingestObservations(tx, ctx, null, rows));
  };
  const compute = () => withTenant(t.workspaceId, (tx) => computeResults(tx, ctx, experimentId));
  return { experimentId, variants, ingest, compute };
}

const state = async (id: string) => (await ownerPool()`select state from experiments where id = ${id}`)[0]!.state as string;

describe('operational confounders are matched by overlap with the test (§45)', () => {
  it('a window that ended before the first observation does not confound; one that started long ago but overlaps does', async () => {
    const env = await tenant();
    const x = await liveExperiment(env);
    await x.ingest([0.1, 0.32, 0.1], { from: 1 }); // observations on days 2..7 ago
    // A stock-out 40–20 days ago: over before the test started.
    await withTenant(env.t.workspaceId, (tx) => markConfounder(tx, env.ctx, { skuId: env.skuId, kind: 'stockout', startsAt: day(40), endsAt: day(20) }));
    expect((await x.compute()).state).toBe('ACTIONABLE');
    const [r] = await ownerPool()`select confounder_windows from experiment_results where experiment_id = ${x.experimentId} limit 1`;
    expect(r!.confounder_windows).toEqual([]);

    // A site outage that began 45 days ago and ran until 5 days ago: more than 30 days old, but it overlaps.
    await withTenant(env.t.workspaceId, (tx) => markConfounder(tx, env.ctx, { skuId: env.skuId, kind: 'site_outage', startsAt: day(45), endsAt: day(5) }));
    const out = await x.compute();
    expect(out.state).toBe('OPERATIONALLY_CONFOUNDED');
    expect(out.confounderWindows.map((w) => w.kind)).toEqual(['site_outage']);
    const [again] = await ownerPool()`select confounder_windows from experiment_results where experiment_id = ${x.experimentId} limit 1`;
    expect((again!.confounder_windows as { kind: string; source: string }[])[0]).toMatchObject({ kind: 'site_outage', source: 'merchant' });
  });

  it('a directional read is confounded too, and a dismissed confounder no longer counts', async () => {
    expect(withConfounders('DIRECTIONAL', 1)).toBe('OPERATIONALLY_CONFOUNDED');
    expect(withConfounders('GATHERING_SIGNAL', 1)).toBe('GATHERING_SIGNAL');
    const env = await tenant();
    const x = await liveExperiment(env);
    await x.ingest([0.1, 0.32, 0.1]);
    const before = (await x.compute()).state;
    expect(before).toBe('ACTIONABLE');
    await withTenant(env.t.workspaceId, (tx) => markConfounder(tx, env.ctx, { skuId: env.skuId, kind: 'price_change', startsAt: day(3), endsAt: day(3) }));
    expect((await x.compute()).state).toBe('OPERATIONALLY_CONFOUNDED');
    const [c] = await ownerPool()`select id from confounders`;
    await withTenant(env.t.workspaceId, (tx) => decideConfounder(tx, env.ctx, c!.id as string, 'dismiss'));
    expect((await ownerPool()`select status, decided_by from confounders`)[0]).toMatchObject({ status: 'dismissed', decided_by: `user:${env.t.userId}` });
    // A recompute was queued, and it reads the test without the dismissed window.
    expect(await ownerPool()`select 1 from outbox where queue = 'compute-results' and payload->>'experimentId' = ${x.experimentId}`).not.toHaveLength(0);
    expect((await x.compute()).state).toBe(before);
  });
});

describe('automatic confounder signals from the store (§45, §48)', () => {
  const product = (over: Partial<ShopifyProduct['variants'][number]> = {}): ShopifyProduct => ({
    id: 'gid://shopify/Product/1', title: 'Glow Serum', descriptionText: 'A serum', status: 'ACTIVE', vendor: 'Glow', images: [], updatedAt: '2026-09-01',
    variants: [{ id: 'gid://shopify/ProductVariant/1', title: '30 ml', price: 38, compareAtPrice: null, sku: 'GS30', barcode: null, options: {}, available: true, imageUrl: null, ...over }],
  });

  it('selling out opens an ongoing stock-out window that confounds running tests; back in stock closes it', async () => {
    const env = await tenant();
    const t = (fn: Parameters<typeof withTenant>[1]) => withTenant(env.t.workspaceId, fn);
    await t((tx) => applyShopifyProduct(tx, env.ctx, 'glow.myshopify.com', product(), 'EUR'));
    const [sku] = await ownerPool()`select id from skus where shopify_product_id = 'gid://shopify/Product/1'`;
    expect((await ownerPool()`select currency from sku_variants where sku_id = ${sku!.id}`)[0]!.currency).toBe('EUR');
    expect(await ownerPool()`select 1 from confounders`).toHaveLength(0); // the first import is not a change

    const skuEnv = { ...env, skuId: sku!.id as string };
    const x = await liveExperiment(skuEnv);
    await x.ingest([0.1, 0.32, 0.1]);
    expect((await x.compute()).state).toBe('ACTIONABLE');

    await t((tx) => applyShopifyProduct(tx, env.ctx, 'glow.myshopify.com', product({ available: false }), 'EUR'));
    await t((tx) => applyShopifyProduct(tx, env.ctx, 'glow.myshopify.com', product({ available: false }), 'EUR')); // not opened twice
    const open = await ownerPool()`select kind, source, status, ends_at from confounders`;
    expect(open).toEqual([{ kind: 'stockout', source: 'automatic', status: 'active', ends_at: null }]);
    expect(await state(x.experimentId)).toBe('OPERATIONALLY_CONFOUNDED');

    await t((tx) => applyShopifyProduct(tx, env.ctx, 'glow.myshopify.com', product({ available: true }), 'EUR'));
    expect((await ownerPool()`select ends_at from confounders`)[0]!.ends_at).not.toBeNull();
  });

  it('a new compare-at price (a promotion) opens an offer-change window', async () => {
    const env = await tenant();
    await withTenant(env.t.workspaceId, (tx) => applyShopifyProduct(tx, env.ctx, 'glow.myshopify.com', product({ compareAtPrice: 45 }), 'USD'));
    await withTenant(env.t.workspaceId, (tx) => applyShopifyProduct(tx, env.ctx, 'glow.myshopify.com', product({ compareAtPrice: 50 }), 'USD'));
    expect(await ownerPool()`select kind, source from confounders`).toEqual([{ kind: 'offer_change', source: 'automatic' }]);
  });
});

describe('external sales spikes (§45 viral event)', () => {
  const baseDays = (n: number, today: string): SkuDay[] =>
    Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(`${today}T00:00:00Z`) - (i + 1) * 86400_000).toISOString().slice(0, 10), purchases: 3 + (i % 3), valueMicros: (3 + (i % 3)) * 38e6, impressions: 10_000 + (i % 4) * 300, spendMicros: 120e6 }));

  it('flags purchases far above the trailing baseline without more delivery, not a spike that more spend explains', () => {
    const today = '2026-09-20';
    const quiet = baseDays(28, today);
    const spike = [...quiet, { date: today, purchases: 40, valueMicros: 40 * 38e6, impressions: 10_500, spendMicros: 125e6 }];
    expect(detectSpikes(spike, [today])).toEqual([expect.objectContaining({ date: today, metric: 'purchases', observed: 40 })]);
    const paid = [...quiet, { date: today, purchases: 40, valueMicros: 40 * 38e6, impressions: 90_000, spendMicros: 1100e6 }];
    expect(detectSpikes(paid, [today])).toEqual([]);
    const ordinary = [...quiet, { date: today, purchases: 6, valueMicros: 6 * 38e6, impressions: 10_000, spendMicros: 120e6 }];
    expect(detectSpikes(ordinary, [today])).toEqual([]);
    // Too little history to call anything.
    expect(detectSpikes([...baseDays(5, today), spike.at(-1)!], [today])).toEqual([]);
  });

  it('a detected spike becomes a candidate that confounds nothing until the merchant confirms it', async () => {
    const env = await tenant();
    const x = await liveExperiment(env);
    const rows: NormalizedObservation[] = [];
    for (let d = 2; d <= 31; d++) rows.push(obs(`spike-${x.experimentId}`, `Serum ${x.variants[0]!.code}`, day(d), 0.1, { purchases: d === 2 ? 45 : 3 + (d % 3), purchaseValueMicros: (d === 2 ? 45 : 3) * 38e6 }));
    await withTenant(env.t.workspaceId, (tx) => ingestObservations(tx, env.ctx, null, rows));
    const sys = { workspaceId: env.t.workspaceId, actor: { kind: 'system' as const, id: 'test' } };
    expect(await withTenant(env.t.workspaceId, (tx) => detectSalesAnomalies(tx, sys))).toBe(1);
    expect(await withTenant(env.t.workspaceId, (tx) => detectSalesAnomalies(tx, sys))).toBe(0); // once per SKU and day
    const [c] = await ownerPool()`select id, kind, source, status, sku_id from confounders`;
    expect(c).toMatchObject({ kind: 'viral_event', source: 'automatic', status: 'pending_confirmation', sku_id: env.skuId });
    const before = await x.compute();
    expect(before.confounderWindows).toEqual([]); // a candidate is not a confounder yet
    await withTenant(env.t.workspaceId, (tx) => decideConfounder(tx, env.ctx, c!.id as string, 'confirm'));
    expect((await ownerPool()`select status from confounders`)[0]!.status).toBe('active');
    expect((await x.compute()).confounderWindows.map((w) => w.kind)).toEqual(['viral_event']);
  });
});

describe('placements and compatible campaign contexts (§45)', () => {
  it('stores Meta placements separately; a breakdown replaces the unbroken-down total for the same ad and day', async () => {
    const env = await tenant();
    const row = { account_id: '1', ad_id: 'ad-9', date_start: day(3), impressions: '1000', clicks: '10', spend: '5' };
    expect(normalizeMetaInsight({ ...row, publisher_platform: 'Instagram', platform_position: 'reels' }).placement).toBe('instagram:reels');
    expect(normalizeMetaInsight(row).placement).toBe('all');
    const t = (rows: NormalizedObservation[]) => withTenant(env.t.workspaceId, (tx) => ingestObservations(tx, env.ctx, null, rows));
    await t([normalizeMetaInsight(row)]);
    await t([normalizeMetaInsight({ ...row, impressions: '600', publisher_platform: 'instagram', platform_position: 'reels' }), normalizeMetaInsight({ ...row, impressions: '400', publisher_platform: 'facebook', platform_position: 'feed' })]);
    const cur = await ownerPool()`select placement, impressions::int as n from performance_observations where superseded_at is null order by placement`;
    expect(cur).toEqual([{ placement: 'facebook:feed', n: 400 }, { placement: 'instagram:reels', n: 600 }]);
  });

  it('compares variants within one optimization event × campaign type, never across', async () => {
    const pick = compatibleScope([
      { variant_id: 'a', optimization_event: 'PURCHASE', campaign_type: 'SALES', impressions: 1000 },
      { variant_id: 'b', optimization_event: 'PURCHASE', campaign_type: 'SALES', impressions: 900 },
      { variant_id: 'a', optimization_event: 'LINK_CLICKS', campaign_type: 'TRAFFIC', impressions: 50_000 },
    ]);
    expect(pick.scope).toEqual({ optimizationEvent: 'PURCHASE', campaignType: 'SALES' });
    expect(pick.excluded).toHaveLength(1);

    const env = await tenant();
    const x = await liveExperiment(env);
    await x.ingest([0.1, 0.32, 0.1]);
    // Traffic-optimized delivery of one variant, with a very different hold rate, must not be pooled in.
    const traffic = [2, 3, 4, 5, 6, 7].map((d) => obs(`traffic-${x.experimentId}`, `Serum ${x.variants[0]!.code}`, day(d), 0.9, { optimizationEvent: 'LINK_CLICKS', campaignType: 'OUTCOME_TRAFFIC' }));
    await withTenant(env.t.workspaceId, (tx) => ingestObservations(tx, env.ctx, null, traffic));
    await x.compute();
    const rows = await ownerPool()`select trials::float8 as trials, scope from experiment_results where experiment_id = ${x.experimentId} and metric = 'hold_rate' and variant_id = ${x.variants[0]!.id}`;
    expect(rows[0]!.trials).toBe(6 * 2400);
    expect(rows[0]!.scope).toMatchObject({ optimizationEvent: 'OFFSITE_CONVERSIONS', campaignType: 'OUTCOME_SALES' });
    expect((rows[0]!.scope as { excludedImpressions: number }).excludedImpressions).toBeGreaterThan(0);
  });
});

describe('measured fatigue and controlled refresh (§45)', () => {
  const series = (days: number, ctr: (i: number) => number): DailyDelivery[] =>
    Array.from({ length: days }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10), impressions: 2000, clicks: Math.round(2000 * ctr(i)), videoStarts: 1200, video75: 200, frequency: 1.2 + i * 0.02 }));

  it('reads decay against the first days live, not the age of a computation', () => {
    expect(measureFatigue(series(21, () => 0.02)).fatigued).toBe(false);
    const decayed = measureFatigue(series(21, (i) => (i < 7 ? 0.02 : 0.012)));
    expect(decayed).toMatchObject({ fatigued: true, daysLive: 21 });
    expect(decayed.ctrDrop!).toBeCloseTo(0.4, 2);
    expect(measureFatigue(series(10, (i) => (i < 5 ? 0.02 : 0.005))).fatigued).toBe(false); // too young to call
  });

  it('a fatigued winner raises FatigueNeed and asks for a same-angle refresh with the winner as control', async () => {
    const env = await tenant();
    const x = await liveExperiment(env);
    // Three weeks live: B leads throughout, but its click-through halves in the last week.
    const rows: NormalizedObservation[] = [];
    for (let d = 1; d <= 21; d++) {
      x.variants.forEach((v, i) => rows.push(obs(`${x.experimentId}-${i}`, `Serum ${v.code}`, day(d + 1), i === 1 ? 0.32 : 0.1, { clicks: d <= 7 && i === 1 ? 20 : 48 })));
    }
    await withTenant(env.t.workspaceId, (tx) => ingestObservations(tx, env.ctx, null, rows));
    await x.compute();
    const [e] = await ownerPool()`select fatigue from experiments where id = ${x.experimentId}`;
    const f = e!.fatigue as { fatigued: boolean; winnerVariantId: string; reason: string };
    expect(f).toMatchObject({ fatigued: true, winnerVariantId: x.variants[1]!.id });
    expect(f.reason).toMatch(/click-through down/);

    const sc = await withTenant(env.t.workspaceId, (tx) => scoringContext(tx, env.skuId));
    expect([...sc.fatiguingAngles]).toEqual([proposal().angle]);

    // The winner's delivered creative is the control of the refresh.
    const [cr] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin) values (${env.t.workspaceId}, ${env.skuId}, 'generated') returning id`;
    await ownerPool()`update variants set creative_id = ${cr!.id} where id = ${x.variants[1]!.id}`;
    const candidates = mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts.map((c) => scoreProposal({ ...c, claimWordings: [] }, sc));
    const refresh = await withTenant(env.t.workspaceId, (tx) => refreshProposals(tx, env.skuId, candidates, []));
    expect(refresh).toHaveLength(1);
    expect(refresh[0]!.controlCreativeId).toBe(cr!.id);
    expect(refresh[0]!.proposal).toMatchObject({ angle: proposal().angle, primaryVariable: 'hook' });
    expect(refresh[0]!.proposal.hookOptions).not.toContain(x.variants[1]!.label);
  });
});

describe('ad-account picker (§47 wrong ad account selected)', () => {
  it('connects only the accounts chosen from the login, and a switch disconnects the others but keeps their data', async () => {
    const env = await tenant();
    const t = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant<T>(env.t.workspaceId, fn);
    const accounts = Array.from({ length: 12 }, (_, i) => ({ id: `act_${i}`, name: `Brand ${i}`, currency: i === 11 ? 'EUR' : 'USD', timezone: 'Europe/Berlin' }));
    const pendingId = await t((tx) => stashPendingConnection(tx, env.ctx, 'meta', 'tok-secret', accounts, 'fb-user-1'));
    const [raw] = await ownerPool()`select token_enc from pending_connections`;
    expect(raw!.token_enc).not.toContain('tok-secret');
    expect(await ownerPool()`select 1 from integrations`).toHaveLength(0); // nothing connected before the choice
    const view = await t((tx) => pendingConnection(tx, pendingId));
    expect(view!.accounts).toHaveLength(12); // no silent cap at 10
    expect(JSON.stringify(view)).not.toContain('tok-secret');

    await expect(t((tx) => connectSelectedAccounts(tx, env.ctx, pendingId, ['act_99']))).rejects.toMatchObject({ code: 'INVALID' });
    expect(await t((tx) => connectSelectedAccounts(tx, env.ctx, pendingId, ['act_0', 'act_11']))).toEqual({ connected: 2, disconnected: 0 });
    const conns = await ownerPool()`select external_account_id, currency, timezone, status from integrations order by external_account_id`;
    expect(conns).toEqual([
      { external_account_id: 'act_0', currency: 'USD', timezone: 'Europe/Berlin', status: 'active' },
      { external_account_id: 'act_11', currency: 'EUR', timezone: 'Europe/Berlin', status: 'active' },
    ]);
    expect(await ownerPool()`select 1 from pending_connections`).toHaveLength(0);
    // The authorising platform user carries over, so a deauthorize webhook for that user finds these connections.
    expect((await ownerPool()`select distinct platform_user_id from integrations`).map((r) => r.platform_user_id)).toEqual(['fb-user-1']);

    // Observations from act_0 stay tagged to it after a switch to act_5.
    const [i0] = await ownerPool()`select id from integrations where external_account_id = 'act_0'`;
    await t((tx) => ingestObservations(tx, env.ctx, i0!.id as string, [obs('ad-x', 'Old ad', day(3), 0.1, { accountId: 'act_0' })]));
    const again = await t((tx) => stashPendingConnection(tx, env.ctx, 'meta', 'tok-2', accounts));
    expect(await t((tx) => connectSelectedAccounts(tx, env.ctx, again, ['act_5'], { replace: true }))).toEqual({ connected: 1, disconnected: 2 });
    expect((await ownerPool()`select external_account_id from integrations where status = 'active'`).map((r) => r.external_account_id)).toEqual(['act_5']);
    expect(await ownerPool()`select account_id, integration_id from performance_observations`).toEqual([{ account_id: 'act_0', integration_id: i0!.id }]);
  });
});

describe('currency and timezone (§47)', () => {
  it('keeps native currency and converts to the reporting currency; an unknown currency is never summed raw', async () => {
    expect(fxRate(new Map([['EUR', 1.08], ['USD', 1]]), 'EUR', 'USD')).toBeCloseTo(1.08, 6);
    expect(fxRate(new Map([['USD', 1]]), 'XYZ', 'USD')).toBeNull();
    const env = await tenant();
    await withTenant(env.t.workspaceId, (tx) => ingestObservations(tx, env.ctx, null, [
      obs('eu-1', 'EU ad', day(3), 0.1, { currency: 'EUR', spendMicros: 100_000_000, purchaseValueMicros: 50_000_000 }),
      obs('xx-1', 'XX ad', day(3), 0.1, { currency: 'XYZ', spendMicros: 100_000_000 }),
    ]));
    const rows = await ownerPool()`select ad_id, currency, spend_micros::float8 as native, spend_reporting_micros::float8 as rep, value_reporting_micros::float8 as val, reporting_currency, fx_rate::float8 as fx
                                   from performance_observations order by ad_id`;
    expect(rows[0]).toMatchObject({ ad_id: 'eu-1', currency: 'EUR', native: 100_000_000, rep: 108_000_000, val: 54_000_000, reporting_currency: 'USD', fx: 1.08 });
    expect(rows[1]).toMatchObject({ ad_id: 'xx-1', currency: 'XYZ', rep: null, fx: null });
  });

  it('retains the source timezone and matches confounder windows in it', async () => {
    const env = await tenant();
    const csv = parsePerformanceCsv('ad name,day,impressions,clicks\nSerum,2026-09-10,1000,10', 'meta', { timezone: 'Pacific/Auckland' });
    expect(csv[0]!.sourceTimezone).toBe('Pacific/Auckland');
    const x = await liveExperiment(env);
    await x.ingest([0.1, 0.32, 0.1], { over: { sourceTimezone: 'Pacific/Auckland' } });
    await withTenant(env.t.workspaceId, (tx) => ingestObservations(tx, env.ctx, null, [obs('bogus', 'Unlinked ad', day(3), 0.1, { sourceTimezone: 'Not/AZone' })]));
    const tzs = await ownerPool()`select distinct source_timezone from performance_observations order by 1`;
    expect(tzs.map((r) => r.source_timezone)).toEqual(['Pacific/Auckland', null]); // an unknown zone is not stored
    // A confounder at 13:00 UTC on day 4 is already the next calendar day in Auckland (UTC+12/13): day 4 (Auckland) stays in.
    const at = new Date(`${day(4)}T13:00:00Z`);
    await ownerPool()`insert into confounders (workspace_id, sku_id, kind, starts_at, ends_at, source, created_by)
                      values (${env.t.workspaceId}, ${env.skuId}, 'site_outage', ${at}, ${new Date(at.getTime() + 3600_000)}, 'merchant', 'test')`;
    await x.compute();
    const [r] = await ownerPool()`select trials::float8 as trials from experiment_results where experiment_id = ${x.experimentId} and metric = 'hold_rate' and variant_id = ${x.variants[1]!.id}`;
    expect(r!.trials).toBe(5 * 2400); // exactly one Auckland day (day 3) excluded
  });
});
