import { z } from 'zod';
import { globalTx, withTenant } from '@arkiv/db';
import { addToWaitlist, waitlistCategory } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { body, clientIp, json, route } from '@/lib/http';
import { visitorId } from '@/lib/session';
import { projectAccess } from '@/lib/tenant';

/**
 * Waitlist for a product we refused as out of scope (plan 03 P2). The reason and product come from the refused
 * SKU itself (the caller must have access to its project), never from the request.
 */
export const POST = route(async (req) => {
  const i = await body(req, z.object({ projectId: z.string().uuid(), email: z.string().max(254), consent: z.boolean() }));
  const a = await projectAccess(i.projectId);
  const [s] = await withTenant(a.ctx.workspaceId, (tx) => tx`select s.name, s.status, s.reject_reason from projects p join skus s on s.id = p.sku_id where p.id = ${i.projectId}`);
  if (!s || s.status !== 'rejected') throw new DomainError('CONFLICT', 'This product can be made into an ad — no need to wait.');
  const reason = (s.reject_reason as string | null) ?? null;
  const vid = await visitorId();
  const r = await globalTx((tx) =>
    addToWaitlist(tx, { email: i.email, consent: i.consent, category: waitlistCategory(reason), reason, productName: (s.name as string) ?? null, visitorId: vid, ip: clientIp(req) }),
  );
  return json({ ok: true, ...r });
});
