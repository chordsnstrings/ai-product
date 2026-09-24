import { z } from 'zod';
import { cookies } from 'next/headers';
import { STAFF_COOKIE, staffLogin } from '@arkiv/auth';
import { hit } from '@arkiv/core';
import { env } from '@arkiv/shared';
import { assertSameOrigin, body, errorResponse, json } from '@/lib/http';
import { requestMeta } from '@/lib/staff';

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const i = await body(req, z.object({ email: z.string().email(), password: z.string().min(1).max(200), code: z.string().min(6).max(8) }));
    const meta = await requestMeta();
    // Per-IP limit only when the proxy tells us the IP; a shared 'unknown' bucket would lock out every staff member.
    if (meta.ip) await hit(`staff-login:${meta.ip}`, 10, 900);
    await hit(`staff-login:${i.email.toLowerCase()}`, 10, 900);
    const token = await staffLogin(i.email, i.password, i.code, meta);
    (await cookies()).set(STAFF_COOKIE, token, { httpOnly: true, secure: env().NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 8 * 3600 });
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
