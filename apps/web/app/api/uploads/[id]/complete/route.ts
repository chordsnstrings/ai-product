import { z } from 'zod';
import { withTenant } from '@arkiv/db';
import { completePhotoUpload } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { body, clientFingerprint, json, route } from '@/lib/http';
import { previewContext } from '@/lib/preview-context';

/**
 * The browser's PUT finished: validate the quarantined bytes (type, size, pixels; re-encoded without EXIF/GPS) and
 * keep them as a product photo the preview can use. A file we can't use comes back as 422 with the reason; a PUT
 * that never arrived is 409 so the browser retries the upload.
 */
export const POST = route(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError('NOT_FOUND', 'Upload not found. Please add the photo again.');
  const i = await body(req, z.object({ filename: z.string().max(200).nullish() }));
  const ctx = await previewContext(clientFingerprint(req), { create: false });
  const r = await withTenant(ctx.workspaceId, (tx) => completePhotoUpload(tx, ctx, id, i.filename ?? null));
  if ('error' in r) return json({ error: r.error, code: /didn’t finish/.test(r.error) ? 'INCOMPLETE' : 'INVALID' }, /didn’t finish/.test(r.error) ? 409 : 422);
  return json({ assetId: r.assetId });
});
