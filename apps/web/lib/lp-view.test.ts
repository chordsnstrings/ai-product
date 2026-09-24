import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { landingTable } from './landing-table';
import { recordLandingView } from './lp-view';

/** Plan 04 L6: the static page's view beacon records the same landing view the dynamic page did. */
beforeEach(truncateAll);
afterAll(closeAll);

describe('landing views of static pages', () => {
  it('records page, variant, UTMs, ad id, device and new/returning from the beacon', async () => {
    const headers = new Headers({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Instagram 300' });
    await recordLandingView({ visitorId: 'v-beacon', page: 'texture', variant: 'b', search: new URLSearchParams('utm_source=tiktok&utm_content=texture-01&ad_id=987&x=1'), headers, returning: false });
    const [e] = await ownerPool()`select visitor_id, page, variant, utm, props from funnel_events where type = 'LP_VIEWED' and visitor_id = 'v-beacon'`;
    expect(e).toMatchObject({ page: 'texture', variant: 'b', utm: { utm_source: 'tiktok', utm_content: 'texture-01' } });
    expect(e!.props).toMatchObject({ inApp: true, device: 'mobile', returning: false, adId: '987' });
  });

  it('the proxy’s routing table lists live pages (and the default) with their variants', async () => {
    const table = await landingTable(Date.now() + 10 * 60_000); // past any cached copy
    expect(table?.some((p) => p.slug === 'default')).toBe(true);
    const [paused] = await ownerPool()`select slug from landing_pages where status <> 'live' and slug <> 'default' limit 1`;
    if (paused) expect(table?.some((p) => p.slug === paused.slug)).toBe(false);
    for (const p of table ?? []) expect(Array.isArray(p.variants) && Array.isArray(p.utmMatch)).toBe(true);
  });
});
