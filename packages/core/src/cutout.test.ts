import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { cutoutFromFlatBackdrop } from '@arkiv/media';
import {
  MockImage,
  MockLlm,
  MockTts,
  MockVideo,
  ProviderError,
  setProviders,
  type SegmentationProvider,
  type SegmentationRequest,
  type SegmentationResult,
} from '@arkiv/providers';
import { analyzeProduct, startPreview } from './analysis';
import { assetBytes } from './assets';
import { productImagery } from './composite';
import { authorize } from './cost-governor';
import { cutoutState, segmentCutout, wantsSegmentation } from './cutout';
import { CUTOUT_TASK, routedLines } from './model-gateway';
import { generateStoryboard, selectConcept } from './storyboard';
import { ctxFor, eventContractProblems, lifestylePhoto } from './testing';
import { ingestBytes } from './uploads';

beforeEach(truncateAll);
afterEach(() => setProviders(undefined));
afterAll(closeAll);

/**
 * A background-removal service that puts the bottle on a flat green backdrop — exactly (`ok`), moved sideways
 * (`moved`: an edit that redrew the product), or not at all (`down`: an outage).
 */
class FlatBackdropEdit implements SegmentationProvider {
  readonly name = 'byteplus';
  calls = 0;
  constructor(private readonly mode: 'ok' | 'moved' | 'down') {}
  async removeBackground(req: SegmentationRequest): Promise<SegmentationResult> {
    this.calls++;
    if (this.mode === 'down') throw new ProviderError('byteplus', 'service unavailable', true, 'server');
    const cut = await cutoutFromFlatBackdrop(req.image, await lifestylePhoto({ backdrop: '#00B140', dx: this.mode === 'moved' ? 180 : 0 }));
    return { ...cut, technique: 'test_edit+key', model: req.model, modelVersion: 'seedream-test-2609', providerRequestId: `req-${this.calls}` };
  }
}

function useSegmentation(s: SegmentationProvider | null) {
  setProviders({ llm: new MockLlm(), image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), segmentation: s, wireModel: (m) => m });
}

/** A free preview of the bottle shot on a busy background: analysis can only frame the photo. */
async function busyPreview() {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await lifestylePhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  expect((await analyzeProduct(ctx, skuId, projectId)).status).toBe('ready');
  return { t, ctx, skuId, projectId, photoAssetId: asset.id };
}

async function cutoutToken(ctx: ReturnType<typeof ctxFor>, skuId: string, key: string) {
  return withTenant(ctx.workspaceId, async (tx) =>
    authorize(tx, ctx, { purpose: 'storyboard', skuId, lines: await routedLines(tx, ctx.workspaceId, [{ task: CUTOUT_TASK, kind: 'image', images: 1 }]), idempotencyKey: key }),
  );
}

const cutoutJobs = () => ownerPool()`select status, authorization_id, model_version_returned, input_refs, raw_meta from provider_jobs where task = ${CUTOUT_TASK} order by created_at`;

