import { z } from 'zod';
import { withTenant } from '@arkiv/db';
import { startMediaUpload } from '@arkiv/core';
import { body, json, route } from '@/lib/http';
import { workspaceBySlug } from '@/lib/tenant';

/**
 * Start a resumable upload for a workspace form (plan 06 Phase 0 D7 "quarantine → validate → tenant prefix; signed
 * URLs", Phase 1 D3 "resumable uploads"): the browser PUTs the file straight into quarantine, in parts when it is
 * large, then completes it and sends the form with the upload's id instead of the file.
 */
export const POST = route(async (req, { params }: { params: Promise<{ slug: string }> }) => {
  const w = await workspaceBySlug((await params).slug);
  const i = await body(req, z.object({ mime: z.string().max(100), bytes: z.number().int().positive(), filename: z.string().max(200).nullish() }));
  return json(await withTenant(w.ctx.workspaceId, (tx) => startMediaUpload(tx, w.ctx, { mime: i.mime, bytes: i.bytes, filename: i.filename ?? null })));
});
