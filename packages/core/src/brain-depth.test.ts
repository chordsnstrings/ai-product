import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import type { LlmJsonRequest, LlmProvider } from '@arkiv/providers';
import { analyzeProduct, startPreview } from './analysis';
import { deleteAsset } from './assets';
import { assignSkuBrand,createBrand, updateBrandBrain } from './brand';
import { approveClaim, blockClaim, claimHistory, EVIDENCE_EXPIRING_REASON, listClaims, proposeClaim, sweepExpiringEvidence } from './claims';
import { claimMeaningKey } from './compliance';
import { approveFingerprintViews, refreshPackaging, versionFingerprint } from './fingerprint';
import { importedGenome } from './genome';
import type { ProductExtraction } from './intel-schemas';
import { mockGenome } from './mock-intel';
import { decideFact, inciFacts, splitInci } from './product-truth';
import { ctxFor, MockImage, MockLlm, MockTts, MockVideo, productPhoto, setProviders } from './testing';
import { ingestBytes } from './uploads';

beforeEach(truncateAll);
afterEach(() => setProviders(undefined));
afterAll(closeAll);

describe('claim meaning (standard §17 canonical_meaning)', () => {
  it('folds phrasings of the same claim onto one key, and keeps negations and different numbers apart', () => {
    expect(claimMeaningKey('24h hydration')).toBe(claimMeaningKey('Hydrates for 24 hours'));
    expect(claimMeaningKey('Moisturizes for twenty-four hours')).toBe(claimMeaningKey('24-hour hydration'));
    expect(claimMeaningKey('Reduces the look of fine lines')).toBe(claimMeaningKey('reduced look of fine lines'));
    expect(claimMeaningKey('Fragrance-free')).not.toBe(claimMeaningKey('Not fragrance-free'));
    expect(claimMeaningKey('Hydrates for 24 hours')).not.toBe(claimMeaningKey('Hydrates for 48 hours'));
  });
});

describe('Claims Vault: one claim per meaning, with an append-only decision history (§15, §17)', () => {
  it('joins another wording of the same claim, versions every decision and keeps history immutable', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await withTenant(t.workspaceId, async (tx) => {
      const a = await proposeClaim(tx, ctx, skuId, { wording: '24h hydration', origin: 'extracted', sourceText: 'page' });
      const b = await proposeClaim(tx, ctx, skuId, { wording: 'Hydrates for 24 hours', origin: 'extracted', sourceText: 'label' });
      expect(b.id).toBe(a.id);
      expect(b.altWordings).toEqual(['Hydrates for 24 hours']);
      // The model's canonical meaning joins a phrasing the deterministic key alone would not.
      const c = await proposeClaim(tx, ctx, skuId, { wording: 'All-day moisture', meaning: 'hydrates for 24 hours', origin: 'extracted' });
      expect(c.id).toBe(a.id);
      expect((await listClaims(tx, skuId)).length).toBe(1);

      await approveClaim(tx, ctx, a.id, { markets: ['US'], platforms: ['TIKTOK'], wording: 'Hydration for 24 hours' });
      await blockClaim(tx, ctx, a.id, 'Evidence withdrawn');
      const h = await claimHistory(tx, a.id);
      expect(h.map((v) => v.change)).toEqual(['blocked', 'approved', 'wording_added', 'wording_added', 'created']);
      expect(h[0]).toMatchObject({ version: 5, status: 'BLOCKED', reason: 'Evidence withdrawn', actor: `user:${t.userId}` });
      // The re-worded approval keeps the wording it was found in among its wordings, and the old version keeps its own.
      expect(h[1]!.wording).toBe('Hydration for 24 hours');
      expect(h[1]!.altWordings).toContain('24h hydration');
      expect(h[4]).toMatchObject({ status: 'MERCHANT_REVIEW_REQUIRED', wording: '24h hydration' });
    });
    // History is never edited.
    await expect(ownerPool()`update claim_versions set status = 'VERIFIED'`).rejects.toThrow(/append-only/);
    const created = await ownerPool()`select payload from events where type = 'CLAIM_CREATED' and workspace_id = ${t.workspaceId}`;
    expect(created[0]!.payload).toMatchObject({ wording: '24h hydration', origin: 'extracted' });
  });

  it('a riskier phrasing with the same meaning stays its own claim; a claim created RESTRICTED emits CLAIM_RESTRICTED', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await withTenant(t.workspaceId, async (tx) => {
      const safe = await proposeClaim(tx, ctx, skuId, { wording: 'Hydrates skin', origin: 'extracted' });
      const clinical = await proposeClaim(tx, ctx, skuId, { wording: 'Clinically proven to hydrate skin', meaning: 'hydrates skin', origin: 'extracted' });
      expect(clinical.id).not.toBe(safe.id);
      expect(clinical.status).toBe('RESTRICTED');
    });
    const ev = await ownerPool()`select subject_id from events where type = 'CLAIM_RESTRICTED' and workspace_id = ${t.workspaceId}`;
    expect(ev).toHaveLength(1);
  });

  it('the evidence-expiry sweep sends claims back to review with a version and CLAIM_REVIEW_REQUIRED, per workspace', async () => {
    const t = await makeTenant();
    const other = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    const otherSku = await makeSku(other.workspaceId);
    const claimId = await withTenant(t.workspaceId, async (tx) => (await proposeClaim(tx, ctx, skuId, { wording: 'Non-comedogenic', origin: 'merchant' })).id);
    const fresh = await withTenant(other.workspaceId, async (tx) => (await proposeClaim(tx, ctxFor(other.workspaceId, other.userId), otherSku, { wording: 'Non-comedogenic', origin: 'merchant' })).id);
    await ownerPool()`update claims set status = 'VERIFIED' where id in ${ownerPool()([claimId, fresh])}`;
    await ownerPool()`insert into claim_evidence (workspace_id, claim_id, evidence_type, supplied_by, expiry_date) values
                        (${t.workspaceId}, ${claimId}, 'lab_test', 'user:x', (now() + interval '5 days')::date),
                        (${other.workspaceId}, ${fresh}, 'lab_test', 'user:x', (now() + interval '200 days')::date)`;
    expect(await withSystem((tx) => sweepExpiringEvidence(tx))).toBe(1);
    const [c] = await ownerPool()`select status from claims where id = ${claimId}`;
    expect(c!.status).toBe('MERCHANT_REVIEW_REQUIRED');
    const [v] = await ownerPool()`select change, reason, actor, workspace_id from claim_versions where claim_id = ${claimId} order by version desc limit 1`;
    expect(v).toMatchObject({ change: 'evidence_expiring', reason: EVIDENCE_EXPIRING_REASON, actor: 'system:sweep-evidence', workspace_id: t.workspaceId });
    const ev = await ownerPool()`select workspace_id, subject_id, payload from events where type = 'CLAIM_REVIEW_REQUIRED'`;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ workspace_id: t.workspaceId, subject_id: claimId, payload: { reason: 'evidence_expiring' } });
    expect((await ownerPool()`select status from claims where id = ${fresh}`)[0]!.status).toBe('VERIFIED');
  });
});

