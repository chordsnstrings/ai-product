import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { analyzeProduct, generateConceptBatch, startPreview } from './analysis';
import { buildContext, contextPacketParts, gateProposal } from './creative-director';
import { createExperiment } from './experiments';
import { append } from './ledger';
import { mockConcepts } from './mock-intel';
import { scoringContext } from './recommendations';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';

/**
 * Standard §22 Context Packet and CreativeDirectorProposal ids, §14 fact provenance, §20 concept gates and the
 * scoring context's customer, asset, platform and cost inputs.
 */
beforeEach(truncateAll);
afterAll(closeAll);

const proposal = () => mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;

async function tenant() {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const skuId = await makeSku(t.workspaceId);
  return { t, ctx, skuId };
}

describe('Context Packet (§22)', () => {
  it('carries fact states, learnings with confidence, recent tests, winners, assets, platform and budget', async () => {
    const { t, ctx, skuId } = await tenant();
    await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 4, periodKey: '2026-09-01', idempotencyKey: 'grant:p' }));
    await ownerPool()`insert into product_facts (workspace_id, sku_id, fact_type, normalized_key, value_text, source_type, state, status, created_by)
                      values (${t.workspaceId}, ${skuId}, 'text', 'key_ingredients', 'niacinamide', 'vision', 'INFERRED', 'ACTIVE', 'test')`;
    await ownerPool()`insert into learnings (workspace_id, sku_id, statement, scope_platform, measurement_context, confidence, state)
                      values (${t.workspaceId}, ${skuId}, 'Texture openings hold better', 'meta', 'META_PAID_ATTRIBUTED', 0.87, 'DIRECTIONAL')`;
    const { experimentId } = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: { ...proposal(), hypothesis: 'A secret hypothesis about texture openings' } }));
    const [v] = await ownerPool()`select id from variants where experiment_id = ${experimentId} order by code limit 1`;
    await ownerPool()`insert into experiment_comparisons (workspace_id, experiment_id, measurement_context, metric, state, leader_variant_id, explanation)
                      values (${t.workspaceId}, ${experimentId}, 'META_PAID_ATTRIBUTED', 'hold_rate', 'ACTIONABLE', ${v!.id}, 'x')`;
    const footage = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'creator_footage', skuId));
    await ownerPool()`update assets set rights_attested_at = now() where id = ${footage.id}`;
    await ownerPool()`insert into integrations (workspace_id, provider, status, external_account_id) values (${t.workspaceId}, 'meta', 'active', 'act_1')`;

    const built = await withTenant(t.workspaceId, (tx) => buildContext(tx, skuId));
    const p = built.packet;
    expect(p.factStates.key_ingredients).toMatchObject({ state: 'INFERRED', confirmed: false });
    expect(p.product.ingredientsUnverified).toBe(true);
    expect(p.learnings[0]).toMatchObject({ confidence: 0.87 });
    expect(p.recentExperiments).toEqual([expect.objectContaining({ id: experimentId, primaryVariable: 'hook', mode: 'CONTROLLED', state: 'DRAFT' })]);
    expect(p.currentWinners).toEqual([expect.objectContaining({ experimentId, variantId: v!.id, state: 'ACTIONABLE' })]);
    expect(p.assets).toEqual([expect.objectContaining({ kind: 'creator_footage', count: 1, items: [{ id: footage.id, rightsConfirmed: true }] })]);
    expect(built.assetIds.has(footage.id)).toBe(true);
    expect(p.platform.targets).toEqual(['INSTAGRAM_REELS', 'FACEBOOK_FEED']);
    expect(p.budget).toMatchObject({ plan: 'GROWTH', creativeTestsLeft: 4, allowedGenerationClasses: ['remix', 'hybrid_short', 'generative_short'] });
    // Hypotheses the model wrote from imported data travel as untrusted data, never in the trusted packet.
    const parts = contextPacketParts(p);
    const trusted = parts.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
    expect(trusted).not.toContain('secret hypothesis');
    expect(parts.find((c) => c.type === 'untrusted' && c.sourceId === 'recent_experiments')).toMatchObject({ text: expect.stringContaining('secret hypothesis') });
  }, 60_000);
});

