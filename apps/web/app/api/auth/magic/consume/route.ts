import { z } from 'zod';
import { consumeMagicLink } from '@arkiv/auth';
import { geoFromHeaders } from '@arkiv/shared';
import { afterLogin } from '@/lib/after-login';
import { body, clientIp, json, route } from '@/lib/http';
import { clearProvisionalCookie, setSessionCookie } from '@/lib/session';

/** POST-only consumption: email scanners that prefetch the GET page never burn the link. */
export const POST = route(async (req) => {
  const { token } = await body(req, z.object({ token: z.string().min(20).max(200) }));
  const r = await consumeMagicLink(token, { ip: clientIp(req), userAgent: req.headers.get('user-agent'), geo: geoFromHeaders(req.headers) });
  await setSessionCookie(r.token);
  const next = await afterLogin({ userId: r.userId }, r.provisionalWorkspaceId, r.redirectTo);
  if (r.provisionalWorkspaceId) await clearProvisionalCookie();
  return json({ next, created: r.created });
});