describe('Creative Genome families for imported ads (§19)', () => {
  it('nests the analyst’s strategy, hook, body, production and compliance genes and records lineage', () => {
    const g = importedGenome(mockGenome('I was obsessed — this lightweight serum absorbs fast, no sticky feel. Before and after. #ad Shop the link'), {
      sourceAssetIds: ['a1'],
      parentCreativeId: null,
      promptVersion: 'genome@1.1.0',
      model: 'm',
    }) as Record<string, Record<string, unknown>>;
    expect(g.schemaVersion).toBe(2);
    expect(g.strategy).toMatchObject({ funnelIntent: 'conversion', objection: 'feels sticky or heavy', benefit: 'absorbs quickly' });
    expect(g.compliance).toMatchObject({ beforeAfter: true, creatorConnection: 'paid', claimIds: [] });
    expect(g.lineage).toMatchObject({ sourceAssetIds: ['a1'], variantRole: 'imported', promptVersions: { genome: 'genome@1.1.0' } });
    expect(g.angle).toBeTruthy();
  });
});

describe('INCI as atomic facts (§16 "INCI ingredient")', () => {
  it('splits an ingredient list in label order, keeping parenthesised synonyms with their ingredient', () => {
    expect(splitInci('Ingredients: Aqua (Water), Glycerin, Niacinamide; Parfum (Fragrance, Linalool).')).toEqual(['Aqua (Water)', 'Glycerin', 'Niacinamide', 'Parfum (Fragrance, Linalool)']);
    const f = inciFacts('Aqua, Glycerin', { sourceType: 'json_ld', sourceId: 'sha256:x', sourceUrl: 'https://x' });
    expect(f.map((x) => [x.key, x.valueText, x.factType])).toEqual([['inci:1', 'Aqua', 'inci_ingredient'], ['inci:2', 'Glycerin', 'inci_ingredient']]);
  });

  it('a merchant-decided ingredient list decides each ingredient and ends positions it no longer has', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await ownerPool()`update skus set brand_id = ${t.brandId} where id = ${skuId}`;
    await withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'ingredients', { text: 'Aqua, Glycerin, Squalane' }));
    await withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'ingredients', { text: 'Aqua, Squalane' }));
    const rows = await ownerPool()`select normalized_key, value_text, brand_id, source_id from product_facts where sku_id = ${skuId} and fact_type = 'inci_ingredient' and status <> 'SUPERSEDED' order by normalized_key`;
    expect(rows.map((r) => [r.normalized_key, r.value_text])).toEqual([['inci:1', 'Aqua'], ['inci:2', 'Squalane']]);
    // Every fact carries its brand (§16 ProductFact.brand_id) and its source record.
    expect(rows.every((r) => r.brand_id === t.brandId && r.source_id === `user:${t.userId}`)).toBe(true);
  });
});

