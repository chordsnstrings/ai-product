import { uploadCreatorFootage } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { json, route } from '@/lib/http';

/**
 * A creator uploads footage back through their Creator Pack link (standard §26). No account: the live, unrevoked
 * link is the authority, and the footage lands on the pack's product with the creator's rights attestation,
 * validated and re-encoded like any upload (never served from quarantine).
 */
export const POST = route(async (req, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params;
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) throw new DomainError('INVALID', 'Choose a video or photo to upload.');
  const r = await uploadCreatorFootage(token, { bytes: Buffer.from(await file.arrayBuffer()), filename: file.name }, { name: String(form.get('name') ?? ''), rightsAttested: form.get('rights') === 'on' || form.get('rights') === 'true' });
  return json({ ok: true, assetId: r.assetId });
});
