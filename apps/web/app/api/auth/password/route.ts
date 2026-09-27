import { z } from 'zod';
import { assertLoginBudget, passwordLogin } from '@arkiv/auth';
import { resolveProvisional } from '@arkiv/core';
import { geoFromHeaders } from '@arkiv/shared';
import { afterLogin } from '@/lib/after-login';
import { body, clientIp, json, route } from '@/lib/http';
import { clearProvisionalCookie, provisionalToken, setSessionCookie } from '@/lib/session';

/** "Use password" (plan 03 Part C, only for users who set one in Profile). Same per-IP budget as every sign-in. */
export const POST = route(async (req) => {
  const input = await body(req, z.object({ email: z.string().max(254), password: z.string().min(1).max(200), next: z.string().max(300).nullish(), turnstile: z.string().max(4096).nullish() }));
  const ip = clientIp(req);
  await assertLoginBudget(ip, input.turnstile);
  const r = await passwordLogin(input.email, input.password, { ip, userAgent: req.headers.get('user-agent'), geo: geoFromHeaders(req.headers) });
  await setSessionCookie(r.token);
  const prov = await resolveProvisional(await provisionalToken());
  const next = await afterLogin({ userId: r.userId }, prov, input.next ?? null, 'password');
  if (prov && !next.startsWith('/start/claim?c=')) await clearProvisionalCookie();
  return json({ next });
});
