import { z } from 'zod';
import { cookies } from 'next/headers';
import { STAFF_COOKIE, staffPasskeyLogin, staffPasskeyLoginOptions, type StaffAssertion } from '@arkiv/auth';
import { hit } from '@arkiv/core';
import { env } from '@arkiv/shared';
import { assertSameOrigin, body, errorResponse, json } from '@/lib/http';
import { requestMeta } from '@/lib/staff';

const Step = z.discriminatedUnion('step', [
  z.object({ step: z.literal('options'), email: z.string().email(), password: z.string().min(1).max(200) }),
  z.object({ step: z.literal('verify'), flow: z.string().min(10).max(64), response: z.record(z.string(), z.unknown()) }),
]);

/**
 * Password + passkey sign-in (plan 05 §0.1). Step 1 checks the password and returns WebAuthn options bound to
 * that account; step 2 verifies the assertion and opens the session. Rate-limited like the TOTP sign-in.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const i = await body(req, Step);
    const meta = await requestMeta();
    if (meta.ip) await hit(`staff-login:${meta.ip}`, 10, 900);
    if (i.step === 'options') {
      await hit(`staff-login:${i.email.toLowerCase()}`, 10, 900);
      return json(await staffPasskeyLoginOptions(i.email, i.password, meta));
    }
    const token = await staffPasskeyLogin(i.flow, i.response as unknown as StaffAssertion, meta);
    (await cookies()).set(STAFF_COOKIE, token, { httpOnly: true, secure: env().NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 8 * 3600 });
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
