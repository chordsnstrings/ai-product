import { passkeyLoginOptions } from '@arkiv/auth';
import { hit } from '@arkiv/core';
import { clientIp, json, route } from '@/lib/http';

/**
 * A passkey sign-in challenge. The login page asks for one on load for autofill (conditional UI), so this is not a
 * sign-in attempt itself — verify counts those — but each call stores a challenge, so it has its own ceiling.
 */
export const POST = route(async (req) => {
  await hit(`passkey:options:${clientIp(req) ?? 'unknown'}`, 60, 900);
  return json(await passkeyLoginOptions());
});
