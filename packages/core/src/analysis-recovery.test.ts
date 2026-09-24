import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { ProviderError, type LlmJsonRequest, type LlmProvider } from '@arkiv/providers';
import { FREE_EXPLORATION } from '@arkiv/shared';
import { analyzeProduct, ANALYSIS_FAILED_COPY, failAnalysis, generateConceptBatch, requestConcepts, retryAnalysis, startPreview } from './analysis';
import { authorize, estimateCost } from './cost-governor';
import { selectConcept } from './storyboard';
import { buildContext, gateProposal, verifiedIngredients } from './creative-director';
import { mockConcepts } from './mock-intel';
import { decideFact, recordFacts } from './product-truth';
import { expectedStepMs, SLOW_STEP_MS, step, stepEta } from './progress';
import { hardGates, type ScoringContext } from './recommendations';
import { ctxFor, MockImage, MockLlm, MockTts, MockVideo, productPhoto, setProviders } from './testing';
import { ingestBytes } from './uploads';

beforeEach(truncateAll);
afterEach(() => setProviders(undefined));
afterAll(closeAll);

/** An LLM whose extraction call is down (non-retryable), everything else as the mock. */
class ExtractionDown implements LlmProvider {
  readonly name = 'anthropic';
  private mock = new MockLlm();
  async json<T>(req: LlmJsonRequest<T>) {
    if (req.system.includes('product analyst')) throw new ProviderError('anthropic', 'extraction service down', false, 'server');
    return this.mock.json(req);
  }
}

async function preview() {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  return { t, ctx, skuId, projectId };
}

describe('a failed analysis (plan 03 P3 edge cases)', () => {
  it('waits for the merchant with what was found and what is missing; "Try again" re-runs it as a new attempt', async () => {
    const { t, ctx, skuId, projectId } = await preview();
    setProviders({ llm: new ExtractionDown(), image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    await expect(analyzeProduct(ctx, skuId, projectId)).rejects.toThrow(/extraction service down/);
    // The job's retries are spent: the analysis ends honestly instead of "analyzing" forever.
    expect(await failAnalysis(ctx, skuId, projectId, 'analysis failed after retries')).toBe(true);
    expect(await failAnalysis(ctx, skuId, projectId, 'again')).toBe(false); // idempotent
    const [s] = await ownerPool()`select status, analysis from skus where id = ${skuId}`;
    expect(s!.status).toBe('needs_input');
    expect((s!.analysis as { failure: { missing: string[] } }).failure.missing).toEqual(['name', 'category', 'size', 'ingredients']);
    const [p] = await ownerPool()`select state, failure_reason from projects where id = ${projectId}`;
    expect(p).toEqual({ state: 'NEEDS_USER_ACTION', failure_reason: ANALYSIS_FAILED_COPY });
    const steps = await ownerPool()`select step_key, status, detail from progress_steps where subject_id = ${skuId} order by position`;
    expect(steps.find((x) => x.step_key === 'identify')).toMatchObject({ status: 'failed', detail: 'We couldn’t finish this step. Nothing was charged.' });
    expect(steps.filter((x) => ['claims', 'fingerprint', 'concepts'].includes(x.step_key as string)).every((x) => x.status === 'skipped')).toBe(true);
    expect(steps.some((x) => /Retrying/.test(String(x.detail)))).toBe(false);

    // The merchant adds a missing fact and tries again: the SKU is analysing again, the project starts over.
    await withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'size', { text: '30 ml' }));
    await withTenant(t.workspaceId, (tx) => retryAnalysis(tx, ctx, projectId));
    await expect(withTenant(t.workspaceId, (tx) => retryAnalysis(tx, ctx, projectId))).rejects.toMatchObject({ code: 'CONFLICT' });
    const [again] = await ownerPool()`select (select status from skus where id = ${skuId}) as sku, (select state from projects where id = ${projectId}) as project,
                                      (select count(*)::int from outbox where queue like 'analyze-product%' and payload->>'retry' = 'true') as jobs`;
    expect(again).toEqual({ sku: 'analyzing', project: 'PRODUCT_UPLOADED', jobs: 1 });
    setProviders(undefined);
    expect(await analyzeProduct(ctx, skuId, projectId)).toEqual({ status: 'ready' });
    const auths = await ownerPool()`select idempotency_key, status from cost_authorizations where purpose = 'free_preview' order by created_at`;
    expect(auths).toHaveLength(2); // one per attempt, both within the SKU's free-preview cap
    expect(auths[0]!.idempotency_key).toMatch(new RegExp(`^preview:${skuId}:retired:`));
    expect(auths[1]).toEqual({ idempotency_key: `preview:${skuId}`, status: 'settled' });
    const [done] = await ownerPool()`select (select status from skus where id = ${skuId}) as sku, (select state from projects where id = ${projectId}) as project`;
    expect(done).toEqual({ sku: 'active', project: 'CONCEPTS_READY' });
  }, 60_000);

  it('a concurrent duplicate delivery of the same attempt stands down instead of failing the analysis', async () => {
    const { ctx, skuId, projectId } = await preview();
    const [a, b] = await Promise.all([analyzeProduct(ctx, skuId, projectId), analyzeProduct(ctx, skuId, projectId)]);
    expect([a.status, b.status].sort()).toEqual(['ready', 'skipped']);
  }, 60_000);
});

