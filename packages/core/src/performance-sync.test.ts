import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import * as integrations from '@arkiv/integrations';
import { ConnectorError, encryptToken, type NormalizedObservation } from '@arkiv/integrations';
import { syncIntegration } from './performance';
import { ctxFor } from './testing';

/** Rate-limited syncs checkpoint each page and resume on the page they stopped at (§47). */
vi.mock('@arkiv/integrations', async (orig) => {
  const real = await orig<typeof import('@arkiv/integrations')>();
  return { ...real, metaFetchInsights: vi.fn(), tiktokFetchReport: vi.fn(), tiktokFetchGmvMaxStores: vi.fn(async () => []) };
});

beforeEach(truncateAll);
afterAll(closeAll);

const row = (adId: string): NormalizedObservation => ({
  platform: 'meta', accountId: 'act_1', campaignId: 'c1', adgroupId: 'as1', adId, adName: adId, date: '2026-09-10', currency: 'USD',
  spendMicros: 1_000_000, impressions: 1000, reach: null, frequency: null, clicks: 10, outboundClicks: null, videoStarts: null, video25: null, video50: null,
  video75: null, video100: null, avgWatchMs: null, addToCart: null, checkout: null, purchases: 0, purchaseValueMicros: 0, attributionModel: 'meta_default',
  attributionWindow: '7d_click_1d_view', optimizationEvent: null, campaignType: null, measurementContext: 'META_PAID_ATTRIBUTED',
});

async function connection(provider: 'meta' | 'tiktok') {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const [i] = await ownerPool()`insert into integrations (workspace_id, provider, external_account_id, status, token_enc, timezone)
                                values (${t.workspaceId}, ${provider}, 'acct_1', 'active', ${encryptToken('tok')}, 'America/New_York') returning id`;
  return { t, ctx: ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID'), id: i!.id as string };
}

describe('sync checkpoints (§47 "Backoff, checkpoint, resume")', () => {
  it('Meta: a rate limit on page 2 keeps page 1, and the retry resumes on page 2 of the same window', async () => {
    const meta = vi.mocked(integrations.metaFetchInsights);
    meta.mockReset();
    const c = await connection('meta');
    meta.mockResolvedValueOnce({ rows: [row('ad-1')], next: 'cursor-2' });
    meta.mockRejectedValueOnce(new ConnectorError('meta', 'rate_limited', 'slow down', 60));
    expect(await syncIntegration(c.ctx, c.id)).toEqual({ ok: false, error: 'rate_limited' });
    const [i] = await ownerPool()`select cursor, status from integrations where id = ${c.id}`;
    const resume = (i!.cursor as { resume: { since: string; until: string; page: string } }).resume;
    expect(resume).toMatchObject({ provider: 'meta', page: 'cursor-2' });
    expect(i!.status).toBe('active'); // freshness, not an error state
    expect(await ownerPool()`select ad_id, source_timezone from performance_observations`).toEqual([{ ad_id: 'ad-1', source_timezone: 'America/New_York' }]);
    expect(await ownerPool()`select 1 from outbox where queue = 'sync-integration' and singleton_key = ${`sync:${c.id}:retry`}`).toHaveLength(1);

    meta.mockResolvedValueOnce({ rows: [row('ad-2')], next: null });
    expect(await syncIntegration(c.ctx, c.id)).toEqual({ ok: true });
    expect(meta.mock.calls.at(-1)!.slice(2)).toEqual([resume.since, resume.until, 'cursor-2']);
    expect((await ownerPool()`select ad_id from performance_observations order by ad_id`).map((r) => r.ad_id)).toEqual(['ad-1', 'ad-2']);
    const [done] = await ownerPool()`select cursor from integrations where id = ${c.id}`;
    expect(done!.cursor).toEqual({ lastDate: resume.until }); // the page is cleared on completion
  });

  it('TikTok: resumes on the page number it stopped at; a full sync starts over', async () => {
    const tt = vi.mocked(integrations.tiktokFetchReport);
    tt.mockReset();
    const c = await connection('tiktok');
    const page = (id: string, hasMore: boolean) => ({ list: [{ dimensions: { ad_id: id, stat_time_day: '2026-09-10 00:00:00' }, metrics: { impressions: '100', clicks: '1', spend: '1' } }], hasMore });
    tt.mockResolvedValueOnce(page('t-1', true)).mockResolvedValueOnce(page('t-2', true));
    tt.mockRejectedValueOnce(new ConnectorError('tiktok', 'rate_limited', 'slow down', 60));
    await syncIntegration(c.ctx, c.id);
    expect(tt.mock.calls.map((x) => x[4])).toEqual([1, 2, 3]);
    tt.mockResolvedValueOnce(page('t-3', false));
    await syncIntegration(c.ctx, c.id);
    expect(tt.mock.calls.at(-1)![4]).toBe(3);

    // A stored resume point is ignored by a full sync.
    await ownerPool()`update integrations set cursor = ${ownerPool().json({ resume: { since: '2026-01-01', until: '2026-01-31', provider: 'tiktok', page: 7 } })} where id = ${c.id}`;
    tt.mockResolvedValueOnce(page('t-4', false));
    await syncIntegration(c.ctx, c.id, { full: true });
    expect(tt.mock.calls.at(-1)![4]).toBe(1);
  });
});
