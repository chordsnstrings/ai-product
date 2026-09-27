import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { startPreview } from './analysis';
import { storage } from './storage';
import { ctxFor, productPhoto } from './testing';
import { completePhotoUpload, startPhotoUploads } from './uploads';

beforeEach(truncateAll);
afterAll(closeAll);

/** What the browser's presigned PUT does: bytes into the quarantine key. */
async function browserPut(uploadId: string, bytes: Buffer) {
  const [u] = await ownerPool()`select quarantine_key from uploads where id = ${uploadId}`;
  await storage().put(u!.quarantine_key as string, bytes, 'image/jpeg');
}

describe('photos upload as they are chosen (plan 03 P2, plan 06 Phase 1 #3)', () => {
  it('presigns into quarantine, validates on completion, and the preview uses the resulting photos', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const [a, b] = await withTenant(t.workspaceId, (tx) => startPhotoUploads(tx, ctx, [{ mime: 'image/jpeg', bytes: 200_000 }, { mime: '', bytes: 1000 }]));
    expect(a!.putUrl).toContain('/api/files/upload?');
    expect(new URL(a!.putUrl).searchParams.get('key')).toMatch(new RegExp(`^q/${t.workspaceId}/`));

    // Completing before the bytes arrived (offline mid-upload): nothing is lost, the browser just retries.
    expect(await withTenant(t.workspaceId, (tx) => completePhotoUpload(tx, ctx, a!.uploadId, 'front.jpg'))).toEqual({ error: expect.stringMatching(/didn’t finish/) });
    expect((await ownerPool()`select status from uploads where id = ${a!.uploadId}`)[0]!.status).toBe('pending');

    await browserPut(a!.uploadId, await productPhoto());
    const done = await withTenant(t.workspaceId, (tx) => completePhotoUpload(tx, ctx, a!.uploadId, 'front.jpg'));
    expect(done).toEqual({ assetId: expect.any(String) });
    expect(await withTenant(t.workspaceId, (tx) => completePhotoUpload(tx, ctx, a!.uploadId, 'front.jpg'))).toEqual(done); // idempotent
    const [asset] = await ownerPool()`select kind, sku_id, storage_key, origin from assets where id = ${(done as { assetId: string }).assetId}`;
    expect(asset).toMatchObject({ kind: 'product_photo', sku_id: null, origin: { filename: 'front.jpg' } });
    expect(asset!.storage_key).toMatch(new RegExp(`^t/${t.workspaceId}/`));

    // Not an image: rejected with a reason, and the rejection sticks.
    await browserPut(b!.uploadId, Buffer.from('not really a photo'));
    expect(await withTenant(t.workspaceId, (tx) => completePhotoUpload(tx, ctx, b!.uploadId, 'x.heic'))).toEqual({ error: expect.any(String) });
    expect((await ownerPool()`select status from uploads where id = ${b!.uploadId}`)[0]!.status).toBe('rejected');

    const { skuId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [(done as { assetId: string }).assetId] }));
    expect((await ownerPool()`select sku_id from assets where id = ${(done as { assetId: string }).assetId}`)[0]!.sku_id).toBe(skuId);
  });

  it('refuses other types, too many files, viewers and other tenants’ uploads', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    await expect(withTenant(t.workspaceId, (tx) => startPhotoUploads(tx, ctx, [{ mime: 'application/pdf', bytes: 10 }]))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(withTenant(t.workspaceId, (tx) => startPhotoUploads(tx, ctx, Array.from({ length: 7 }, () => ({ mime: 'image/png', bytes: 10 }))))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(withTenant(t.workspaceId, (tx) => startPhotoUploads(tx, ctxFor(t.workspaceId, t.userId, 'VIEWER'), [{ mime: 'image/png', bytes: 10 }]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [u] = await withTenant(t.workspaceId, (tx) => startPhotoUploads(tx, ctx, [{ mime: 'image/png', bytes: 10 }]));
    const other = await makeTenant();
    await expect(withTenant(other.workspaceId, (tx) => completePhotoUpload(tx, ctxFor(other.workspaceId, other.userId), u!.uploadId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
