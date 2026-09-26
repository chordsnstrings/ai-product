import { withTenant } from '@arkiv/db';
import { completeMediaUpload } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { json, route } from '@/lib/http';
import { workspaceBySlug } from '@/lib/tenant';

/**
 * Every part was PUT: assemble the upload in quarantine. Parts that never arrived come back as 409 with their
 * numbers, so the browser sends just those and completes again.
 */
export const POST = route(async (_req, { params }: { params: Promise<{ slug: string; id: string }> }) => {
  const { slug, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError('NOT_FOUND', 'Upload not found. Please add the file again.');
  const w = await workspaceBySlug(slug);
  const r = await withTenant(w.ctx.workspaceId, (tx) => completeMediaUpload(tx, w.ctx, id));
  if (r.missing?.length) return json({ error: 'Some of the file hasn’t arrived yet.', code: 'INCOMPLETE', missing: r.missing }, 409);
  return json({ uploadId: r.uploadId });
});
