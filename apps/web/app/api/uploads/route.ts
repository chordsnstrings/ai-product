import { z } from 'zod';
import { withTenant } from '@arkiv/db';
import { assertNotBlocked, MAX_PREVIEW_PHOTOS, startPhotoUploads } from '@arkiv/core';
import { body, clientFingerprint, json, route } from '@/lib/http';
import { previewContext } from '@/lib/preview-context';

/**
 * Plan 03 P2: a photo starts uploading the moment it is chosen. Returns one presigned PUT into quarantine per file
 * (in the same workspace the preview will use); the browser PUTs the bytes, then calls /api/uploads/:id/complete.
 */
export const POST = route(async (req) => {
  const i = await body(req, z.object({ files: z.array(z.object({ mime: z.string().max(100), bytes: z.number().int().positive() })).min(1).max(MAX_PREVIEW_PHOTOS) }));
  const client = clientFingerprint(req);
  await assertNotBlocked(client.ip);
  const ctx = await previewContext(client, { create: true });
  const uploads = await withTenant(ctx.workspaceId, (tx) => startPhotoUploads(tx, ctx, i.files));
  return json({ uploads });
});