describe('truthful step estimates (plan 03 P3 "about 20 more seconds")', () => {
  it('records the estimate a step started with, from recent provider latency, and shows time left once slow', async () => {
    const t = await makeTenant();
    expect(await withTenant(t.workspaceId, (tx) => expectedStepMs(tx, 'identify'))).toBe(25_000); // no history: typical duration
    for (const ms of [20_000, 30_000, 40_000, 50_000, 60_000, 70_000]) {
      await ownerPool()`insert into provider_jobs (workspace_id, provider, task, model, request_hash, status, latency_ms) values (${t.workspaceId}, 'anthropic', 'extract.product_facts', 'm', 'h', 'succeeded', ${ms})`;
    }
    expect(await withTenant(t.workspaceId, (tx) => expectedStepMs(tx, 'identify'))).toBe(57_500); // p75 of recent calls
    expect(await withTenant(t.workspaceId, (tx) => expectedStepMs(tx, 'not-estimated'))).toBeNull();
    const subject = t.workspaceId;
    await withTenant(t.workspaceId, (tx) => step(tx, t.workspaceId, subject, 'identify', 'active'));
    const [row] = await ownerPool()`select status, started_at, expected_ms from progress_steps where subject_id = ${subject}`;
    expect(row!.expected_ms).toBe(57_500);
    const started = new Date(row!.started_at as string).getTime();
    expect(stepEta(row as never, started + 10_000)).toEqual({ elapsedMs: 10_000, remainingMs: 47_500 });
    expect(stepEta(row as never, started + SLOW_STEP_MS + 20_000)!.remainingMs).toBe(0);
    // A failed step that starts again (a retried job) is timed afresh.
    await ownerPool()`update progress_steps set started_at = now() - interval '1 hour' where subject_id = ${subject}`;
    await withTenant(t.workspaceId, (tx) => step(tx, t.workspaceId, subject, 'identify', 'failed', 'Retrying…'));
    await withTenant(t.workspaceId, (tx) => step(tx, t.workspaceId, subject, 'identify', 'active'));
    const [restarted] = await ownerPool()`select started_at > now() - interval '1 minute' as fresh, detail from progress_steps where subject_id = ${subject}`;
    expect(restarted).toEqual({ fresh: true, detail: null });
  });
});

describe('missing ingredient list (§42)', () => {
  const sc = (over: Partial<ScoringContext> = {}): ScoringContext => ({ themes: [], angleTests: new Map(), learnings: [], fatiguingAngles: new Set(), recentKeys: new Set(), fidelityConfidence: 0.8, approvedClaims: [], hasRealAssets: false, ...over });

  it('never passes ingredients inferred from photos to creative, and gates ingredient-led ideas until a source exists', async () => {
    const { t, ctx, skuId, projectId } = await preview();
    await analyzeProduct(ctx, skuId, projectId);
    // Photo-only analysis: key ingredients read by vision are only INFERRED — they are never used.
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'key_ingredients', valueText: 'Niacinamide, Retinol', sourceType: 'vision', state: 'INFERRED', confidence: 0.6 }]));
    const before = await withTenant(t.workspaceId, (tx) => buildContext(tx, skuId));
    expect(before.ingredientsVerified).toBe(false);
    expect(before.packet.product).toMatchObject({ keyIngredients: [], ingredientsUnverified: true });
    const concepts = await ownerPool()`select proposal->>'angle' as angle, proposal->>'proofMechanism' as proof from concepts where project_id = ${projectId}`;
    expect(concepts.some((c) => c.angle === 'INGREDIENT_EDUCATION' || c.proof === 'INGREDIENT_EXPLANATION')).toBe(false);

    const ingredientIdea = mockConcepts({ name: 'S', category: 'serum', approvedClaims: [], themes: [], testedAngles: [], ingredients: ['niacinamide'] }).concepts.find((c) => c.angle === 'INGREDIENT_EDUCATION')!;
    expect(gateProposal(ingredientIdea, [], [], { ingredientsVerified: false })).toMatchObject({ ok: false });
    expect(gateProposal(ingredientIdea, [], [], { ingredientsVerified: true }).ok).toBe(true);
    expect(hardGates(ingredientIdea, sc({ ingredientsVerified: false })).reasons.join()).toMatch(/ingredient list/);
    expect(hardGates(ingredientIdea, sc()).passed).toBe(true);

    // The merchant adds the list: it is the decided source, and ingredient creative unlocks.
    await withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'ingredients', { text: 'Niacinamide, Zinc PCA' }));
    const after = await withTenant(t.workspaceId, (tx) => buildContext(tx, skuId));
    expect(after.ingredientsVerified).toBe(true);
    expect(after.packet.product.keyIngredients).toEqual(['Niacinamide', 'Zinc PCA']);
    expect(verifiedIngredients(after.facts)).toEqual({ list: ['Niacinamide', 'Zinc PCA'], verified: true });
  }, 60_000);
});

