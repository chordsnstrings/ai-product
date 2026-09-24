import { magicLinkStatus } from '@arkiv/auth';
import { hit } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { clientIp, json, route } from '@/lib/http';
import { currentUser } from '@/lib/session';

/**
 * Whether the sign-in link this tab asked for was used (plan 03 P6: "Link opened on a different device → … the
 * original tab updates via polling"). The tab polls with the random handle it got when it asked for the link;
 * `signedIn` tells it whether this browser now has a session (the link was opened in another tab here).
 */
export const GET = route(async (req) => {
  const handle = new URL(req.url).searchParams.get('handle') ?? '';
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(handle)) throw new DomainError('INVALID', 'Invalid handle');
  // A tab polls every few seconds for at most the link's lifetime.
  await hit(`magic:status:${clientIp(req) ?? 'unknown'}`, 600, 900);
  const status = await magicLinkStatus(handle);
  const signedIn = status === 'consumed' && !!(await currentUser());
  return json({ status, signedIn }, { headers: { 'Cache-Control': 'no-store' } });
});
