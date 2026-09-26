import { z } from 'zod';
import { cookies } from 'next/headers';
import { getStaffSession, STAFF_COOKIE, staffPasskeyReauth, staffPasskeyReauthOptions, staffReauth, type StaffAssertion } from '@arkiv/auth';
import { DomainError } from '@arkiv/shared';
import { assertSameOrigin, body, errorResponse, json } from '@/lib/http';
import { requestMeta } from '@/lib/staff';

const Input = z.union([
  z.object({ step: z.literal('options') }),
  z.object({ response: z.record(z.string(), z.unknown()) }),
  z.object({ code: z.string().min(6).max(8) }),
]);

/**
 * 🔐 re-authentication (plan 05 §0.1): `{ step: 'options' }` returns WebAuthn options when the staff member has
 * a passkey (null otherwise); `{ response }` verifies the passkey tap; `{ code }` takes an authenticator code
 * (refused for accounts that require a passkey).
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const i = await body(req, Input);
    const s = await getStaffSession((await cookies()).get(STAFF_COOKIE)?.value, { ip: (await requestMeta()).ip });
    if (!s) throw new DomainError('UNAUTHENTICATED', 'Session expired');
    if ('step' in i) return json({ options: await staffPasskeyReauthOptions(s) });
    if ('response' in i) await staffPasskeyReauth(s, i.response as unknown as StaffAssertion);
    else await staffReauth(s, i.code);
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
