import { z } from 'zod';
import { passkeyRegistrationOptions, rotateSession, verifyPasskeyRegistration } from '@arkiv/auth';
import { recordFunnel } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { body, json, route } from '@/lib/http';
import { currentUser, setSessionCookie } from '@/lib/session';

/** GET-less two-step: {step:'options'} then {step:'verify', response}. Signed-in users only. */
export const POST = route(async (req) => {
  const u = await currentUser();
  if (!u) throw new DomainError('UNAUTHENTICATED', 'Please sign in.');
  const input = await body(req, z.object({ step: z.enum(['options', 'verify']), response: z.any().optional(), name: z.string().max(60).optional(), source: z.enum(['profile', 'prompt']).optional() }));
  if (input.step === 'options') return json(await passkeyRegistrationOptions({ userId: u.userId, email: u.email }));
  await verifyPasskeyRegistration({ userId: u.userId }, input.response, input.name);
  // A new sign-in method is a privilege change: the session is rotated (plan 03 Part C).
  const s = await rotateSession(u.sessionId, u.userId);
  await setSessionCookie(s.token);
  if (input.source === 'prompt') await recordFunnel('PASSKEY_ADDED', { workspaceId: u.lastWorkspaceId, props: { source: 'post_purchase_prompt' } }).catch(() => {});
  return json({ ok: true });
});
