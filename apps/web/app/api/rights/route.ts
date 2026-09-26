import { globalTx } from '@arkiv/db';
import { assertNotBlocked, submitRightsComplaint } from '@arkiv/core';
import { DomainError, env } from '@arkiv/shared';
import { clientIp } from '@/lib/http';

/** The public rights / takedown form (plan 05 §15): files a case and returns to the form page. */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const field = (k: string) => String(form?.get(k) ?? '');
  const ip = clientIp(req);
  try {
    await assertNotBlocked(ip);
    await globalTx((tx) => submitRightsComplaint(tx, { name: field('name'), email: field('email'), detail: field('detail'), url: field('url') || null, ip }));
    return back('done');
  } catch (e) {
    if (e instanceof DomainError) return back(e.code === 'RATE_LIMITED' ? 'limited' : e.code === 'FORBIDDEN' ? 'blocked' : 'invalid');
    throw e;
  }
}

function back(state: string): Response {
  const u = new URL('/rights', env().APP_URL);
  u.searchParams.set('state', state);
  return Response.redirect(u.toString(), 303);
}