/** The product analyst reads the label, its box and the package geometry (what a live model returns). */
class ReadsLabel implements LlmProvider {
  readonly name = 'anthropic';
  private mock = new MockLlm();
  constructor(private patch: Partial<ProductExtraction> = {}) {}
  async json<T>(req: LlmJsonRequest<T>) {
    const r = await this.mock.json(req);
    if (req.system.includes('product analyst')) Object.assign(r.data as ProductExtraction, { labelText: 'GLOW SERUM 30 ml', labelBox: { x: 0.36, y: 0.45, w: 0.28, h: 0.16 }, liquidColor: 'amber', ...this.patch });
    return r;
  }
}

const providersWith = (llm: LlmProvider) => setProviders({ llm, image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });

async function analysedPhotoProduct(llm: LlmProvider = new ReadsLabel()) {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  providersWith(llm);
  expect((await analyzeProduct(ctx, skuId, projectId)).status).toBe('ready');
  return { t, ctx, skuId, projectId, photoId: asset.id };
}

describe('analysis: provenance, early cut-out and a full Visual Fingerprint (§15, §16, plan 04 L3)', () => {
  it('every fact names its source record and brand; PRODUCT_ANALYZED carries its duration', async () => {
    const { t, skuId } = await analysedPhotoProduct();
    const facts = await ownerPool()`select normalized_key, source_type, source_id, source_url, brand_id from product_facts where sku_id = ${skuId}`;
    expect(facts.length).toBeGreaterThan(3);
    expect(facts.filter((f) => !f.source_id).map((f) => f.normalized_key)).toEqual([]);
    expect(facts.every((f) => f.brand_id === t.brandId)).toBe(true);
    // Vision and label readings point at the model call and the photos it was shown.
    const vision = facts.filter((f) => f.source_type === 'vision' || f.source_type === 'photo_ocr');
    expect(vision.length).toBeGreaterThan(0);
    const [job] = await ownerPool()`select id from provider_jobs where workspace_id = ${t.workspaceId} and task = 'extract.product_facts'`;
    expect(vision.every((f) => f.source_id === job!.id && String(f.source_url).startsWith('arkiv-assets:'))).toBe(true);
    const [fn] = await ownerPool()`select props from funnel_events where type = 'PRODUCT_ANALYZED' and workspace_id = ${t.workspaceId}`;
    expect(typeof (fn!.props as { durationMs?: number }).durationMs).toBe('number');
  }, 60_000);

  it('keys the cut-out right after the photos and reuses it for the fingerprint, with views, label crop, geometry and regions', async () => {
    const { skuId, photoId } = await analysedPhotoProduct();
    const [s] = await ownerPool()`select analysis from skus where id = ${skuId}`;
    const early = (s!.analysis as { earlyCutout: { assetId: string; from: string } }).earlyCutout;
    expect(early.from).toBe(photoId);
    const [fp] = await ownerPool()`select * from visual_fingerprints where sku_id = ${skuId} and active`;
    expect(fp!.cutout_asset_id).toBe(early.assetId); // not keyed twice
    expect((await ownerPool()`select count(*)::int as n from assets where sku_id = ${skuId} and kind = 'cutout'`)[0]!.n).toBe(1);
    expect(fp!.views).toEqual({ [photoId]: 'front' });
    expect(fp!.liquid_color).toBe('amber');
    expect(fp!.reason).toBe('analysis');
    expect(fp!.geometry).toMatchObject({ silhouette: 'cylinder' });
    expect(Number((fp!.geometry as { measuredAspectRatio?: number }).measuredAspectRatio)).toBeGreaterThan(1);
    const [crop] = await ownerPool()`select kind, width, height from assets where id = ${fp!.label_crop_asset_id}`;
    expect(crop).toMatchObject({ kind: 'label_crop', width: 280, height: 200 });
    expect((fp!.critical_regions as { kind: string }[]).map((r) => r.kind).sort()).toEqual(['closure', 'label']);
  }, 60_000);

  it('a photo the analyst finds is not skincare is rejected with a SKU_REJECTED funnel event', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    providersWith(new ReadsLabel({ category: 'not_skincare', labelText: 'Scented candle' }));
    expect((await analyzeProduct(ctx, skuId, projectId)).status).toBe('rejected');
    const [fn] = await ownerPool()`select props from funnel_events where type = 'SKU_REJECTED' and workspace_id = ${t.workspaceId}`;
    expect(fn!.props).toMatchObject({ stage: 'label', category: 'not_skincare' });
  }, 60_000);
});

