import { z } from 'zod';
import { acceptStaffInvite } from '@arkiv/auth';
import { hit } from '@arkiv/core';
import { assertSameOrigin, body, errorResponse, json } from '@/lib/http';
import { requestMeta } from '@/lib/staff';

/** Plan 05 §23: the invitee sets their own password and confirms their authenticator with a code. Single use. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const i = await body(req, z.object({ token: z.string().min(20).max(200), password: z.string().min(14, 'Use at least 14 characters.').max(200), code: z.string().min(6).max(8) }));
    const meta = await requestMeta();
    if (meta.ip) await hit(`staff-invite:${meta.ip}`, 10, 900);
    await hit(`staff-invite:${i.token.slice(0, 16)}`, 10, 900);
    await acceptStaffInvite(i.token, i.password, i.code.replace(/\s/g, ''), meta);
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
