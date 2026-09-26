import { cookies } from 'next/headers';
import { z } from 'zod';
import { allowKey, hit } from '@arkiv/core';
import { body, clientIp, json, route } from '@/lib/http';
import { FIRST_VIEW_COOKIE } from '@/lib/landing-routing';
import { recordLandingView } from '@/lib/lp-view';
import { hasVisitorCookie, visitorId } from '@/lib/session';

/**
 * Landing view beacon of the static campaign pages (plan 04 L6): the cached page can't record who viewed it, so it
 * reports the view once it has shown. The visitor id is the first-party cookie the proxy set before the page; the
 * proxy's first-view marker makes this view "new", once.
 */
export const POST = route(async (req) => {
  const b = await body(req, z.object({ page: z.string().max(80), variant: z.string().max(40).nullish(), search: z.string().max(1000).default('') }));
  const vid = await visitorId();
  const ip = clientIp(req);
  await hit(`funnel:lp-view:v:${vid}`, 60, 3600);
  if (ip) await hit(`funnel:lp-view:ip:${ip}`, 600, 3600, undefined, { subject: [allowKey.ip(ip)] });
  const jar = await cookies();
  const firstView = !!jar.get(FIRST_VIEW_COOKIE)?.value;
  const returning = (await hasVisitorCookie()) && !firstView;
  await recordLandingView({ visitorId: vid, page: b.page, variant: b.variant ?? null, search: new URLSearchParams(b.search), headers: req.headers, returning });
  if (firstView) jar.delete(FIRST_VIEW_COOKIE);
  return json({ ok: true });
});
