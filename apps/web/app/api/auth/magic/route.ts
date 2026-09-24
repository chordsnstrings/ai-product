import { z } from 'zod';
import { assertLoginBudget, requestMagicLink } from '@arkiv/auth';
import { resolveProvisional } from '@arkiv/core';
import { withTenant } from '@arkiv/db';
import { body, clientIp, json, route } from '@/lib/http';
import { provisionalToken } from '@/lib/session';

/** Request a sign-in link. The anonymous preview (if any) rides along so it's saved on sign-in. */
export const POST = route(async (req) => {
  const input = await body(req, z.object({ email: z.string().max(254), next: z.string().max(300).nullish(), purpose: z.enum(['login', 'claim', 'resume']).default('login'), turnstile: z.string().max(4096).nullish() }));
  const ip = clientIp(req);
  // 10 sign-in attempts per IP per 15 minutes, then the human check (plan 03 Part C).
  await assertLoginBudget(ip, input.turnstile);
  const provisionalWorkspaceId = await resolveProvisional(await provisionalToken());
  let productName: string | null = null;
  if (provisionalWorkspaceId) {
    const [s] = await withTenant(provisionalWorkspaceId, (tx) => tx`select name from skus where status not in ('analyzing', 'needs_input') order by created_at desc limit 1`);
    productName = (s?.name as string) ?? null;
  }
  const r = await requestMagicLink({ email: input.email, purpose: provisionalWorkspaceId ? 'claim' : input.purpose, provisionalWorkspaceId, redirectTo: input.next ?? null, ip, productName });
  return json(r);
});
