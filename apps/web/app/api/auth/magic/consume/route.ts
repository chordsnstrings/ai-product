import { z } from 'zod';
import { assertLoginBudget, consumeMagicLink } from '@arkiv/auth';
import { geoFromHeaders } from '@arkiv/shared';
import { afterLogin } from '@/lib/after-login';
import { body, clientIp, json, route } from '@/lib/http';
import { clearProvisionalCookie, setSessionCookie } from '@/lib/session';

/** POST-only consumption: email scanners that prefetch the GET page never burn the link. */
export const POST = route(async (req) => {
  const { token, turnstile } = await body(req, z.object({ token: z.string().min(20).max(200), turnstile: z.string().max(4096).nullish() }));
  const ip = clientIp(req);
  await assertLoginBudget(ip, turnstile);
  const r = await consumeMagicLink(token, { ip, userAgent: req.headers.get('user-agent'), geo: geoFromHeaders(req.headers) });
  await setSessionCookie(r.token);
  const next = await afterLogin({ userId: r.userId }, r.provisionalWorkspaceId, r.redirectTo, 'magic_link');
  // The preview cookie stays while the existing-account choice (/start/claim) is still open.
  if (r.provisionalWorkspaceId && !next.startsWith('/start/claim?c=')) await clearProvisionalCookie();
  return json({ next, created: r.created });
});
