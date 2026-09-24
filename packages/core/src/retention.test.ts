import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { clusterFreeText } from './customer-language';
import { day30ReviewDelivery, retentionCohorts } from './retention';

beforeEach(truncateAll);
afterAll(closeAll);

/** A customer whose first plan started `daysAgo` days ago and (optionally) ended `endedAfter` days after starting. */
async function customer(plan: string, daysAgo: number, endedAfter: number | null, opts: { page?: string; meta?: boolean } = {}) {
  const t = await makeTenant({ state: 'ACTIVE_PAID', plan });
  const subId = newId();
  const started = new Date(Date.now() - daysAgo * 86400_000);
  await ownerPool()`insert into subscriptions (id, workspace_id, stripe_subscription_id, plan_code, status, created_at, updated_at)
                    values (${subId}, ${t.workspaceId}, ${`sub_${subId}`}, ${plan}, ${endedAfter == null ? 'active' : 'canceled'}, ${started}, ${started})`;
  if (endedAfter != null) {
    await ownerPool()`insert into events (workspace_id, type, subject_type, subject_id, actor, payload, at)
                      values (${t.workspaceId}, 'SUBSCRIPTION_ENDED', 'subscription', ${subId}, 'system:stripe', '{}', ${new Date(started.getTime() + endedAfter * 86400_000)})`;
  }
  if (opts.page) {
    const vid = `v-${t.workspaceId.slice(0, 8)}`;
    await ownerPool()`insert into funnel_events (type, visitor_id, page, at) values ('LP_VIEWED', ${vid}, ${opts.page}, ${new Date(started.getTime() - 86400_000)})`;
    await ownerPool()`insert into funnel_events (type, visitor_id, workspace_id, at) values ('UPLOAD_COMPLETED', ${vid}, ${t.workspaceId}, ${started})`;
  }
  if (opts.meta) await ownerPool()`insert into integrations (workspace_id, provider, external_account_id, status, scopes) values (${t.workspaceId}, 'meta', ${`act_${daysAgo}`}, 'active', '{ads_read}')`;
  return t.workspaceId;
}

describe('cohort retention W1/W4/M2/M3 (plan 05 §17)', () => {
  it('counts a customer as retained at a checkpoint while some plan covered that day, over matured customers only', async () => {
    await customer('LAUNCH', 100, null, { page: '/for/serums', meta: true }); // retained throughout
    await customer('LAUNCH', 100, 20, { page: '/for/serums' }); // churned between W1 and W4
    await customer('GROWTH', 40, 70); // still inside, retained at W1 and W4; M2 not yet measurable
    await customer('GROWTH', 3, null, { meta: true }); // too new for any checkpoint
    const byPlan = await withAdmin((tx) => retentionCohorts(tx, { by: 'plan' }));
    const launch = byPlan.find((r) => r.segment === 'LAUNCH')!;
    expect(launch.customers).toBe(2);
    expect(launch.points).toEqual({ w1: { eligible: 2, retained: 2 }, w4: { eligible: 2, retained: 1 }, m2: { eligible: 2, retained: 1 }, m3: { eligible: 2, retained: 1 } });
    const growth = byPlan.find((r) => r.segment === 'GROWTH')!;
    expect(growth.points).toEqual({ w1: { eligible: 1, retained: 1 }, w4: { eligible: 1, retained: 1 }, m2: { eligible: 0, retained: 0 }, m3: { eligible: 0, retained: 0 } });

    const byPage = await withAdmin((tx) => retentionCohorts(tx, { by: 'page' }));
    expect(byPage.map((r) => [r.segment, r.customers])).toEqual([['/for/serums', 2], ['(unattributed)', 2]]);
    const byAds = await withAdmin((tx) => retentionCohorts(tx, { by: 'ad_account' }));
    expect(Object.fromEntries(byAds.map((r) => [r.segment, r.points.w4]))).toEqual({ 'ad account connected': { eligible: 1, retained: 1 }, 'no ad account': { eligible: 2, retained: 1 } });
  });

  it('leaves test workspaces out unless asked', async () => {
    const ws = await customer('SCALE', 30, null);
    await ownerPool()`update workspaces set is_test = true where id = ${ws}`;
    expect(await withAdmin((tx) => retentionCohorts(tx, { by: 'plan' }))).toEqual([]);
    expect(await withAdmin((tx) => retentionCohorts(tx, { by: 'plan', includeTest: true }))).toHaveLength(1);
  });
});

describe('Day-30 SKU Review delivery (plan 05 §17)', () => {
  it('matches each review to its email and reports delivery', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'LAUNCH' });
    const a = await makeSku(t.workspaceId, 'Dew Serum');
    const b = await makeSku(t.workspaceId, 'Calm Balm');
    for (const sku of [a, b]) {
      await ownerPool()`insert into sku_reviews (workspace_id, sku_id, kind, period_start, period_end, version, body)
                        values (${t.workspaceId}, ${sku}, 'day30', now() - interval '30 days', now(), 1, '{}')`;
    }
    await ownerPool()`insert into email_log (workspace_id, to_email, template, stream, idempotency_key, status, data)
                      values (${t.workspaceId}, ${t.email}, 'day30_review', 'transactional', 'd30-a', 'delivered', ${ownerPool().json({ url: `http://x/w/s/products/${a}/review` })})`;
    const r = await withAdmin((tx) => day30ReviewDelivery(tx));
    expect(r.summary).toEqual({ written: 2, emailed: 1, delivered: 1, bounced: 0, notSent: 1 });
    expect(Object.fromEntries(r.reviews.map((x) => [x.sku, x.email_status]))).toEqual({ 'Dew Serum': 'delivered', 'Calm Balm': null });
  });
});

describe('cancellation free-text themes (plan 05 §17)', () => {
  it('clusters answers into known themes, then by shared words, keeping examples', () => {
    const r = clusterFreeText([
      'Too expensive for us right now',
      'Budget got cut',
      'We did not see any sales lift',
      'Went with an agency instead',
      'Needed Pinterest support',
      'Pinterest is our main channel',
      'meh',
      '',
    ]);
    expect(r.map((x) => [x.theme, x.count])).toEqual([
      ['Price / budget', 2],
      ['“pinterest”', 2],
      ['Results / performance', 1],
      ['Switching / in-house', 1],
      ['Other', 1],
    ]);
    expect(r[0]!.examples).toEqual(['Too expensive for us right now', 'Budget got cut']);
  });
});
