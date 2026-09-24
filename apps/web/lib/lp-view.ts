import { deviceClass, recordFunnel } from '@arkiv/core';
import { geoFromHeaders } from '@arkiv/shared';

/**
 * One landing view (standard §7 "Click / landing view"; plan 05 §4 slices): the page and copy variant, the
 * campaign's UTMs, device class, edge country/region, new vs returning, and the ad (creative) id the campaign
 * passes (ad_id, or the utm_id macro). Recorded by the dynamic page as it renders and, for the static page, by its
 * view beacon.
 */
export async function recordLandingView(input: { visitorId: string; page: string | null; variant: string | null; search: URLSearchParams; headers: Headers; returning: boolean }) {
  const utm = Object.fromEntries([...input.search.entries()].filter(([k]) => k.startsWith('utm_')).map(([k, v]) => [k, v.slice(0, 200)]));
  const ua = input.headers.get('user-agent') ?? '';
  const geo = geoFromHeaders(input.headers);
  const adId = (input.search.get('ad_id') ?? input.search.get('utm_id') ?? '').slice(0, 64) || null;
  await recordFunnel('LP_VIEWED', {
    visitorId: input.visitorId,
    page: input.page,
    variant: input.variant,
    utm,
    props: { inApp: /Instagram|FBAN|FBAV|TikTok|musical_ly|BytedanceWebview/i.test(ua), device: deviceClass(ua), country: geo?.country ?? null, region: geo?.region ?? null, returning: input.returning, adId },
  });
}