describe('proposal ids (§22 customer_tension_id, claim_ids[], asset_ids[])', () => {
  it('keeps ids from the packet, drops unknown ones and resolves claim wording from the vault', () => {
    const T = newId();
    const C = newId();
    const A = newId();
    const opts = { themeIds: new Set([T]), claimsById: new Map([[C, 'Absorbs in seconds']]), assetIds: new Set([A]) };
    const ok = gateProposal({ ...proposal(), claimWordings: [], customerTensionId: T, claimIds: [C], assetIds: [A] }, ['Absorbs in seconds'], [], opts);
    expect(ok.ok).toBe(true);
    expect(ok.cleaned).toMatchObject({ customerTensionId: T, claimIds: [C], assetIds: [A], claimWordings: ['Absorbs in seconds'] });
    const bad = gateProposal({ ...proposal(), claimWordings: [], customerTensionId: newId(), claimIds: [newId()], assetIds: [newId()] }, ['Absorbs in seconds'], [], opts);
    expect(bad.cleaned).toMatchObject({ customerTensionId: null, claimIds: [], assetIds: [] });
    expect(bad.removed.claims).toBe(1);
    expect(bad.reasons.join(' | ')).toMatch(/claim id not approved/);
    expect(bad.reasons.join(' | ')).toMatch(/unknown asset id dropped/);
  });
});

describe('concept gates (§20; plan 06 Phase 2 "hard gates first")', () => {
  it('refuses generated concepts for a low-fidelity product and never repeats an earlier set', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const p = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    await analyzeProduct(ctx, p.skuId, p.projectId);
    const first = await ownerPool()`select proposal->>'angle' as angle, proposal->>'hookMechanism' as hook from concepts where project_id = ${p.projectId} and batch = 1`;
    expect(first.length).toBe(3);

    // A second set is never a near-duplicate of the first.
    await generateConceptBatch(ctx, p.projectId, 2);
    const second = await ownerPool()`select proposal->>'angle' as angle, proposal->>'hookMechanism' as hook from concepts where project_id = ${p.projectId} and batch = 2`;
    const keys = new Set(first.map((c) => `${c.angle}|${c.hook}`));
    for (const c of second) expect(keys.has(`${c.angle}|${c.hook}`)).toBe(false);

    // Fidelity too uncertain: only the remix idea survives; the refused ones are recorded with their reasons.
    await ownerPool()`update skus set fidelity_confidence = 0.2 where id = ${p.skuId}`;
    await generateConceptBatch(ctx, p.projectId, 3);
    const third = await ownerPool()`select proposal->>'estimatedGenerationClass' as cls, gate_results from concepts where project_id = ${p.projectId} and batch = 3`;
    expect(third.map((c) => c.cls)).toEqual(['remix']);
    const refused = (third[0]!.gate_results as { refused: { reasons: string[] }[] }).refused;
    expect(refused.some((r) => r.reasons.some((x) => /fidelity too uncertain/.test(x)))).toBe(true);
  }, 90_000);
});

describe('scoring context (§20 drivers and gates)', () => {
  it('reads theme intensity, trend and recency, the rights-checked asset inventory, target platforms and class costs', async () => {
    const { t, ctx, skuId } = await tenant();
    const [s] = await ownerPool()`insert into customer_signals (workspace_id, sku_id, source, text, observed_at) values (${t.workspaceId}, ${skuId}, 'review', 'so sticky', now() - interval '10 days') returning id`;
    await ownerPool()`insert into customer_themes (workspace_id, sku_id, label, signal_type, prevalence, intensity, sample_size, trend, snippet_ids)
                      values (${t.workspaceId}, ${skuId}, 'sticky feel', 'objection', 0.4, 0.8, 5, 'rising', ${[s!.id as string]})`;
    const footage = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'creator_footage', skuId));
    await ownerPool()`insert into integrations (workspace_id, provider, status, external_account_id) values (${t.workspaceId}, 'tiktok', 'active', 'adv_1')`;
    const sc = await withTenant(t.workspaceId, (tx) => scoringContext(tx, skuId));
    expect(sc.themes[0]).toMatchObject({ intensity: 0.8, trend: 'rising' });
    expect(sc.themes[0]!.recencyDays).toBeCloseTo(10, 0);
    expect(sc.assets).toEqual({ all: { creator_footage: 1 }, rights: { creator_footage: 0 } });
    expect(sc.targetPlatforms).toEqual(['TIKTOK']);
    expect(sc.classCostMicros?.remix).toBeLessThan(sc.classCostMicros!.generative_short!);
    expect(sc.families).toEqual([]);
    await ownerPool()`update assets set rights_attested_at = now() where id = ${footage.id}`;
    expect((await withTenant(t.workspaceId, (tx) => scoringContext(tx, skuId))).assets!.rights).toEqual({ creator_footage: 1 });
  });
});
