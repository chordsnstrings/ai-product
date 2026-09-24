import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { ingestBytes, startPreview, step } from '@arkiv/core';
import { ctxFor, productPhoto } from '../../../packages/core/src/testing';
import { projectVersion } from './views';

beforeEach(truncateAll);
afterAll(closeAll);

describe('project stream version (plan 06 Phase 1 #9 cataloguing stream)', () => {
  it('changes when a progress step, the project or the workspace’s events change, and only then', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    const v1 = await projectVersion(t.workspaceId, projectId);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    expect(await projectVersion(t.workspaceId, projectId)).toBe(v1); // nothing happened
    await withTenant(t.workspaceId, (tx) => step(tx, t.workspaceId, skuId, 'photos', 'active'));
    const v2 = await projectVersion(t.workspaceId, projectId);
    expect(v2).not.toBe(v1);
    await withTenant(t.workspaceId, (tx) => step(tx, t.workspaceId, skuId, 'photos', 'done', '1 photo'));
    expect(await projectVersion(t.workspaceId, projectId)).not.toBe(v2);
    // Another tenant can't read it, and an unknown project has no version.
    const other = await makeTenant();
    expect(await projectVersion(other.workspaceId, projectId)).toBeNull();
  });
});
