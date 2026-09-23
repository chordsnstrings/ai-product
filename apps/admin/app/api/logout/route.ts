import { cookies } from 'next/headers';
import { STAFF_COOKIE, staffLogout } from '@arkiv/auth';
import { json } from '@/lib/http';
import { currentStaff } from '@/lib/staff';

export async function POST() {
  const s = await currentStaff();
  if (s) await staffLogout(s.sessionId);
  (await cookies()).delete(STAFF_COOKIE);
  return json({ ok: true });
}
