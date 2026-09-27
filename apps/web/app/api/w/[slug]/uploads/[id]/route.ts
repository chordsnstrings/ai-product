import { withTenant } from '@arkiv/db';
import { mediaUploadStatus } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { json, route } from '@/lib/http';
import { workspaceBySlug } from '@/lib/tenant';

/** Resume: which parts of an upload are stored already, with fresh URLs for the rest. */
export const GET = route(async (_req, { params }: { params: Promise<{ slug: string; id: string }> }) => {
  const { slug, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError('NOT_FOUND', 'Upload not found. Please add the file again.');
  const w = await workspaceBySlug(slug);
  return json(await withTenant(w.ctx.workspaceId, (tx) => mediaUploadStatus(tx, w.ctx, id)));
});
