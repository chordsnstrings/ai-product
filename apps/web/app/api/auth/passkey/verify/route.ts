import { z } from 'zod';
import { verifyPasskeyLogin } from '@arkiv/auth';
import { resolveProvisional } from '@arkiv/core';
import { geoFromHeaders } from '@arkiv/shared';
import { afterLogin } from '@/lib/after-login';
import { body, clientIp, json, route } from '@/lib/http';
import { clearProvisionalCookie, provisionalToken, setSessionCookie } from '@/lib/session';

export const POST = route(async (req) => {
  const input = await body(req, z.object({ flow: z.string().max(64), response: z.any(), next: z.string().max(300).nullish() }));
  const r = await verifyPasskeyLogin(input.flow, input.response, { ip: clientIp(req), userAgent: req.headers.get('user-agent'), geo: geoFromHeaders(req.headers) });
  await setSessionCookie(r.token);
  const prov = await resolveProvisional(await provisionalToken());
  const safeNext = input.next && input.next.startsWith('/') && !input.next.startsWith('//') ? input.next : null;
  const next = await afterLogin({ userId: r.userId }, prov, safeNext);
  if (prov) await clearProvisionalCookie();
  return json({ next });
});