describe('background removal for the product cut-out (plan 06 Phase 1 #6)', () => {
  it('records how analysis made the cut-out, and asks for background removal only when keying could not', async () => {
    const { t, skuId, photoAssetId } = await busyPreview();
    const [a] = await ownerPool()`select a.lineage from visual_fingerprints f join assets a on a.id = f.cutout_asset_id where f.sku_id = ${skuId} and f.active`;
    expect(a!.lineage).toMatchObject({ from: photoAssetId, keyed: false, technique: 'framed' });
    expect((a!.lineage as { spread: number }).spread).toBeGreaterThan(0.25);
    const state = await withTenant(t.workspaceId, (tx) => cutoutState(tx, skuId));
    expect(state).toMatchObject({ keyed: false, attempted: false, routed: true, photoAssetId });
    expect(wantsSegmentation(state)).toBe(true);
    // A clean keyed cut-out, an alpha-channel photo or an unrouted task never pays for one.
    expect(wantsSegmentation({ ...state!, keyed: true, spread: 0.02, technique: 'border_key' })).toBe(false);
    expect(wantsSegmentation({ ...state!, keyed: true, spread: 0.2, technique: 'border_key' })).toBe(true);
    expect(wantsSegmentation({ ...state!, technique: 'alpha_channel' })).toBe(false);
    expect(wantsSegmentation({ ...state!, routed: false })).toBe(false);
  }, 60_000);

  it('the storyboard pays for one background removal, versions the fingerprint and composes the exact product', async () => {
    const edit = new FlatBackdropEdit('ok');
    useSegmentation(edit);
    const { t, ctx, skuId, projectId } = await busyPreview();
    const concepts = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx`;
    const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, concepts[0]!.id as string));
    await generateStoryboard(ctx, projectId, storyboardId, concepts[0]!.id as string);

    // One call, under the storyboard's authorization, which priced it (Cost Governor line).
    expect(edit.calls).toBe(1);
    const [job] = await cutoutJobs();
    const [auth] = await ownerPool()`select id, estimate from cost_authorizations where idempotency_key = ${'storyboard:' + storyboardId}`;
    expect(job).toMatchObject({ status: 'succeeded', authorization_id: auth!.id, model_version_returned: 'seedream-test-2609', raw_meta: { aligned: true, technique: 'test_edit+key' } });
    expect(JSON.stringify(auth!.estimate)).toContain('"images":1');

    // The fingerprint's new version carries the segmented cut-out, made of the photo's own pixels.
    const fps = await ownerPool()`select version, active, cutout_asset_id from visual_fingerprints where sku_id = ${skuId} order by version`;
    expect(fps.map((f) => [f.version, f.active])).toEqual([[1, false], [2, true]]);
    const [cut] = await ownerPool()`select lineage from assets where id = ${fps[1]!.cutout_asset_id}`;
    expect(cut!.lineage).toMatchObject({ keyed: true, technique: 'segmentation', segmentation: 'test_edit+key', model: 'seedream-test-2609', promptVersion: 'cutout@1.0.0' });
    const bytes = await withTenant(t.workspaceId, (tx) => assetBytes(tx, fps[1]!.cutout_asset_id as string));
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBeLessThan(400); // the bottle, not the frame
    expect(data[3]).toBe(0); // transparent beside the cap
    const o = (Math.floor(info.height * 0.4) * info.width + Math.floor(info.width / 2)) * 4;
    expect(Math.abs(data[o]! - 0xc9) + Math.abs(data[o + 1]! - 0xa2) + Math.abs(data[o + 2]! - 0x7e)).toBeLessThan(20);
    expect(data[o + 3]).toBe(255);

    // Frames and production now use the exact product composite instead of the framed photo.
    expect((await withTenant(t.workspaceId, (tx) => productImagery(tx, skuId))).cutout?.keyed).toBe(true);
    const strict = await ownerPool()`select v.technique from scenes s join scene_versions v on v.id = s.current_version_id
                                     where s.storyboard_id = ${storyboardId} and s.production_mode = 'STRICT_COMPOSITE'`;
    expect(strict.length).toBeGreaterThan(0);
    expect(strict.every((s) => s.technique === 'exact_product_composite')).toBe(true);

    // The next storyboard neither calls again nor prices the call.
    const next = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, concepts[1]!.id as string));
    await generateStoryboard(ctx, projectId, next.storyboardId, concepts[1]!.id as string);
    expect(edit.calls).toBe(1);
    const [auth2] = await ownerPool()`select estimate from cost_authorizations where idempotency_key = ${'storyboard:' + next.storyboardId}`;
    expect(JSON.stringify(auth2!.estimate)).not.toContain('"images":1');
    expect(await eventContractProblems(t.workspaceId)).toEqual([]);
  }, 120_000);

  it('an edit that moved the product is paid once, never used, and not bought again for the same photo', async () => {
    const edit = new FlatBackdropEdit('moved');
    useSegmentation(edit);
    const { t, ctx, skuId } = await busyPreview();
    const { token } = await cutoutToken(ctx, skuId, 'cut:1');
    expect(await segmentCutout({ ctx, token, skuId })).toMatchObject({ status: 'not_aligned' });
    expect(await cutoutJobs()).toEqual([expect.objectContaining({ status: 'succeeded', raw_meta: expect.objectContaining({ aligned: false }) })]);
    const [fp] = await ownerPool()`select count(*)::int as n from visual_fingerprints where sku_id = ${skuId}`;
    expect(fp!.n).toBe(1);
    expect((await withTenant(t.workspaceId, (tx) => productImagery(tx, skuId))).cutout?.keyed).toBe(false);
    expect(wantsSegmentation(await withTenant(t.workspaceId, (tx) => cutoutState(tx, skuId)))).toBe(false);
    expect(await segmentCutout({ ctx, token, skuId })).toEqual({ status: 'skipped' });
    expect(edit.calls).toBe(1);
  }, 60_000);

  it('an outage or a missing adapter never blocks: nothing is dispatched without an adapter, and a failed call may be retried', async () => {
    useSegmentation(null);
    const { t, ctx, skuId } = await busyPreview();
    const { token } = await cutoutToken(ctx, skuId, 'cut:none');
    expect(await segmentCutout({ ctx, token, skuId })).toMatchObject({ status: 'failed' });
    expect(await cutoutJobs()).toEqual([]);

    const down = new FlatBackdropEdit('down');
    useSegmentation(down);
    const { token: token2 } = await cutoutToken(ctx, skuId, 'cut:down');
    expect(await segmentCutout({ ctx, token: token2, skuId })).toMatchObject({ status: 'failed' });
    expect(down.calls).toBe(3); // the gateway's bounded transient retries, inside one provider job
    expect(await cutoutJobs()).toEqual([expect.objectContaining({ status: 'failed' })]);
    // Nothing was charged for the failed call, and the next storyboard may try again.
    const [spent] = await ownerPool()`select coalesce(sum(spent_micros), 0)::int as n from cost_authorizations where idempotency_key = 'cut:down'`;
    expect(spent!.n).toBe(0);
    expect(wantsSegmentation(await withTenant(t.workspaceId, (tx) => cutoutState(tx, skuId)))).toBe(true);
  }, 60_000);
});
