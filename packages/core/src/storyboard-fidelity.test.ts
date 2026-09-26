import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { MockImage, MockLlm, MockTts, MockVideo, ProviderError, setProviders, type LlmJsonRequest, type LlmJsonResult } from '@arkiv/providers';
import { analyzeProduct, startPreview } from './analysis';
import { generateStoryboard, regenerateFrame, selectConcept } from './storyboard';
import { append } from './ledger';
import { approveForProduction, produceProject } from './production';
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

/** An inspector that errors on every frame. */
class BrokenInspectorLlm extends MockLlm {
  override async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
    if (/product-accuracy inspector/.test(req.system)) throw new ProviderError('anthropic', 'malformed inspection', false, 'invalid');
    return super.json(req);
  }
}

describe('storyboard frame fidelity', () => {
  it('an inspector error does not stall the storyboard: the deterministic checks judge the frame', async () => {
    setProviders({ llm: new BrokenInspectorLlm(), image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    const { frames, status } = await storyboard();
    expect(status).toBe('ready');
    const judged = frames.filter((f) => f.technique === 'generated' || (f.lineage as { fidelityFallback?: boolean }).fidelityFallback);
    expect(judged.length).toBeGreaterThan(0);
    for (const f of judged) expect((f.qa as { data?: { inspector?: string } }[])[0]!.data).toMatchObject({ inspector: 'not run' });
  }, 120_000);

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

describe('redrawn frames and generated stills in production (standard §24/§25: prod-17, prod-32, prod-33)', () => {
  it('records the planner and frame prompt versions, source assets and a script version per scene', async () => {
    const { t } = await storyboard();
    const [sb] = await ownerPool()`select prompt_version, model from storyboards where workspace_id = ${t.workspaceId}`;
    expect(sb!.prompt_version).toBeTruthy();
    expect(sb!.model).toBeTruthy();
    const gen = await ownerPool()`select v.prompt_version, s.source_asset_ids from scenes s join scene_versions v on v.id = s.current_version_id
                                  where s.workspace_id = ${t.workspaceId} and v.technique = 'generated'`;
    expect(gen.length).toBeGreaterThan(0);
    for (const g of gen) {
      expect(g.prompt_version).toBeTruthy();
      expect((g.source_asset_ids as string[]).length).toBeGreaterThan(0);
    }
  }, 120_000);

  it('a redrawn frame is inspected; one that fails becomes the exact product, and the previous plan is kept as a version', async () => {
    const { t, projectId } = await storyboard();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const [s] = await ownerPool()`select s.id, s.visual_plan from scenes s join storyboards sb on sb.id = s.storyboard_id where sb.project_id = ${projectId} and s.production_mode = 'GENERATIVE_INTERACTION' order by s.position limit 1`;
    const llm = new WrongProductLlm();
    setProviders({ llm, image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    expect(await regenerateFrame(ctx, s!.id as string, 'warmer light', 2)).toBe('done');
    expect(llm.inspections).toBe(1);
    const [v] = await ownerPool()`select technique, lineage, qa, prompt_version, cost_micros from scene_versions where scene_id = ${s!.id} and kind = 'frame' and version = 2`;
    expect(v!.technique).toBe('exact_product_composite');
    expect(v!.lineage).toMatchObject({ fidelityFallback: true, instruction: 'warmer light' });
    expect((v!.qa as { check: string; pass: boolean }[]).find((c) => c.check === 'product_fidelity')).toMatchObject({ pass: false });
    expect(v!.prompt_version).toBeNull();
    // §24: the redraw changed the visual plan; the script before and after are both versions.
    const scripts = await ownerPool()`select version, script->>'visualPlan' as plan, lineage->>'source' as source from scene_versions where scene_id = ${s!.id} and kind = 'script' order by version`;
    expect(scripts.map((x) => x.source)).toEqual(['storyboard', 'frame_redraw']);
    expect(scripts[0]!.plan).toBe(s!.visual_plan);
    expect(scripts[1]!.plan).toContain('warmer light');
  }, 120_000);

  it('production inspects a generated still that has no passing check and swaps in the exact product when it fails', async () => {
    const { t, projectId } = await storyboard();
    const ctx = ctxFor(t.workspaceId, t.userId);
    // A generated frame shown as a still (re-planned to a hybrid), with no check on record (e.g. made before checks ran).
    const [s] = await ownerPool()`select s.id from scenes s join scene_versions v on v.id = s.current_version_id join storyboards sb on sb.id = s.storyboard_id
                                  where sb.project_id = ${projectId} and v.technique = 'generated' order by s.position limit 1`;
    // The mock inspector reads [[qa:fidelity_always]] in the scene's plan as a wrong product (the exact composite passes).
    await ownerPool()`update scenes set production_mode = 'HYBRID', visual_plan = visual_plan || ' [[qa:fidelity_always]]' where id = ${s!.id}`;
    await ownerPool()`update scene_versions set qa = '{}' where id = (select current_version_id from scenes where id = ${s!.id})`;
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: `pay:${projectId}` });
      await approveForProduction(tx, ctx, projectId, 'taste');
    });
    // §24: approving the storyboard stamps each scene's approval.
    const unapproved = await ownerPool()`select count(*)::int as n from scenes s join storyboards sb on sb.id = s.storyboard_id where sb.project_id = ${projectId} and s.approved_at is null`;
    expect(unapproved[0]!.n).toBe(0);
    expect(await produceProject(ctx, projectId)).toBe('complete');
    const [p] = await ownerPool()`select c.composition, p.qa_report from projects p join creatives c on c.id = p.final_creative_id where p.id = ${projectId}`;
    const scene = (p!.composition as { scenes: { sceneId: string; technique: string }[] }).scenes.find((x) => x.sceneId === s!.id)!;
    expect(scene.technique).toBe('exact_product_composite');
    expect((p!.qa_report as { checks: { detail: string }[] }).checks.some((c) => /generated frame failed product QA/.test(c.detail))).toBe(true);
  }, 240_000);
});