describe('bounded free exploration for signed-in, non-paying workspaces (standard §5)', () => {
  it('limits new products a day, concept batches and storyboards per product, with a friendly prompt', async () => {
    const { t, ctx, skuId, projectId } = await preview();
    await analyzeProduct(ctx, skuId, projectId);
    // Products a day: this workspace already added one today.
    for (let i = 1; i < FREE_EXPLORATION.SKUS_PER_DAY; i++) {
      const a = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
      await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [a.id] }));
    }
    const extra = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    await expect(withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [extra.id] }))).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED', details: { freeLimit: 'skus_per_day' } });

    // Concept batches per product (the first three ideas are batch 1).
    for (let b = 2; b <= FREE_EXPLORATION.CONCEPT_BATCHES_PER_SKU; b++) {
      await withTenant(t.workspaceId, (tx) => requestConcepts(tx, ctx, projectId));
      await generateConceptBatch(ctx, projectId, b);
    }
    await expect(withTenant(t.workspaceId, (tx) => requestConcepts(tx, ctx, projectId))).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED', details: { freeLimit: 'concept_batches' } });

    // Storyboards per product: each chosen concept draws one.
    const concepts = await ownerPool()`select id from concepts where project_id = ${projectId} order by batch, idx`;
    for (const c of concepts.slice(0, FREE_EXPLORATION.STORYBOARDS_PER_SKU)) await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c.id as string));
    const next = concepts[FREE_EXPLORATION.STORYBOARDS_PER_SKU]!;
    await expect(withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, next.id as string))).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED', details: { freeLimit: 'storyboards' } });
    // Paying workspaces are not held to the free limits.
    await ownerPool()`update workspaces set state = 'ACTIVE_PAID' where id = ${t.workspaceId}`;
    const paid = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await withTenant(t.workspaceId, (tx) => selectConcept(tx, paid, projectId, next.id as string));
  }, 120_000);

  it('caps cumulative pre-purchase generation spend per product, whatever the path', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    const line = { kind: 'image' as const, provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 };
    const each = (await withTenant(t.workspaceId, (tx) => estimateCost(tx, [line]))).totalMicros;
    const fits = Math.floor(FREE_EXPLORATION.SKU_COGS_CAP / each);
    // Settled spend counts at what was spent; another SKU has its own budget.
    await ownerPool()`insert into cost_authorizations (workspace_id, purpose, token_hash, idempotency_key, rate_table_versions, estimate, max_cost_micros, spent_micros, status, expires_at)
                      values (${t.workspaceId}, 'storyboard', 'x', 'prior', '{}', ${ownerPool().json({ skuId: 'sku-a' })}, ${each * fits}, ${each * fits}, 'settled', now())`;
    await expect(withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'storyboard', skuId: 'sku-a', lines: [line], idempotencyKey: 'more' }))).rejects.toMatchObject({ code: 'GATE_BLOCKED', details: { reason: 'free_exploration_cap' } });
    await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'storyboard', skuId: 'sku-b', lines: [line], idempotencyKey: 'other-sku' }));
    // A paying workspace explores without the free cap.
    await withTenant(t.workspaceId, (tx) => authorize(tx, { ...ctx, workspaceState: 'ACTIVE_PAID' }, { purpose: 'storyboard', skuId: 'sku-a', lines: [line], idempotencyKey: 'paid' }));
  });
});
