import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { addProductPhotos, analyzeProduct, NEEDS_PHOTO_COPY, startPreview } from './analysis';
import { isMarketplaceUrl } from './ingest';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';

beforeEach(truncateAll);
afterAll(closeAll);

describe('adding photos to an existing product (§13, plan 03 P2/P4)', () => {
  it('a link that yields no photo waits for photos with the URL kept, then resumes on the same SKU', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const url = 'https://store.invalid/products/dew-serum';
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { url }));
    expect(await analyzeProduct(ctx, skuId, projectId)).toEqual({ status: 'needs_input', reason: 'needs_photo' });

    const [s] = await ownerPool()`select s.status, s.source_url, p.state, p.failure_reason from skus s join projects p on p.sku_id = s.id where s.id = ${skuId}`;
    // A terminal state the UI can act on, with customer copy (never the raw code) and the link preserved.
    expect(s).toEqual({ status: 'needs_input', source_url: url, state: 'NEEDS_USER_ACTION', failure_reason: NEEDS_PHOTO_COPY });
    const steps = await ownerPool()`select step_key, status from progress_steps where subject_id = ${skuId}`;
    expect(steps.some((x) => x.status === 'pending' || x.status === 'active')).toBe(false);

    const r = await withTenant(t.workspaceId, async (tx) => addProductPhotos(tx, ctx, projectId, [{ bytes: await productPhoto(), filename: 'front.jpg' }]));
    expect(r).toEqual({ skuId, mode: 'resumed', added: 1 });
    const [after] = await ownerPool()`select (select status from skus where id = ${skuId}) as sku, (select source_url from skus where id = ${skuId}) as url,
                                        (select state from projects where id = ${projectId}) as project,
                                        (select count(*)::int from assets where sku_id = ${skuId} and kind = 'product_photo') as photos,
                                        (select count(*)::int from outbox where queue like 'analyze-product%' and payload->>'skuId' = ${skuId}) as jobs,
                                        (select count(*)::int from skus where workspace_id = ${t.workspaceId}) as skus`;
    expect(after).toEqual({ sku: 'analyzing', url, project: 'PRODUCT_UPLOADED', photos: 1, jobs: 2, skus: 1 });

    expect(await analyzeProduct(ctx, skuId, projectId)).toEqual({ status: 'ready' });
    const [done] = await ownerPool()`select (select status from skus where id = ${skuId}) as sku, (select state from projects where id = ${projectId}) as project`;
    expect(done).toEqual({ sku: 'active', project: 'CONCEPTS_READY' });
  }, 60_000);

  it('adds side/back views to an analysed product as a new fingerprint version, and refuses while analysing', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const photo = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [photo.id] }));

    await expect(withTenant(t.workspaceId, async (tx) => addProductPhotos(tx, ctx, projectId, [{ bytes: await productPhoto() }]))).rejects.toMatchObject({ code: 'CONFLICT' });
    const [none] = await ownerPool()`select count(*)::int as n from assets where sku_id = ${skuId} and kind = 'reference_view'`;
    expect(none!.n).toBe(0); // refused before anything was stored

    expect(await analyzeProduct(ctx, skuId, projectId)).toEqual({ status: 'ready' });
    const [v1] = await ownerPool()`select version, reference_asset_ids, cutout_asset_id from visual_fingerprints where sku_id = ${skuId} and active`;
    const r = await withTenant(t.workspaceId, async (tx) => addProductPhotos(tx, ctx, projectId, [{ bytes: await productPhoto('BACK LABEL'), filename: 'back.jpg' }]));
    expect(r).toMatchObject({ mode: 'reference', added: 1 });
    const [view] = await ownerPool()`select id from assets where sku_id = ${skuId} and kind = 'reference_view'`;
    const fps = await ownerPool()`select version, active, reference_asset_ids, cutout_asset_id from visual_fingerprints where sku_id = ${skuId} order by version`;
    expect(fps).toHaveLength(2);
    expect(fps[0]!.active).toBe(false);
    expect(fps[1]).toMatchObject({ version: v1!.version + 1, active: true, cutout_asset_id: v1!.cutout_asset_id, reference_asset_ids: [...(v1!.reference_asset_ids as string[]), view!.id] });
    const [a] = await ownerPool()`select analysis from skus where id = ${skuId}`;
    expect((a!.analysis as { addedViews: number }).addedViews).toBe(1);
    const [ev] = await ownerPool()`select payload from events where type = 'VISUAL_FINGERPRINT_VERSIONED' and subject_id = ${skuId} order by at desc limit 1`;
    expect(ev!.payload).toMatchObject({ addedViews: 1 });

    await expect(withTenant(t.workspaceId, (tx) => addProductPhotos(tx, ctx, projectId, []))).rejects.toMatchObject({ code: 'INVALID' });
  }, 60_000);

  it('recognises marketplace links (refused at submit time)', () => {
    expect(isMarketplaceUrl('https://www.amazon.com/dp/B000')).toBe(true);
    expect(isMarketplaceUrl('https://amazon.co.uk/x')).toBe(true);
    expect(isMarketplaceUrl('https://www.ebay.com/itm/1')).toBe(true);
    expect(isMarketplaceUrl('https://glowlab.com/products/amazonian-clay')).toBe(false);
    expect(isMarketplaceUrl('not a url')).toBe(false);
  });
});
