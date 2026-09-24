import { z } from 'zod';
import { decideOwnershipTransfer } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { body, clientIp, json, route } from '@/lib/http';
import { currentUser } from '@/lib/session';

/** A current Owner confirms or declines a staff-requested ownership transfer (plan 05 §2.2). */
export const POST = route(async (req, { params }: { params: Promise<{ token: string }> }) => {
  const u = await currentUser();
  if (!u) throw new DomainError('UNAUTHENTICATED', 'Please log in.');
  const { confirm } = await body(req, z.object({ confirm: z.boolean() }));
  const r = await decideOwnershipTransfer((await params).token, { id: u.userId }, confirm, { ip: clientIp(req), userAgent: req.headers.get('user-agent') });
  return json({ confirmed: r.confirmed, next: `/w/${r.slug}/settings/members` });
});
