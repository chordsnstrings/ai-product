import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { storage } from './storage';
import { ctxFor, productPhoto } from './testing';
import { completeMediaUpload, consumeMediaUpload, mediaUploadStatus, startMediaUpload, sweepStaleUploads, UPLOAD_PART_SIZE, uploadedFile } from './uploads';

/**
 * Resumable uploads for workspace forms (plan 06 Phase 0 D7 "quarantine → validate → tenant prefix; signed URLs";
 * Phase 1 D3 "resumable uploads"), on the local storage driver's multipart emulation.
 */
beforeEach(truncateAll);
afterAll(closeAll);

/** What the browser's PUT to a presigned (local) URL stores. */
const browserPut = (url: string, bytes: Buffer) => storage().put(new URL(url).searchParams.get('key')!, bytes, 'application/octet-stream');
const partOf = (file: Buffer, n: number) => file.subarray((n - 1) * UPLOAD_PART_SIZE, n * UPLOAD_PART_SIZE);

describe('resumable uploads', () => {
  it('sends a large file in parts, resumes with only the missing ones, assembles it in quarantine and hands it to the form once', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const file = Buffer.alloc(UPLOAD_PART_SIZE * 2 + 1234);
    for (let i = 0; i < file.length; i += 4096) file[i] = (i / 4096) % 251;
    const up = await withTenant(t.workspaceId, (tx) => startMediaUpload(tx, ctx, { mime: 'video/mp4', bytes: file.length, filename: 'ugc.mp4' }));
    expect(up).toMatchObject({ partSize: UPLOAD_PART_SIZE, partCount: 3, received: [] });
    expect(up.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    for (const p of up.parts) expect(new URL(p.url).searchParams.get('key')).toMatch(new RegExp(`^q/${t.workspaceId}/${up.uploadId}\\.parts/`));

    // The connection drops after parts 1 and 3.
    await browserPut(up.parts[0]!.url, partOf(file, 1));
    await browserPut(up.parts[2]!.url, partOf(file, 3));
    expect(await withTenant(t.workspaceId, (tx) => completeMediaUpload(tx, ctx, up.uploadId))).toEqual({ uploadId: up.uploadId, missing: [2] });
    const resumed = await withTenant(t.workspaceId, (tx) => mediaUploadStatus(tx, ctx, up.uploadId));
    expect(resumed).toMatchObject({ status: 'pending', received: [1, 3] });
    expect(resumed.parts.map((p) => p.partNumber)).toEqual([2]);
    await browserPut(resumed.parts[0]!.url, partOf(file, 2));
    expect(await withTenant(t.workspaceId, (tx) => completeMediaUpload(tx, ctx, up.uploadId))).toEqual({ uploadId: up.uploadId });
    expect(await withTenant(t.workspaceId, (tx) => completeMediaUpload(tx, ctx, up.uploadId))).toEqual({ uploadId: up.uploadId }); // idempotent

    const got = await withTenant(t.workspaceId, (tx) => uploadedFile(tx, ctx, up.uploadId));
    expect(got).toMatchObject({ filename: 'ugc.mp4', mime: 'video/mp4' });
    expect(got.bytes.equals(file)).toBe(true);
    const [row] = await ownerPool()`select quarantine_key, status from uploads where id = ${up.uploadId}`;
    expect(row!.status).toBe('quarantined');
    await withTenant(t.workspaceId, (tx) => consumeMediaUpload(tx, ctx, up.uploadId));
    expect((await ownerPool()`select status from uploads where id = ${up.uploadId}`)[0]!.status).toBe('accepted');
    expect(await storage().exists(row!.quarantine_key as string)).toBe(false);
    await expect(withTenant(t.workspaceId, (tx) => uploadedFile(tx, ctx, up.uploadId))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a file whose stored size isn’t what was declared, and a single-part upload that never arrived', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const up = await withTenant(t.workspaceId, (tx) => startMediaUpload(tx, ctx, { mime: 'video/mp4', bytes: UPLOAD_PART_SIZE + 10 }));
    await browserPut(up.parts[0]!.url, Buffer.alloc(UPLOAD_PART_SIZE));
    await browserPut(up.parts[1]!.url, Buffer.alloc(99));
    await expect(withTenant(t.workspaceId, (tx) => completeMediaUpload(tx, ctx, up.uploadId))).rejects.toMatchObject({ code: 'INVALID' });

    const photo = await productPhoto();
    const one = await withTenant(t.workspaceId, (tx) => startMediaUpload(tx, ctx, { mime: 'image/jpeg', bytes: photo.length, filename: 'front.jpg' }));
    expect(one.partCount).toBe(1);
    expect(await withTenant(t.workspaceId, (tx) => completeMediaUpload(tx, ctx, one.uploadId))).toEqual({ uploadId: one.uploadId, missing: [1] });
    await expect(withTenant(t.workspaceId, (tx) => uploadedFile(tx, ctx, one.uploadId))).rejects.toMatchObject({ code: 'CONFLICT' }); // not finished
    await browserPut(one.parts[0]!.url, photo);
    expect(await withTenant(t.workspaceId, (tx) => completeMediaUpload(tx, ctx, one.uploadId))).toEqual({ uploadId: one.uploadId });
    // Types and sizes are checked before anything is stored.
    await expect(withTenant(t.workspaceId, (tx) => startMediaUpload(tx, ctx, { mime: 'text/html', bytes: 10 }))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(withTenant(t.workspaceId, (tx) => startMediaUpload(tx, ctx, { mime: 'image/jpeg', bytes: 26 * 1024 * 1024 }))).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('keeps each workspace’s uploads to itself, and a Viewer can’t upload', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const ctxA = ctxFor(a.workspaceId, a.userId);
    const ctxB = ctxFor(b.workspaceId, b.userId);
    const up = await withTenant(a.workspaceId, (tx) => startMediaUpload(tx, ctxA, { mime: 'application/pdf', bytes: 1000 }));
    await expect(withTenant(b.workspaceId, (tx) => mediaUploadStatus(tx, ctxB, up.uploadId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(withTenant(b.workspaceId, (tx) => completeMediaUpload(tx, ctxB, up.uploadId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(withTenant(b.workspaceId, (tx) => uploadedFile(tx, ctxB, up.uploadId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(withTenant(a.workspaceId, (tx) => startMediaUpload(tx, { ...ctxA, role: 'VIEWER' }, { mime: 'application/pdf', bytes: 1000 }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('removes uploads nobody used from quarantine after a day', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const up = await withTenant(t.workspaceId, (tx) => startMediaUpload(tx, ctx, { mime: 'video/mp4', bytes: UPLOAD_PART_SIZE * 2 }));
    await browserPut(up.parts[0]!.url, Buffer.alloc(UPLOAD_PART_SIZE));
    const fresh = await withTenant(t.workspaceId, (tx) => startMediaUpload(tx, ctx, { mime: 'application/pdf', bytes: 10 }));
    await ownerPool()`update uploads set created_at = now() - interval '25 hours' where id = ${up.uploadId}`;
    expect(await withSystem((tx) => sweepStaleUploads(tx))).toBe(1);
    const rows = await ownerPool()`select id, status, reject_reason from uploads order by created_at`;
    expect(rows.map((r) => [r.id, r.status])).toEqual([[up.uploadId, 'rejected'], [fresh.uploadId, 'pending']]);
    expect(await storage().listParts(`q/${t.workspaceId}/${up.uploadId}`, (await ownerPool()`select multipart_id from uploads where id = ${up.uploadId}`)[0]!.multipart_id as string)).toEqual([]);
  });
});
