import { cookies } from 'next/headers';
import { STAFF_COOKIE, staffLogoutToken } from '@arkiv/auth';
import { json } from '@/lib/http';

/** Ends the session behind the cookie (even one a network policy currently blocks) and clears the cookie. */
export async function POST() {
  const jar = await cookies();
  await staffLogoutToken(jar.get(STAFF_COOKIE)?.value);
  jar.delete(STAFF_COOKIE);
  return json({ ok: true });
}
