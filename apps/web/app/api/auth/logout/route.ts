import { revokeSession } from '@arkiv/auth';
import { json, route } from '@/lib/http';
import { clearSessionCookie, currentUser } from '@/lib/session';

export const POST = route(async () => {
  const u = await currentUser();
  if (u) await revokeSession(u.sessionId, u.userId);
  await clearSessionCookie();
  return json({ next: '/' });
});
