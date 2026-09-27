import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { ingestBytes, startPreview } from '@arkiv/core';
import { ctxFor, productPhoto } from '../../../packages/core/src/testing';
import { latestProject } from './resume';

beforeEach(truncateAll);
afterAll(closeAll);

describe('“Continue with <product>” for a returning visitor (plan 03 P1, P3 edge)', () => {
  it('names the latest product and links to the page for its state; nothing for an empty workspace', async () => {
    const t = await makeTenant();
    expect(await latestProject(t.workspaceId)).toBeNull();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { projectId, skuId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    await ownerPool()`update skus set name = 'Serum No. 3' where id = ${skuId}`;
    expect(await latestProject(t.workspaceId)).toEqual({ name: 'Serum No. 3', href: `/start/${projectId}` });
    await ownerPool()`update projects set state = 'CONCEPTS_READY' where id = ${projectId}`;
    expect((await latestProject(t.workspaceId))!.href).toBe(`/concepts/${projectId}`);
    await ownerPool()`update projects set state = 'STORYBOARD_READY' where id = ${projectId}`;
    expect((await latestProject(t.workspaceId))!.href).toBe(`/storyboard/${projectId}`);
    // Only this workspace's own products (RLS): another visitor's preview is never offered.
    const other = await makeTenant();
    expect(await latestProject(other.workspaceId)).toBeNull();
  }, 60_000);
});
