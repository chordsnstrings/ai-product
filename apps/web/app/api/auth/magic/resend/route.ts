import { z } from 'zod';
import { resendMagicLink } from '@arkiv/auth';
import { body, clientIp, json, route } from '@/lib/http';

/** One-tap resend from an expired or used sign-in link (plan 03 P6): a fresh link to the same address. */
export const POST = route(async (req) => {
  const { token } = await body(req, z.object({ token: z.string().min(16).max(128) }));
  return json(await resendMagicLink(token, clientIp(req)));
});
