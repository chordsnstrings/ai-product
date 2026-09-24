import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { deleteAsset, saveAsset } from './assets';
import { attachEvidence, proposeClaim } from './claims';
import { emit } from './events';
import { storage } from './storage';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';
import { deletedUserActor, deleteUser } from './workspaces';

beforeEach(truncateAll);
afterAll(closeAll);

describe('deleting an uploaded asset (standard §40)', () => {
  it('removes the file and its bytes; evidence behind a claim is hidden but retained; generated work is refused', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    const photo = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', skuId));
    expect(await withTenant(t.workspaceId, (tx) => deleteAsset(tx, ctx, photo.id))).toEqual({ purged: true });
    expect(await storage().exists(photo.key)).toBe(false);
    const [row] = await ownerPool()`select deleted_at from assets where id = ${photo.id}`;
    expect(row!.deleted_at).not.toBeNull();
    const [ev] = await ownerPool()`select payload from events where subject_id = ${photo.id} and type = 'ASSET_DELETED'`;
    expect(ev!.payload).toMatchObject({ purged: true, kind: 'product_photo' });
    await expect(withTenant(t.workspaceId, (tx) => deleteAsset(tx, ctx, photo.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const doc = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'evidence_doc', null));
    await withTenant(t.workspaceId, async (tx) => {
      const c = await proposeClaim(tx, ctx, skuId, { wording: 'Dermatologist tested', origin: 'merchant' });
      await attachEvidence(tx, ctx, c.id, { type: 'lab_test', assetId: doc.id, applicability: 'product_specific', wording: 'Dermatologist tested' });
    });
    expect(await withTenant(t.workspaceId, (tx) => deleteAsset(tx, ctx, doc.id))).toEqual({ purged: false });
    expect(await storage().exists(doc.key)).toBe(true);

    const generated = await withTenant(t.workspaceId, async (tx) => saveAsset(tx, t.workspaceId, { bytes: await productPhoto(), mime: 'image/png', kind: 'cutout', skuId, source: 'generated' }));
    await expect(withTenant(t.workspaceId, (tx) => deleteAsset(tx, ctx, generated.id))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A Viewer cannot delete files.
    const viewer = ctxFor(t.workspaceId, t.userId, 'VIEWER');
    const other = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', skuId));
    await expect(withTenant(t.workspaceId, (tx) => deleteAsset(tx, viewer, other.id))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an asset of another workspace is invisible', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const photo = await withTenant(a.workspaceId, async (tx) => ingestBytes(tx, ctxFor(a.workspaceId, a.userId), await productPhoto(), 'product_photo', null));
    await expect(withTenant(b.workspaceId, (tx) => deleteAsset(tx, ctxFor(b.workspaceId, b.userId), photo.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('deleting a user account (plan 02 §7)', () => {
  it('is refused for the last Owner of a live workspace (M1/M2)', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    await expect(deleteUser(t.userId)).rejects.toMatchObject({ code: 'CONFLICT', details: { paid: true, workspaces: [t.workspaceId] } });
    const [m] = await ownerPool()`select count(*)::int as n from memberships where user_id = ${t.userId}`;
    expect(m!.n).toBe(1);
  });

  it('leaves every workspace, anonymises event actors, removes sign-in methods and personal data', async () => {
    const t = await makeTenant();
    const other = newId();
    await ownerPool()`insert into users (id, email) values (${other}, 'co-owner@example.com')`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${other}, 'OWNER')`;
    await ownerPool()`insert into sessions (user_id, token_hash, expires_at) values (${t.userId}, ${'h-' + t.userId}, now() + interval '1 day')`;
    await withTenant(t.workspaceId, (tx) => emit(tx, ctxFor(t.workspaceId, t.userId), 'BRAND_BRAIN_VERSIONED', { type: 'brand', id: t.brandId }, {}));
    await withTenant(t.workspaceId, (tx) => emit(tx, ctxFor(t.workspaceId, other), 'BRAND_BRAIN_VERSIONED', { type: 'brand', id: t.brandId }, {}));

    expect(await deleteUser(t.userId)).toEqual({ workspaces: 1 });
    expect(await ownerPool()`select 1 from memberships where user_id = ${t.userId}`).toHaveLength(0);
    expect(await ownerPool()`select 1 from sessions where user_id = ${t.userId}`).toHaveLength(0);
    const [u] = await ownerPool()`select email, name, deleted_at from users where id = ${t.userId}`;
    expect(u!.email).not.toContain(t.email);
    expect(u!.deleted_at).not.toBeNull();
    const actors = await ownerPool()`select actor, type from events where workspace_id = ${t.workspaceId} order by at`;
    expect(actors.some((e) => e.actor === `user:${t.userId}`)).toBe(false);
    expect(actors.filter((e) => e.actor === deletedUserActor(t.userId)).map((e) => e.type).sort()).toEqual(['BRAND_BRAIN_VERSIONED', 'MEMBER_REMOVED']);
    expect(actors.some((e) => e.actor === `user:${other}`)).toBe(true); // others untouched
    // Re-running completes quietly.
    expect(await deleteUser(t.userId)).toEqual({ workspaces: 0 });
  });

  it('events stay append-only for every other change', async () => {
    const t = await makeTenant();
    await withTenant(t.workspaceId, (tx) => emit(tx, ctxFor(t.workspaceId, t.userId), 'BRAND_BRAIN_VERSIONED', { type: 'brand', id: t.brandId }, {}));
    await expect(ownerPool()`update events set payload = '{"x":1}' where workspace_id = ${t.workspaceId}`).rejects.toThrow(/append-only/);
    await expect(ownerPool()`update events set actor = 'user:someone-else' where workspace_id = ${t.workspaceId}`).rejects.toThrow(/append-only/);
    await expect(ownerPool()`update events set actor = 'user:deleted:x', payload = '{"y":2}' where workspace_id = ${t.workspaceId}`).rejects.toThrow(/append-only/);
    await expect(ownerPool()`delete from events where workspace_id = ${t.workspaceId}`).rejects.toThrow(/append-only/);
  });
});
