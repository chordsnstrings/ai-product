import { z } from 'zod';
import { getStaffSession, STAFF_COOKIE, staffReauth } from '@arkiv/auth';
import { cookies } from 'next/headers';
import { DomainError } from '@arkiv/shared';
import { assertSameOrigin, body, errorResponse, json } from '@/lib/http';

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { code } = await body(req, z.object({ code: z.string().min(6).max(8) }));
    const s = await getStaffSession((await cookies()).get(STAFF_COOKIE)?.value);
    if (!s) throw new DomainError('UNAUTHENTICATED', 'Session expired');
    await staffReauth(s, code);
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
