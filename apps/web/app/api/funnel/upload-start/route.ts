import { z } from 'zod';
import { allowKey, hit, recordFunnelOnce } from '@arkiv/core';
import { body, clientIp, json, route } from '@/lib/http';
import { visitorId } from '@/lib/session';

/**
 * Upload intent beacon (standard §7 "Upload started"; plan 04 §1 S2): sent once when the visitor first adds a photo
 * or a product link, before anything is uploaded. It is the same start as the submit (/api/preview) — whichever
 * arrives first is recorded, once per visitor per 30 minutes — so starts that never reach the server (a photo that
 * fails in transit, a closed tab) are counted.
 */
export const POST = route(async (req) => {
  const b = await body(req, z.object({ page: z.string().max(80).nullish(), variant: z.string().max(40).nullish(), method: z.enum(['url', 'photos']) }));
  const vid = await visitorId();
  const ip = clientIp(req);
  await hit(`funnel:upload-start:v:${vid}`, 20, 3600);
  if (ip) await hit(`funnel:upload-start:ip:${ip}`, 200, 3600, undefined, { subject: [allowKey.ip(ip)] });
  const recorded = await recordFunnelOnce('UPLOAD_STARTED', { visitorId: vid, page: b.page ?? null, variant: b.variant ?? null, props: { method: b.method, via: 'intent' } });
  return json({ ok: true, recorded });
});
