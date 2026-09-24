import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { MockImage, MockLlm, MockTts, MockVideo, setProviders, type LlmJsonRequest, type LlmJsonResult } from '@arkiv/providers';
import { analyzeProduct, startPreview } from './analysis';
import { generateStoryboard, selectConcept } from './storyboard';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';

/**
 * Plan 06 Phase 2 D4 "exact-product composite for any frame failing fidelity"; standard §54 rule 4: a storyboard
 * frame the model drew is fidelity-checked before the customer sees it, and a failing one becomes the exact product.
 */
beforeEach(truncateAll);
afterEach(() => setProviders(undefined));
afterAll(closeAll);

/** A product-fidelity inspector that sees a different product in every frame. */
class WrongProductLlm extends MockLlm {
  inspections = 0;
  override async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
    const r = await super.json(req);
    if (!/product-accuracy inspector/.test(req.system)) return r;
    this.inspections++;
    return { ...r, data: { ...(r.data as object), sameProduct: false, labelTextMatches: false, notes: 'Different bottle' } as T };
  }
}

async function storyboard() {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
  await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
  const frames = await ownerPool()`select s.production_mode, v.technique, v.lineage, v.qa from scenes s join scene_versions v on v.id = s.current_version_id
                                   where s.storyboard_id = ${storyboardId} order by s.position`;
  const [sb] = await ownerPool()`select status from storyboards where id = ${storyboardId}`;
  return { t, frames, status: sb!.status as string, projectId };
}

describe('storyboard frame fidelity', () => {
  it('a generated frame that passes is shown, with its check kept', async () => {
    const { frames, status } = await storyboard();
    expect(status).toBe('ready');
    const generated = frames.filter((f) => f.technique === 'generated');
    expect(generated.length).toBeGreaterThan(0);
    for (const f of generated) expect((f.qa as { check: string; pass: boolean }[]).find((c) => c.check === 'product_fidelity')).toMatchObject({ pass: true });
  }, 120_000);

  it('a generated frame that fails is replaced by the exact-product composite, within the storyboard budget', async () => {
    const llm = new WrongProductLlm();
    setProviders({ llm, image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    const { frames, status, projectId } = await storyboard();
    expect(status).toBe('ready');
    expect(llm.inspections).toBeGreaterThan(0);
    const replaced = frames.filter((f) => (f.lineage as { fidelityFallback?: boolean }).fidelityFallback);
    expect(replaced).toHaveLength(llm.inspections);
    expect(frames.some((f) => f.technique === 'generated')).toBe(false);
    for (const f of replaced) {
      expect(f.technique).toBe('exact_product_composite');
      expect(f.lineage).toMatchObject({ rejectedProviderJobId: expect.any(String), rejectedBecause: expect.stringMatching(/not the same product/) });
      expect((f.qa as { check: string; pass: boolean; hard: boolean }[]).find((c) => c.check === 'product_fidelity')).toMatchObject({ pass: false, hard: true });
    }
    // The inspections were priced into the storyboard's own authorization and stayed within it.
    const [a] = await ownerPool()`select spent_micros, max_cost_micros, estimate from cost_authorizations where project_id = ${projectId} and purpose = 'storyboard'`;
    expect(Number(a!.spent_micros)).toBeLessThanOrEqual(Number(a!.max_cost_micros));
  }, 120_000);
});
