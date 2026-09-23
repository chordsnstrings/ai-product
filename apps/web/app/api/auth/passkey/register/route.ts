import { z } from 'zod';
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from '@arkiv/auth';
import { DomainError } from '@arkiv/shared';
import { body, json, route } from '@/lib/http';
import { currentUser } from '@/lib/session';

/** GET-less two-step: {step:'options'} then {step:'verify', response}. Signed-in users only. */
export const POST = route(async (req) => {
  const u = await currentUser();
  if (!u) throw new DomainError('UNAUTHENTICATED', 'Please sign in.');
  const input = await body(req, z.object({ step: z.enum(['options', 'verify']), response: z.any().optional(), name: z.string().max(60).optional() }));
  if (input.step === 'options') return json(await passkeyRegistrationOptions({ userId: u.userId, email: u.email }));
  await verifyPasskeyRegistration({ userId: u.userId }, input.response, input.name);
  return json({ ok: true });
});
