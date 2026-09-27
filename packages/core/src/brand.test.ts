import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, startPreview } from './analysis';
import { brandBrainHistory, updateBrandBrain } from './brand';
import { buildContext } from './creative-director';
import { ingestBytes } from './uploads';
import { importSignals, parseReviewPaste } from './customer-language';
import { ctxFor, MockImage, MockLlm, MockTts, MockVideo, productPhoto, setProviders } from './testing';
import type { LlmJsonRequest, LlmJsonResult } from '@arkiv/providers';

/** §15: Brand Brain edits are versioned records with provenance, not an overwritten JSON blob. */
beforeEach(truncateAll);
afterEach(() => setProviders(undefined));
afterAll(closeAll);

describe('Brand Brain versions', () => {
  it('every brand starts at version 1 and each save adds an immutable version with a diff and a brand event', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const [v1] = await ownerPool()`select v.version, b.current_version_id = v.id as current from brand_brain_versions v join brands b on b.id = v.brand_id where v.workspace_id = ${t.workspaceId}`;
    expect(v1).toMatchObject({ version: 1, current: true });

    const r = await withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { name: 'Test Brand', tone: 'calm, clinical', market: 'gb' }, 'new tone'));
    expect(r).toMatchObject({ version: 2, changed: true });
    await withTenant(t.workspaceId, async (tx) => {
      const [b] = await tx`select brain, current_version_id from brands where id = ${r.brandId}`;
      expect(b!.brain).toMatchObject({ tone: 'calm, clinical', market: 'GB' });
      expect(b!.current_version_id).toBe(r.versionId);
      const history = await brandBrainHistory(tx, r.brandId);
      expect(history.map((h) => h.version)).toEqual([2, 1]);
      expect(history[0]!.diff).toMatchObject({ tone: { from: null, to: 'calm, clinical' }, market: { from: 'US', to: 'GB' } });
      expect(history[0]!.reason).toBe('new tone');
      expect(history[0]!.created_by).toBe(`user:${t.userId}`);
      const [e] = await tx`select type, payload from events where subject_id = ${r.brandId}`;
      expect(e!.type).toBe('BRAND_BRAIN_VERSIONED');
      expect((e!.payload as { version: number }).version).toBe(2);
      expect(await tx`select 1 from events where type = 'PRODUCT_FACT_CHANGED'`).toHaveLength(0);
    });

    // Saving the same values again is not a new version; history can never be edited.
    expect(await withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { name: 'Test Brand', tone: 'calm, clinical', market: 'GB' }))).toMatchObject({ version: 2, changed: false });
    await expect(ownerPool()`update brand_brain_versions set brain = '{}' where brand_id = ${r.brandId}`).rejects.toThrow(/append-only/);
  });

  it('Viewers cannot edit the Brand Brain', async () => {
    const t = await makeTenant();
    await expect(withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctxFor(t.workspaceId, t.userId, 'VIEWER'), { name: 'X' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('generation uses the Brand Brain and records which version it used', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const r = await withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { name: 'Test Brand', tone: 'quiet luxury', prohibited: 'no before/after' }));
    const skuId = await makeSku(t.workspaceId);
    const packet = await withTenant(t.workspaceId, (tx) => buildContext(tx, skuId));
    expect(packet.packet.brand).toMatchObject({ tone: 'quiet luxury', neverShowOrSay: 'no before/after', market: 'US' });
    expect(packet.brandBrainVersionId).toBe(r.versionId);

    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const p = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    await analyzeProduct(ctx, p.skuId, p.projectId);
    const concepts = await ownerPool()`select brand_brain_version_id from concepts where project_id = ${p.projectId}`;
    expect(concepts.length).toBeGreaterThan(0);
    expect(new Set(concepts.map((c) => c.brand_brain_version_id))).toEqual(new Set([r.versionId]));
  }, 60_000);

  it('grounds concepts in representative customer phrases (untrusted, claim-tagged) and blocks what the brand never says (§16, §18)', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    await withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { name: 'Test Brand', prohibited: 'no lab coats, never "miracle"' }));
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const p = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    await withTenant(t.workspaceId, (tx) => importSignals(tx, ctx, p.skuId, parseReviewPaste('review,rating\n"So sticky at first, write me at jo@example.com",3\n"This cured my acne in a week",5\n"Sinks in fast and feels soft",5')));
    const sig = await ownerPool()`select id, text from customer_signals where sku_id = ${p.skuId} order by text`;
    await ownerPool()`insert into customer_themes (workspace_id, sku_id, label, signal_type, prevalence, intensity, sample_size, snippet_ids)
                      values (${t.workspaceId}, ${p.skuId}, 'sticky at first', 'objection', 0.5, 0.5, 3, ${sig.map((x) => x.id as string)}::uuid[])`;
    const built = await withTenant(t.workspaceId, (tx) => buildContext(tx, p.skuId));
    expect(built.prohibited).toEqual(['lab coats', '"miracle"']);
    expect(built.phrases).toHaveLength(3);
    expect(built.phrases.find((x) => x.text.includes('acne'))).toMatchObject({ theme: 'sticky at first', doNotClaim: true });
    expect(built.phrases.find((x) => x.text.includes('sticky'))).toMatchObject({ doNotClaim: false });
    expect(built.phrases.some((x) => x.text.includes('@'))).toBe(false); // PII stays redacted

    const seen: LlmJsonRequest<unknown>[] = [];
    class Recording extends MockLlm {
      override async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
        seen.push(req as LlmJsonRequest<unknown>);
        return super.json(req);
      }
    }
    setProviders({ llm: new Recording(), image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    await analyzeProduct(ctx, p.skuId, p.projectId);
    const concepts = seen.find((r) => r.system.includes('Creative Director') && r.content.some((c) => c.type === 'text' && c.text.startsWith('Context packet')));
    expect(concepts).toBeTruthy();
    const part = concepts!.content.find((c) => c.type === 'untrusted' && c.sourceId === 'customer_phrases');
    expect(part).toBeTruthy();
    const sent = JSON.parse((part as { text: string }).text) as { phrase: string; do_not_claim?: boolean }[];
    expect(sent.find((x) => x.phrase.includes('acne'))?.do_not_claim).toBe(true);
    // The template the route sends tells the model what the phrases and the brand rules are for.
    expect(concepts!.system).toMatch(/customer_phrases/);
    expect(concepts!.system).toMatch(/product facts win/);
  }, 60_000);
});
