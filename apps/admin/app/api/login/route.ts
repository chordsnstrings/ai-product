import { z } from 'zod';
import { cookies } from 'next/headers';
import { STAFF_COOKIE, staffLogin } from '@arkiv/auth';
import { hit } from '@arkiv/core';
import { env } from '@arkiv/shared';
import { assertSameOrigin, body, errorResponse, json } from '@/lib/http';

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const i = await body(req, z.object({ email: z.string().email(), password: z.string().min(1).max(200), code: z.string().min(6).max(8) }));
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    await hit(`staff-login:${ip ?? 'unknown'}`, 10, 900);
    await hit(`staff-login:${i.email.toLowerCase()}`, 10, 900);
    const token = await staffLogin(i.email, i.password, i.code, { ip, userAgent: req.headers.get('user-agent') });
    (await cookies()).set(STAFF_COOKIE, token, { httpOnly: true, secure: env().NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 8 * 3600 });
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
