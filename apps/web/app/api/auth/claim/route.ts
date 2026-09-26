import { z } from 'zod';
import { readClaimToken, safeRedirect } from '@arkiv/auth';
import { DomainError } from '@arkiv/shared';
import { settleClaim } from '@/lib/after-login';
import { body, json, route } from '@/lib/http';
import { clearProvisionalCookie, currentUser } from '@/lib/session';

/**
 * The existing-account choice after sign-in (plan 02 §2.1): add the previewed product to one of your workspaces,
 * or keep it as a new workspace. The token from sign-in names the preview and is valid for this user only.
 */
export const POST = route(async (req) => {
  const u = await currentUser();
  if (!u) throw new DomainError('UNAUTHENTICATED', 'Please sign in.');
  const input = await body(req, z.object({ c: z.string().max(600), target: z.union([z.literal('new'), z.string().uuid()]), next: z.string().max(300).nullish() }));
  const claim = readClaimToken(input.c, u.userId);
  if (!claim) throw new DomainError('INVALID', 'This choice has expired. Your preview is still saved on the device you started on.');
  const r = await settleClaim(u.userId, claim.provisionalWorkspaceId, input.target, claim.method);
  await clearProvisionalCookie();
  return json({ next: safeRedirect(input.next) ?? '/app', workspaceId: r.workspaceId });
});