describe('Visual Fingerprint versions (§16 versioned, §42 packaging refresh)', () => {
  it('approves views, refreshes packaging as a new version and keeps approved storyboards on the old packaging', async () => {
    const { t, ctx, skuId, photoId } = await analysedPhotoProduct();
    const [v1] = await ownerPool()`select id, version from visual_fingerprints where sku_id = ${skuId} and active`;
    // An approved storyboard and a draft one of this product.
    const [p] = await ownerPool()`select id from projects where sku_id = ${skuId}`;
    const [c] = await ownerPool()`insert into concepts (workspace_id, sku_id, project_id, batch, idx, proposal, is_pick, prompt_version, model)
                                  values (${t.workspaceId}, ${skuId}, ${p!.id}, 9, 'A', '{}', false, 't', 'n/a') returning id`;
    const [approved] = await ownerPool()`insert into storyboards (workspace_id, project_id, concept_id, status, visual_fingerprint_id) values (${t.workspaceId}, ${p!.id}, ${c!.id}, 'approved', ${v1!.id}) returning id`;
    const [draft] = await ownerPool()`insert into storyboards (workspace_id, project_id, concept_id, status, visual_fingerprint_id) values (${t.workspaceId}, ${p!.id}, ${c!.id}, 'ready', ${v1!.id}) returning id`;

    await expect(withTenant(t.workspaceId, (tx) => approveFingerprintViews(tx, ctx, skuId, [crypto.randomUUID()]))).rejects.toMatchObject({ code: 'INVALID' });
    const a = await withTenant(t.workspaceId, (tx) => approveFingerprintViews(tx, ctx, skuId, [photoId]));
    expect(a.version).toBe(Number(v1!.version) + 1);
    expect((await withTenant(t.workspaceId, (tx) => approveFingerprintViews(tx, ctx, skuId, [photoId]))).version).toBeNull(); // no change, no version

    const r = await withTenant(t.workspaceId, async (tx) => refreshPackaging(tx, ctx, skuId, [{ bytes: await productPhoto('GLOW SERUM NEW', '#8FB3C9'), filename: 'new-pack.jpg' }], { labelText: 'GLOW SERUM NEW', note: 'blue bottle' }));
    expect(r).toMatchObject({ added: 1, held: 0 });
    const all = await ownerPool()`select id, version, active, reason, label_text, approved_view_ids, reference_asset_ids from visual_fingerprints where sku_id = ${skuId} order by version`;
    expect(all.filter((f) => f.active)).toHaveLength(1);
    const cur = all.at(-1)!;
    expect(cur).toMatchObject({ active: true, reason: 'packaging_refresh', label_text: 'GLOW SERUM NEW', approved_view_ids: [] });
    expect(cur.reference_asset_ids).not.toContain(photoId);
    const sb = await ownerPool()`select id, visual_fingerprint_id from storyboards where id in ${ownerPool()([approved!.id as string, draft!.id as string])}`;
    expect(sb.find((x) => x.id === approved!.id)!.visual_fingerprint_id).toBe(v1!.id);
    expect(sb.find((x) => x.id === draft!.id)!.visual_fingerprint_id).toBe(cur.id);
    const ev = await ownerPool()`select payload from events where type = 'VISUAL_FINGERPRINT_VERSIONED' and subject_id = ${skuId} order by seq`;
    expect(ev.map((e) => (e.payload as { reason: string }).reason)).toEqual(['analysis', 'views_approved', 'packaging_refresh']);
    // The old packaging's photo stays while an ad in the works is pinned to it.
    await expect(withTenant(t.workspaceId, (tx) => deleteAsset(tx, ctx, photoId))).rejects.toMatchObject({ code: 'CONFLICT' });
    await ownerPool()`update storyboards set status = 'superseded' where id in ${ownerPool()([approved!.id as string, draft!.id as string])}`;
    expect(await withTenant(t.workspaceId, (tx) => deleteAsset(tx, ctx, photoId))).toMatchObject({ purged: true });
  }, 90_000);

  it('versions serialise per SKU and never cross workspaces', async () => {
    const { t, ctx, skuId } = await analysedPhotoProduct();
    const other = await makeTenant();
    await expect(withTenant(other.workspaceId, (tx) => versionFingerprint(tx, ctxFor(other.workspaceId, other.userId), skuId, { label_text: 'x' }, { reason: 'added_views' }))).rejects.toThrow();
    const v = await withTenant(t.workspaceId, (tx) => versionFingerprint(tx, ctx, skuId, { label_text: 'GLOW' }, { reason: 'added_views' }));
    expect(v.version).toBe(2);
  }, 60_000);
});

