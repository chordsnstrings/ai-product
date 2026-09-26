import { z } from 'zod';
import { assertFreshReauth, staffPasskeyRegistrationOptions, verifyStaffPasskeyRegistration, type StaffAttestation } from '@arkiv/auth';
import { assertSameOrigin, body, errorResponse, json } from '@/lib/http';
import { apiStaff } from '@/lib/staff';

const Step = z.discriminatedUnion('step', [
  z.object({ step: z.literal('options') }),
  z.object({ step: z.literal('verify'), response: z.record(z.string(), z.unknown()), name: z.string().max(60).optional() }),
]);

/** Add a passkey to your own staff account. Adding a factor needs a fresh second factor first (🔐). */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const i = await body(req, Step);
    const s = await apiStaff();
    assertFreshReauth(s);
    if (i.step === 'options') return json(await staffPasskeyRegistrationOptions(s));
    const id = await verifyStaffPasskeyRegistration(s, i.response as unknown as StaffAttestation, i.name ?? null);
    return json({ ok: true, id, message: 'Passkey added. Use it to sign in and to confirm 🔐 actions.' });
  } catch (e) {
    return errorResponse(e);
  }
}
