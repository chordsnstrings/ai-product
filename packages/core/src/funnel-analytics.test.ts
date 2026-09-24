import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { DomainError, newId } from '@arkiv/shared';
import { cacByCampaign, deviceClass, funnelBySlice, importAdSpend, parseAdSpendCsv, recordFunnel, tasteCohorts, uploadDropoff, uploadFailureCategory } from './funnel';

beforeEach(truncateAll);
afterAll(closeAll);

const ago = (min: number) => new Date(Date.now() - min * 60_000);

async function funnel(type: string, data: { visitor?: string | null; ws?: string | null; page?: string; utm?: Record<string, string>; props?: Record<string, unknown>; at?: Date }) {
  await ownerPool()`insert into funnel_events (type, visitor_id, workspace_id, page, utm, props, at)
                    values (${type}, ${data.visitor ?? null}, ${data.ws ?? null}, ${data.page ?? null}, ${data.utm ? ownerPool().json(data.utm) : null},
                            ${ownerPool().json((data.props ?? {}) as never)}, ${data.at ?? new Date()})`;
}

/** A Taste buyer from the texture campaign: preview cost before payment, render cost after, then a subscription. */
async function buyer() {
  const t = await makeTenant({ state: 'ACTIVE_PAID' });
  const sku = await makeSku(t.workspaceId);
  await ownerPool()`update skus set origin_visitor_id = 'v1' where id = ${sku}`;
  const project = newId();
  await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by) values (${project}, ${t.workspaceId}, ${sku}, 'preview', 'COMPLETE', 'test')`;
  const [c] = await ownerPool()`insert into concepts (workspace_id, sku_id, project_id, idx, proposal, prompt_version, model)
                                values (${t.workspaceId}, ${sku}, ${project}, 'A', '{"angle":"texture_demo"}', 'p@1', 'm') returning id`;
  await ownerPool()`update projects set selected_concept_id = ${c!.id} where id = ${project}`;
  await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, stripe_checkout_session_id, status, created_by, paid_at)
                    values (${t.workspaceId}, 'taste', ${project}, 19000000, ${'cs_' + project}, 'paid', 'user:x', ${ago(120)})`;
  const cost = async (key: string, micros: number, at: Date) =>
    ownerPool()`insert into ledger_entries (workspace_id, type, unit, amount, project_id, actor, idempotency_key, created_at)
                values (${t.workspaceId}, 'PROVIDER_COST_RECORDED', 'usd_micros', ${micros}, ${project}, 'system:x', ${key}, ${at})`;
  await cost('cost:preview', 500_000, ago(180));
  await cost('cost:render', 3_000_000, ago(60));
  await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, consent_record_id, created_at)
                    values (${t.workspaceId}, ${'sub_' + project}, 'LAUNCH', 'active', gen_random_uuid(), ${ago(30)})`;
  const ws = t.workspaceId;
  await funnel('LP_VIEWED', { visitor: 'v1', page: 'texture', utm: { utm_campaign: 'Texture-Launch', utm_source: 'meta' }, props: { device: 'mobile', country: 'US', region: 'TX', returning: false, adId: 'ad-77' }, at: ago(200) });
  await funnel('UPLOAD_STARTED', { visitor: 'v1', at: ago(199) });
  await funnel('UPLOAD_COMPLETED', { visitor: 'v1', ws, at: ago(198) });
  await funnel('CONCEPTS_READY', { ws, at: ago(197) });
  await funnel('STORYBOARD_READY', { visitor: 'v1', ws, props: { offer: 'TASTE_19', offerVariant: 'b' }, at: ago(150) });
  await funnel('TASTE_PAID', { visitor: 'v1', ws, props: { kind: 'taste' }, at: ago(120) });
  await funnel('SUBSCRIPTION_STARTED', { visitor: 'v1', ws, props: { plan: 'LAUNCH' }, at: ago(30) });
  return { ...t, project };
}

describe('funnel slices (plan 05 §4)', () => {
  it('slices by ad creative, device, country/state, new vs returning and offer variant', async () => {
    await buyer();
    await funnel('LP_VIEWED', { visitor: 'v2', page: 'default', utm: { utm_id: 'ad-9' }, props: { device: 'desktop', returning: true } });
    await funnel('UPLOAD_STARTED', { visitor: 'v2' });
    const slice = async (by: Parameters<typeof funnelBySlice>[1]['by']) => {
      const rows = await withAdmin((tx) => funnelBySlice(tx, { by, days: 7 }));
      return Object.fromEntries(rows.filter((r) => r.type === 'LP_VIEWED' || r.type === 'TASTE_PAID').map((r) => [`${r.slice}:${r.type}`, r.n]));
    };
    expect(await slice('ad_id')).toEqual({ 'ad-77:LP_VIEWED': 1, 'ad-77:TASTE_PAID': 1, 'ad-9:LP_VIEWED': 1 });
    expect(await slice('device')).toMatchObject({ 'mobile:TASTE_PAID': 1, 'desktop:LP_VIEWED': 1 });
    expect(await slice('region')).toMatchObject({ 'US-TX:TASTE_PAID': 1, '(unknown):LP_VIEWED': 1 });
    expect(await slice('returning')).toMatchObject({ 'new:TASTE_PAID': 1, 'returning:LP_VIEWED': 1 });
    const offer = await withAdmin((tx) => funnelBySlice(tx, { by: 'offer', days: 7 }));
    expect(offer.find((r) => r.type === 'TASTE_PAID')!.slice).toBe('TASTE_19 · b');
    expect(offer.find((r) => r.type === 'LP_VIEWED' && r.n === 1 && r.slice === '(no offer yet)')).toBeTruthy();
  });

  it('classifies devices and upload failures', () => {
    expect(deviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe('mobile');
    expect(deviceClass('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130')).toBe('desktop');
    expect(deviceClass('facebookexternalhit/1.1')).toBe('bot');
    expect(uploadFailureCategory(new DomainError('INVALID', 'That file is too large.', { maxBytes: 1 }))).toBe('file_too_big');
    expect(uploadFailureCategory(new DomainError('INVALID', 'Marketplace listings aren’t supported yet. Paste your own store’s product page, or upload photos.'))).toBe('unsupported_page');
    expect(uploadFailureCategory(new DomainError('UNAVAILABLE', 'That store blocked our reader.'))).toBe('unsupported_page');
    expect(uploadFailureCategory(new DomainError('INVALID', 'We couldn’t reach that site.'))).toBe('unreachable_page');
    expect(uploadFailureCategory(new DomainError('FORBIDDEN', 'Please confirm you’re human', { challenge: true }))).toBe('bot_challenge');
    expect(uploadFailureCategory(new Error('boom'))).toBe('other');
  });

  it('breaks upload drop-off down by reason, including analysis that never produced concepts', async () => {
    await buyer();
    await funnel('UPLOAD_STARTED', { visitor: 'v2' });
    await funnel('UPLOAD_FAILED', { visitor: 'v2', props: { category: 'file_too_big' } });
    await funnel('UPLOAD_STARTED', { visitor: 'v3' });
    const stuck = await makeTenant();
    await funnel('UPLOAD_COMPLETED', { visitor: 'v4', ws: stuck.workspaceId, at: ago(90) });
    await funnel('URL_PARSE_FAILED', { ws: stuck.workspaceId, props: { reason: 'That store blocked our reader.', category: 'unsupported_page' } });
    const rows = await withAdmin((tx) => uploadDropoff(tx, { days: 7 }));
    expect(Object.fromEntries(rows.map((r) => [r.reason, r.n]))).toEqual({
      'Upload refused: file_too_big': 1,
      'Link unreadable: unsupported_page': 1,
      'Gave up during analysis (no concepts after 30 min)': 1,
      'Started, never submitted or completed': 1,
    });
  });
});

describe('cohorts and CAC (plan 05 §4, Appendix C)', () => {
  it('breaks Taste → subscription conversion down by landing page and concept type', async () => {
    await buyer();
    const byPage = await withAdmin((tx) => tasteCohorts(tx, { by: 'page', days: 30, tz: 'UTC' }));
    expect(byPage).toEqual([{ cohort: 'texture', taste: 1, subscribed: 1 }]);
    const byConcept = await withAdmin((tx) => tasteCohorts(tx, { by: 'concept', days: 30, tz: 'UTC' }));
    expect(byConcept).toEqual([{ cohort: 'texture_demo', taste: 1, subscribed: 1 }]);
    const byWeek = await withAdmin((tx) => tasteCohorts(tx, { by: 'week', days: 30, tz: 'UTC' }));
    expect(byWeek).toHaveLength(1);
  });

  it('joins imported ad spend to attributed buyers: media CAC per Taste buyer and effective subscriber CAC', async () => {
    const b = await buyer();
    const rows = parseAdSpendCsv('date,campaign,ad_id,spend\n' + `${new Date().toISOString().slice(0, 10)},Texture-Launch,ad-77,"60.00"\n${new Date().toISOString().slice(0, 10)},Texture-Launch,ad-77,40\n2020-01-01,old,,5`, 'meta');
    expect(rows).toHaveLength(3);
    const staff = newId();
    const n = await withAdmin((tx) => importAdSpend(tx, rows, { staffId: staff, batchId: newId() }));
    expect(n).toBe(2); // the two rows for the same day × campaign × ad add up
    const { rows: cac, total } = await withAdmin((tx) => cacByCampaign(tx, { days: 7 }));
    const texture = cac.find((r) => r.campaign === 'texture-launch')!;
    // Contribution: $19 − 2.9% − $0.30 fee − $3.00 render cost after payment.
    expect(texture).toMatchObject({ spendMicros: 100_000_000, tasteBuyers: 1, subscribers: 1, previewCogsMicros: 500_000, tasteContributionMicros: 15_149_000, mediaCacPerTaste: 100_000_000, effectiveSubscriberCac: 85_351_000 });
    expect(total.spendMicros).toBe(100_000_000); // spend outside the window is left out
    // A test workspace doesn't count as a buyer.
    await ownerPool()`update workspaces set is_test = true where id = ${b.workspaceId}`;
    const noTest = await withAdmin((tx) => cacByCampaign(tx, { days: 7 }));
    expect(noTest.rows.find((r) => r.campaign === 'texture-launch')).toMatchObject({ tasteBuyers: 0, mediaCacPerTaste: null });
  });

  it('rejects malformed ad spend files with the line number', () => {
    expect(() => parseAdSpendCsv('date,spend\n2026-09-01,10')).toThrow(/campaign/);
    expect(() => parseAdSpendCsv('date,campaign,spend\n2026-09-01,a,10')).toThrow(/source/);
    expect(() => parseAdSpendCsv('date,campaign,spend,source\n09/01/2026,a,10,meta')).toThrow(/Line 2/);
    expect(() => parseAdSpendCsv('date,campaign,spend,source\n2026-09-01,a,-3,meta')).toThrow(/Line 2/);
    expect(parseAdSpendCsv('Date,Campaign name,Amount spent (USD),Platform\n2026-09-01,"Launch, v2","1,234.50",TikTok')).toEqual([{ date: '2026-09-01', source: 'tiktok', campaign: 'Launch, v2', adId: '', spendMicros: 1_234_500_000 }]);
  });

  it('records funnel events server-side (smoke)', async () => {
    await recordFunnel('UPLOAD_FAILED', { visitorId: 'vx', props: { category: 'rate_limited' } });
    expect(await ownerPool()`select type from funnel_events where visitor_id = 'vx'`).toEqual([{ type: 'UPLOAD_FAILED' }]);
  });
});
