import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { ingestBytes } from '@arkiv/core';
import { ctxFor, productPhoto } from '../../../packages/core/src/testing';
import { variantPreviewUrl } from './variant-preview';

beforeEach(truncateAll);
afterAll(closeAll);

async function tenantWithAsset() {
  const t = await makeTenant();
  const skuId = await makeSku(t.workspaceId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctxFor(t.workspaceId, t.userId), await productPhoto(), 'product_photo', skuId));
  return { t, skuId, assetId: asset.id };
}

describe('variant 9:16 preview (design §2.4 video thumbnail)', () => {
  it('signs the 9:16 placement of a variant', async () => {
    const { t, assetId } = await tenantWithAsset();
    const url = await withTenant(t.workspaceId, (tx) => variantPreviewUrl(tx, { platform_assets: [{ platform: 'FACEBOOK_FEED', aspect: '4x5', assetId: '00000000-0000-0000-0000-000000000000' }, { platform: 'TIKTOK', aspect: '9x16', assetId }] }));
    expect(url).toEqual(expect.any(String));
  });

  it('falls back to the 9:16 file of the variant’s creative, and to nothing without one', async () => {
    const { t, skuId, assetId } = await tenantWithAsset();
    const sql = ownerPool();
    const [cr] = await sql`insert into creatives (workspace_id, sku_id, origin, final_asset_ids) values (${t.workspaceId}, ${skuId}, 'generated', ${[assetId]}) returning id`;
    expect(await withTenant(t.workspaceId, (tx) => variantPreviewUrl(tx, { creative_id: cr!.id }))).toBeNull(); // no 9:16 file yet
    await sql`update assets set lineage = lineage || '{"aspect":"9x16"}'::jsonb where id = ${assetId}`;
    expect(await withTenant(t.workspaceId, (tx) => variantPreviewUrl(tx, { creative_id: cr!.id }))).toEqual(expect.any(String));
    expect(await withTenant(t.workspaceId, (tx) => variantPreviewUrl(tx, {}))).toBeNull();
  });

  it('never signs another workspace’s creative', async () => {
    const { t, skuId, assetId } = await tenantWithAsset();
    const sql = ownerPool();
    await sql`update assets set lineage = lineage || '{"aspect":"9x16"}'::jsonb where id = ${assetId}`;
    const [cr] = await sql`insert into creatives (workspace_id, sku_id, origin, final_asset_ids) values (${t.workspaceId}, ${skuId}, 'generated', ${[assetId]}) returning id`;
    const other = await makeTenant();
    expect(await withTenant(other.workspaceId, (tx) => variantPreviewUrl(tx, { creative_id: cr!.id }))).toBeNull();
  });
});
