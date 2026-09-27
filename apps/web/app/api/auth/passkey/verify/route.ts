import { z } from 'zod';
import { assertLoginBudget, verifyPasskeyLogin } from '@arkiv/auth';
import { resolveProvisional } from '@arkiv/core';
import { geoFromHeaders } from '@arkiv/shared';
import { afterLogin } from '@/lib/after-login';
import { body, clientIp, json, route } from '@/lib/http';
import { clearProvisionalCookie, provisionalToken, setSessionCookie } from '@/lib/session';

export const POST = route(async (req) => {
  const input = await body(req, z.object({ flow: z.string().max(64), response: z.any(), next: z.string().max(300).nullish(), turnstile: z.string().max(4096).nullish() }));
  const ip = clientIp(req);
  await assertLoginBudget(ip, input.turnstile);
  const r = await verifyPasskeyLogin(input.flow, input.response, { ip, userAgent: req.headers.get('user-agent'), geo: geoFromHeaders(req.headers) });
  await setSessionCookie(r.token);
  const prov = await resolveProvisional(await provisionalToken());
  // afterLogin keeps only a same-site path (safeRedirect).
  const next = await afterLogin({ userId: r.userId }, prov, input.next ?? null, 'passkey');
  if (prov && !next.startsWith('/start/claim?c=')) await clearProvisionalCookie();
  return json({ next });
});
