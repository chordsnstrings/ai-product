import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, startPreview } from './analysis';
import { saveAsset } from './assets';
import { buildContext } from './creative-director';
import { recordFacts } from './product-truth';
import { listVariants, recordVariants, referenceAssetIds, selectVariant, variantDimensions, variantTruth } from './sku-variants';
import { selectConcept } from './storyboard';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';
import { moveProvisionalSkus } from './workspaces';

beforeEach(truncateAll);
afterAll(closeAll);

/** A multi-size Shopify product: 30 ml and 50 ml, different prices, one out of stock. */
const SIZES = [
  { externalId: '71', title: '30 ml', options: { Size: '30 ml' }, priceMicros: 38_000_000, available: true, imageUrl: 'https://cdn/30.jpg' },
  { externalId: '72', title: '50 ml', options: { Size: '50 ml' }, priceMicros: 52_000_000, available: false },
];

async function analyzed(state: 'ACTIVE_FREE' | 'PROVISIONAL' = 'ACTIVE_FREE') {
  const t = await makeTenant({ state });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', state);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  // The store's product-level size and price are the first variant's (as Shopify reports them).
  await withTenant(t.workspaceId, async (tx) => {
    await recordFacts(tx, ctx, skuId, [
      { key: 'size', valueText: '30 ml', sourceType: 'shopify', state: 'OBSERVED' },
      { key: 'price', valueNumber: 38, sourceType: 'shopify', state: 'OBSERVED' },
    ]);
    await recordVariants(tx, ctx, skuId, 'shopify', SIZES, 'USD');
  });
  return { t, ctx, skuId, projectId };
}

describe('product variants (§42 "store variant-specific price/media; do not show wrong size/shade")', () => {
  it('derives size and shade from options or title', () => {
    expect(variantDimensions({ title: '50 ml / Rose', options: { Size: '50 ml', Colour: 'Rose' } })).toEqual({ size: '50 ml', shade: 'Rose' });
    expect(variantDimensions({ title: 'Glow Serum 1 fl oz', options: {} })).toEqual({ size: '1 fl oz', shade: null });
  });

  it('creative states the chosen variant’s size and price, and no differing size or price when none is chosen', async () => {
    const { t, ctx, skuId, projectId } = await analyzed();
    const variants = await withTenant(t.workspaceId, (tx) => listVariants(tx, skuId));
    expect(variants.map((v) => [v.title, v.size, v.priceMicros, v.available])).toEqual([['30 ml', '30 ml', 38_000_000, true], ['50 ml', '50 ml', 52_000_000, false]]);

    // None chosen: the product fact (the first variant's 30 ml / $38) is not passed on as if it were universal.
    const open = await withTenant(t.workspaceId, (tx) => buildContext(tx, skuId, { projectId }));
    expect(open.packet.product).toMatchObject({ size: null, price: null });
    expect(open.packet.product.variantNote).toMatch(/2 variants \(30 ml, 50 ml\)/);

    await withTenant(t.workspaceId, (tx) => selectVariant(tx, ctx, projectId, variants[1]!.id));
    const chosen = await withTenant(t.workspaceId, (tx) => buildContext(tx, skuId, { projectId }));
    expect(chosen.packet.product).toMatchObject({ size: '50 ml', price: '52.00', variant: '50 ml', variantNote: null });
    expect(chosen.productContext.sizeText).toBe('50 ml');

    // Shades of one size share the size: it may be stated even without a choice.
    expect(variantTruth([{ ...variants[0]!, shade: 'Light' }, { ...variants[0]!, id: 'b', shade: 'Deep' }], null, { size: null, priceMicros: null })).toMatchObject({ size: '30 ml', shade: null, priceMicros: 38_000_000, ambiguous: true });

    // Only this SKU's variants, and only before an idea is chosen (the storyboard is drawn for the variant).
    const other = await analyzed();
    const theirs = (await withTenant(other.t.workspaceId, (tx) => listVariants(tx, other.skuId)))[0]!;
    await expect(withTenant(t.workspaceId, (tx) => selectVariant(tx, ctx, projectId, theirs.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
    await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
    await expect(withTenant(t.workspaceId, (tx) => selectVariant(tx, ctx, projectId, variants[0]!.id))).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 60_000);

  it('uses the chosen variant’s own image as the first product reference', async () => {
    const { t, ctx, skuId, projectId } = await analyzed();
    const [v] = await withTenant(t.workspaceId, (tx) => listVariants(tx, skuId));
    const before = await withTenant(t.workspaceId, (tx) => referenceAssetIds(tx, skuId, projectId));
    const img = await withTenant(t.workspaceId, async (tx) => saveAsset(tx, t.workspaceId, { bytes: await productPhoto('30 ML', '#AA8866'), mime: 'image/jpeg', kind: 'reference_view', skuId, source: 'import', lineage: { variantId: v!.id } }));
    await ownerPool()`update sku_variants set image_asset_ids = ${[img.id]}::uuid[] where id = ${v!.id}`;
    await withTenant(t.workspaceId, (tx) => selectVariant(tx, ctx, projectId, v!.id));
    const after = await withTenant(t.workspaceId, (tx) => referenceAssetIds(tx, skuId, projectId));
    expect(after[0]).toBe(img.id);
    expect(after[1]).toBe(before[0]);
    // Re-syncing the store keeps the owned image while its source URL is unchanged, and drops it when it changes.
    await withTenant(t.workspaceId, (tx) => recordVariants(tx, ctx, skuId, 'shopify', [SIZES[0]!, { ...SIZES[1]!, available: true }], 'USD'));
    const restocked = await withTenant(t.workspaceId, (tx) => listVariants(tx, skuId));
    expect(restocked[0]!.imageAssetIds).toEqual([img.id]);
    expect(restocked[1]!.available).toBe(true);
    await withTenant(t.workspaceId, (tx) => recordVariants(tx, ctx, skuId, 'shopify', [{ ...SIZES[0]!, imageUrl: 'https://cdn/30-new.jpg' }], 'USD'));
    const resynced = await withTenant(t.workspaceId, (tx) => listVariants(tx, skuId));
    expect(resynced[0]!.imageAssetIds).toEqual([]);
    // The 50 ml is no longer listed by the store: kept (ads may exist for it) but unavailable.
    expect(resynced.map((x) => [x.title, x.available])).toEqual([['30 ml', true], ['50 ml', false]]);
  }, 60_000);

  it('a preview with a chosen variant moves into an existing account intact', async () => {
    const { t, ctx, skuId, projectId } = await analyzed('PROVISIONAL');
    const [v] = await withTenant(t.workspaceId, (tx) => listVariants(tx, skuId));
    await withTenant(t.workspaceId, (tx) => selectVariant(tx, ctx, projectId, v!.id));
    const home = await makeTenant();
    await moveProvisionalSkus(t.workspaceId, home.workspaceId, home.userId);
    const [moved] = await withSystem((tx) => tx`select p.workspace_id as p, v.workspace_id as v, p.sku_variant_id from projects p join sku_variants v on v.id = p.sku_variant_id where p.id = ${projectId}`);
    expect(moved).toEqual({ p: home.workspaceId, v: home.workspaceId, sku_variant_id: v!.id });
  }, 60_000);
});