describe('Brand Brain (§16): every field, several brands, brand-wide claims', () => {
  it('stores fonts, talent, CTA vocabulary, restrictions and brand-wide claims as a version, and proposes the claims per product', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await ownerPool()`update skus set brand_id = ${t.brandId}, status = 'active' where id = ${skuId}`;
    const r = await withTenant(t.workspaceId, (tx) =>
      updateBrandBrain(tx, ctx, { brandId: t.brandId, name: 'Lumen', colors: ['#1F2A44'], fonts: { heading: 'Canela', body: 'Inter' }, talentTypes: ['women 30–45'], ctaVocabulary: ['Shop now'], claims: ['Cruelty-free'], restrictions: ['clean beauty'] }),
    );
    expect(r).toMatchObject({ changed: true, claimsProposed: 1 });
    const [b] = await ownerPool()`select brain from brands where id = ${t.brandId}`;
    expect(b!.brain).toMatchObject({ fonts: { heading: 'Canela', body: 'Inter' }, talentTypes: ['women 30–45'], ctaVocabulary: ['Shop now'], claims: ['Cruelty-free'], restrictions: ['clean beauty'] });
    const claims = await ownerPool()`select preferred_wording, status from claims where sku_id = ${skuId}`;
    expect(claims).toEqual([{ preferred_wording: 'Cruelty-free', status: 'MERCHANT_REVIEW_REQUIRED' }]); // never approved automatically
    // A save that leaves out the logo keeps it; a file of another workspace is refused.
    const other = await makeTenant();
    const foreign = await withTenant(other.workspaceId, async (tx) => ingestBytes(tx, ctxFor(other.workspaceId, other.userId), await productPhoto(), 'brand_logo', null));
    await expect(withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { brandId: t.brandId, name: 'Lumen', logoAssetId: foreign.id }))).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('adds brands only within the plan, assigns a product to one and starts previews under a chosen brand of this workspace only', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'SCALE' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const { brandId } = await withTenant(t.workspaceId, (tx) => createBrand(tx, ctx, 'Second Line'));
    await expect(withTenant(t.workspaceId, (tx) => createBrand(tx, ctx, 'second line'))).rejects.toMatchObject({ code: 'CONFLICT' });
    await withTenant(t.workspaceId, (tx) => createBrand(tx, ctx, 'Third'));
    await expect(withTenant(t.workspaceId, (tx) => createBrand(tx, ctx, 'Fourth'))).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    const member = ctxFor(t.workspaceId, t.userId, 'MEMBER', 'ACTIVE_PAID');
    await expect(withTenant(t.workspaceId, (tx) => createBrand(tx, member, 'Nope'))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const skuId = await makeSku(t.workspaceId);
    await ownerPool()`update skus set brand_id = ${t.brandId} where id = ${skuId}`;
    await withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'size', { text: '30 ml' }));
    await withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { brandId, name: 'Second Line', claims: ['Vegan'] }));
    expect(await withTenant(t.workspaceId, (tx) => assignSkuBrand(tx, ctx, skuId, brandId))).toEqual({ changed: true });
    expect((await ownerPool()`select brand_id from skus where id = ${skuId}`)[0]!.brand_id).toBe(brandId);
    expect((await ownerPool()`select distinct brand_id from product_facts where sku_id = ${skuId}`).map((r) => r.brand_id)).toEqual([brandId]);
    expect((await ownerPool()`select preferred_wording from claims where sku_id = ${skuId}`).map((r) => r.preferred_wording)).toEqual(['Vegan']);

    const other = await makeTenant();
    await expect(withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { url: 'https://shop.example/products/a', brandId: other.brandId }))).rejects.toMatchObject({ code: 'INVALID' });
    const p = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { url: 'https://shop.example/products/a', brandId }));
    expect((await ownerPool()`select brand_id from skus where id = ${p.skuId}`)[0]!.brand_id).toBe(brandId);
  });
});
