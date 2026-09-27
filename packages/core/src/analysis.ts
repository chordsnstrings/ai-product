import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, FREE_EXPLORATION, PROVISIONAL, newId, type CreativeGoal, type ProjectState } from '@arkiv/shared';
import { notePromptInjection, recordAbuseSignal } from './abuse';
import { allowKey, isAllowlisted } from './allowlist';
import { assetBytes, saveAsset } from './assets';
import { assertCan } from './authz';
import { proposeClaim } from './claims';
import { brandBrainFor, proposeBrandClaims } from './brand';
import { excludedProductReason, nonSkincareCategory, storeCategory } from './compliance';
import type { TenantContext } from './context';
import { authorize, authorizeOrTakeOver, settle } from './cost-governor';
import { CONCEPTS_MAX_TOKENS, generateConcepts } from './creative-director';
import { emit } from './events';
import { recordFunnel, uploadFailureCategory } from './funnel';
import { fetchImage, importProductUrl, type ExtractedProduct } from './ingest';
import { ProductExtraction, type PhotoView } from './intel-schemas';
import { mockExtraction } from './mock-intel';
import { llmJson, routedLines } from './model-gateway';
import { enqueue, isFreeTier, priorityFor, queueFor, Queues } from './outbox';
import { WEEKLY_RECOMMENDATION_SKUS, weekOf } from './recommendations';
import { refreshStock } from './stock';
import { planSteps, step } from './progress';
import { inciFacts, recordFacts, sameValue, type FactInput } from './product-truth';
import { cropRegion, measuredGeometry, versionFingerprint, type CriticalRegion } from './fingerprint';
import { mergeSkus } from './sku-merge';
import { recordVariants } from './sku-variants';
import { isTerminal, transition } from './projects';
import { DEFAULT_FIDELITY_THRESHOLDS } from './fidelity';
import { cutout, dominantColors, holdForReview, nameReviewFlags, toJpegBase64, usableAssetIds, type MediaReviewFlags } from './vision';
import { ingestBytes } from './uploads';
import { nextCatalogueNo } from './workspaces';

/**
 * Phase 1–2 pipeline: product in → Product Brain → three concepts (free preview, ≤ $0.20 COGS).
 * Steps are recorded as real progress events for the cataloguing screen (design M2).
 */

export const ANALYSIS_STEPS = [
  { key: 'read_page', label: 'Reading your product page' },
  { key: 'photos', label: 'Preparing product photos' },
  { key: 'identify', label: 'Identifying the product' },
  { key: 'claims', label: 'Checking claims against cosmetic rules' },
  { key: 'fingerprint', label: 'Cataloguing packaging details' },
  { key: 'concepts', label: 'Drafting three test ideas' },
];

export interface StartPreviewInput {
  url?: string | null;
  photoAssetIds?: string[];
  visitorId?: string | null;
  /** Client IP, for the abuse allowlist (never stored here). */
  ip?: string | null;
  /** The brand the product belongs to (multi-brand plans); the workspace's first brand otherwise. */
  brandId?: string | null;
}

/**
 * The product caps of a preview (plan 02 §2.1, standard §5): a provisional workspace holds PROVISIONAL.MAX_SKUS
 * products (more for staff-allowlisted evaluators); a signed-in free workspace adds a few a day. Counted under the
 * workspace row lock (the same lock nextCatalogueNo takes), so parallel submissions queue here and each sees the
 * others' SKUs instead of all counting before any commits.
 */
export async function assertCanAddSku(tx: Tx, ctx: TenantContext, ip: string | null) {
  if (ctx.workspaceState === 'PROVISIONAL' || isFreeTier(ctx)) await tx`select 1 from workspaces where id = ${ctx.workspaceId} for update`;
  if (ctx.workspaceState === 'PROVISIONAL') {
    const [n] = await tx`select count(*)::int as n from skus`;
    if (n!.n >= PROVISIONAL.MAX_SKUS) {
      // Staff-allowlisted evaluators (agencies, photographers) get a higher, still bounded, allowance (plan 05 §15).
      const allowed = n!.n < PROVISIONAL.ALLOWLISTED_MAX_SKUS && (await isAllowlisted(tx, [allowKey.ws(ctx.workspaceId), allowKey.ip(ip)]));
      if (!allowed) throw new DomainError('PAYMENT_REQUIRED', 'Save your work to add more products.', { needsAccount: true });
    }
  } else if (isFreeTier(ctx)) {
    // Signed in but not paying: a few new products a day (standard §5 bounded free preview COGS).
    const [n] = await tx`select count(*)::int as n from skus where created_at > now() - interval '24 hours'`;
    if (n!.n >= FREE_EXPLORATION.SKUS_PER_DAY) {
      throw new DomainError('PAYMENT_REQUIRED', `Free accounts can add ${FREE_EXPLORATION.SKUS_PER_DAY} products a day. Produce an ad from one of them, or come back tomorrow.`, { freeLimit: 'skus_per_day' });
    }
  }
}

/** Create the SKU + preview project and enqueue analysis (transactional). */
export async function startPreview(tx: Tx, ctx: TenantContext, input: StartPreviewInput) {
  assertCan(ctx, 'sku.create');
  if (!input.url && !input.photoAssetIds?.length) throw new DomainError('INVALID', 'Add a product link or at least one photo.');
  await assertCanAddSku(tx, ctx, input.ip ?? null);
  const skuId = newId();
  const projectId = newId();
  const no = await nextCatalogueNo(tx);
  // Brand Brain sits above the SKU (§16): the chosen brand of this workspace, else its first.
  const [brand] = input.brandId
    ? await tx`select id from brands where id = ${input.brandId} and workspace_id = ${ctx.workspaceId}`
    : await tx`select id from brands where workspace_id = ${ctx.workspaceId} order by created_at limit 1`;
  if (input.brandId && !brand) throw new DomainError('INVALID', 'That brand isn’t in this workspace.');
  // origin_visitor_id keeps the preview's funnel attribution if the SKU later moves into an existing account.
  await tx`insert into skus (id, workspace_id, brand_id, catalogue_no, name, status, source_url, source_kind, origin_visitor_id)
           values (${skuId}, ${ctx.workspaceId}, ${brand?.id ?? null}, ${no}, 'Reading your product…', 'analyzing',
                   ${input.url ?? null}, ${input.url ? 'url' : 'photos'}, ${input.visitorId ?? null})`;
  for (const a of input.photoAssetIds ?? []) await tx`update assets set sku_id = ${skuId}, kind = 'product_photo' where id = ${a} and sku_id is null`;
  await tx`insert into projects (id, workspace_id, sku_id, kind, state, created_by)
           values (${projectId}, ${ctx.workspaceId}, ${skuId}, 'preview', 'PRODUCT_UPLOADED', ${ctx.actor.kind + ':' + ctx.actor.id})`;
  await planSteps(tx, ctx.workspaceId, skuId, input.url ? ANALYSIS_STEPS : ANALYSIS_STEPS.filter((s) => s.key !== 'read_page'));
  await emit(tx, ctx, 'UPLOAD_COMPLETED', { type: 'sku', id: skuId }, { method: input.url ? 'url' : 'photos' });
  await enqueue(tx, ctx.workspaceId, queueFor(Queues.analyzeProduct, ctx), { skuId, projectId, actor: ctx.actor }, { priority: priorityFor(ctx) });
  await recordFunnel('UPLOAD_COMPLETED', { visitorId: input.visitorId, workspaceId: ctx.workspaceId, props: { method: input.url ? 'url' : 'photos' } }, tx);
  return { skuId, projectId, catalogueNo: no };
}

/**
 * A store-imported SKU's product as the analysis reads it: the current Shopify facts (name, description, brand,
 * price, ingredients/size from metafields, images), in the shape a page import produces.
 */
export async function shopifyExtracted(tx: Tx, skuId: string): Promise<ExtractedProduct> {
  const rows = await tx`select distinct on (normalized_key) normalized_key, value_text, value_number, value_json from product_facts
                        where sku_id = ${skuId} and source_type = 'shopify' and status <> 'SUPERSEDED' order by normalized_key, observed_at desc`;
  const f = new Map(rows.map((r) => [r.normalized_key as string, r]));
  const text = (k: string) => (f.get(k)?.value_text as string | null | undefined) ?? undefined;
  const money = (k: string) => (f.get(k)?.value_number != null ? Math.round(Number(f.get(k)!.value_number) * 1_000_000) : undefined);
  const [sku] = await tx`select shopify_product_id from skus where id = ${skuId}`;
  const images = f.get('images')?.value_json;
  return {
    source: 'shopify',
    name: text('name'),
    description: text('description'),
    brand: text('brand'),
    productType: text('product_type'),
    priceMicros: money('price'),
    compareAtMicros: money('compare_at_price'),
    currency: ((f.get('price')?.value_json as { currency?: string } | null)?.currency) ?? undefined,
    images: Array.isArray(images) ? (images as string[]) : [],
    sku: text('sku_code'),
    gtin: text('gtin'),
    ingredients: text('ingredients'),
    sizeText: text('size'),
    shopifyProductId: (sku?.shopify_product_id as string | null) ?? undefined,
    rawText: text('description') ?? '',
  };
}

/**
 * Facts from a structured import (§16 "prefer structured commerce data"), each traceable to its source record
 * (§15): the Shopify product id, else a hash of the fetched page, plus the URL.
 */
export function factsFromStructured(p: ExtractedProduct, url: string | null): FactInput[] {
  const src = p.source === 'shopify' ? 'shopify' : p.source === 'json_ld' ? 'json_ld' : 'product_page';
  const sourceId = p.shopifyProductId ?? (p.contentHash ? `sha256:${p.contentHash}` : null);
  const f: FactInput[] = [];
  const add = (key: string, v: Partial<FactInput>) => f.push({ key, sourceType: src, sourceId, sourceUrl: url, state: 'OBSERVED', ...v });
  if (p.name) add('name', { valueText: p.name });
  if (p.brand) add('brand', { valueText: p.brand });
  if (p.priceMicros) add('price', { valueNumber: p.priceMicros / 1_000_000, valueJson: { currency: p.currency ?? 'USD' } });
  if (p.compareAtMicros) add('compare_at_price', { valueNumber: p.compareAtMicros / 1_000_000 });
  if (p.sizeText) add('size', { valueText: p.sizeText });
  if (p.ingredients) {
    add('ingredients', { valueText: p.ingredients.slice(0, 2000) });
    // §16 "INCI ingredient": each ingredient its own fact, in label order.
    f.push(...inciFacts(p.ingredients, { sourceType: src, sourceId, sourceUrl: url }));
  }
  if (p.sku) add('sku_code', { valueText: p.sku });
  if (p.gtin) add('gtin', { valueText: p.gtin });
  if (p.inStock !== undefined) add('in_stock', { valueJson: p.inStock });
  if (p.variants?.length) add('variants', { valueJson: p.variants });
  if (p.description) add('description', { valueText: p.description.slice(0, 4000) });
  if (p.productType) {
    // The store's own category, as stated; and the skincare category it names, when it names one (structured data
    // preferred over the model's reading, §16).
    add('product_type', { valueText: p.productType.slice(0, 200) });
    const named = storeCategory(p.productType);
    if (named) add('category', { valueText: named, valueJson: { storeCategory: p.productType.slice(0, 200) }, confidence: 0.9 });
  }
  if (p.tags?.length) add('tags', { valueJson: p.tags });
  if (p.subscriptionAvailable) add('subscription_available', { valueJson: true });
  if (p.bundleEligible) add('bundle_eligible', { valueJson: true });
  if (p.usageDirections) add('usage_directions', { valueText: p.usageDirections.slice(0, 600) });
  if (p.properties && Object.keys(p.properties).length) add('properties', { valueJson: p.properties });
  return f;
}


/** The advertised product's own words (name, description, store category, ingredients) — not menus or footers. */
export function productScopeText(p: Pick<ExtractedProduct, 'name' | 'description' | 'productType' | 'ingredients'>): string {
  return [p.name, p.productType, p.description?.slice(0, 3000), p.ingredients?.slice(0, 2000)].filter(Boolean).join(' \n ');
}

/** What the model read on the product itself (name, label, the brand's own claims), for the post-extraction scope check. */
export const extractionScopeText = (x: Pick<ProductExtraction, 'name' | 'labelText' | 'claimsFound'>) =>
  [x.name, x.labelText ?? '', ...x.claimsFound.map((c) => `${c.wording} ${c.sourceQuote}`)].join(' \n ');

const words = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Facts from the vision/text extraction, each labelled with what it really is (§15): a reading of the label is
 * OBSERVED (photo_ocr), the model's interpretation is INFERRED (vision). The label's size and name are always
 * recorded, so a label that disagrees with the page surfaces as a dispute instead of being dropped (§42). Key
 * ingredients are OBSERVED only as the page's own INCI entries the model picked out; otherwise INFERRED.
 */
export function extractionFacts(x: ProductExtraction, extracted: ExtractedProduct | null, url: string | null, jobId: string | null, photoAssetIds: readonly string[] = []): FactInput[] {
  const facts = extractionFactsOf(x, extracted, url, jobId);
  // §15 provenance: what the model read or saw comes from the model call (source_id) and the photos it was shown.
  const photos = photoAssetIds.length ? `arkiv-assets:${photoAssetIds.join(',')}` : null;
  const out = facts.map((f) => (f.sourceType === 'vision' || f.sourceType === 'photo_ocr' ? { ...f, sourceUrl: f.sourceUrl ?? photos } : f));
  // Usage directions (§16) only as stated: the page's own words when the page says them, the label's when it
  // shows them, otherwise the model's reading (INFERRED).
  const dir = x.usageDirections?.trim();
  if (dir) {
    const d = words(dir);
    const onPage = !!extracted?.rawText && words(extracted.rawText).includes(d.slice(0, 60));
    const onLabel = !!x.labelText && words(x.labelText).includes(d.slice(0, 60));
    out.push(
      onPage
        ? { key: 'usage_directions', valueText: dir.slice(0, 600), sourceType: extracted?.source === 'shopify' ? 'shopify' : extracted?.source === 'json_ld' ? 'json_ld' : 'product_page', sourceId: extracted?.shopifyProductId ?? (extracted?.contentHash ? `sha256:${extracted.contentHash}` : jobId), sourceUrl: url, state: 'OBSERVED', confidence: 0.8 }
        : onLabel
          ? { key: 'usage_directions', valueText: dir.slice(0, 600), sourceType: 'photo_ocr', sourceId: jobId, sourceUrl: photos, state: 'OBSERVED', confidence: 0.7 }
          : { key: 'usage_directions', valueText: dir.slice(0, 600), sourceType: 'vision', sourceId: jobId, sourceUrl: photos, state: 'INFERRED', confidence: 0.5 },
    );
  }
  return out;
}

function extractionFactsOf(x: ProductExtraction, extracted: ExtractedProduct | null, url: string | null, jobId: string | null): FactInput[] {
  const label = x.labelText ? words(x.labelText) : '';
  const nameOnLabel = !!label && label.includes(words(x.name));
  const pageSrc = extracted?.source === 'shopify' ? 'shopify' : extracted?.source === 'json_ld' ? 'json_ld' : 'product_page';
  const inci = extracted?.ingredients ? extracted.ingredients.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean) : [];
  const onPage = [...new Set(x.keyIngredients.flatMap((k) => {
    const kk = words(k);
    const hit = kk.length >= 3 ? inci.find((t) => words(t) === kk || (kk.length >= 4 && words(t).includes(kk))) : undefined;
    return hit ? [hit] : [];
  }))];
  const vision = { sourceType: 'vision' as const, sourceId: jobId, state: 'INFERRED' as const };
  const facts: FactInput[] = [
    nameOnLabel
      ? { key: 'name', valueText: x.name, sourceType: 'photo_ocr', sourceId: jobId, state: 'OBSERVED', confidence: 0.8 }
      : { key: 'name', valueText: x.name, ...vision, confidence: 0.8 },
    { key: 'category', valueText: x.category, ...vision, confidence: 0.85 },
    { key: 'format', valueText: x.format, ...vision, confidence: 0.7 },
    { key: 'texture', valueText: x.texture, ...vision, confidence: 0.6 },
    onPage.length
      ? { key: 'key_ingredients', valueText: onPage.join(', '), sourceType: pageSrc, sourceId: extracted?.shopifyProductId ?? (extracted?.contentHash ? `sha256:${extracted.contentHash}` : jobId), sourceUrl: url, state: 'OBSERVED', confidence: 0.8 }
      : { key: 'key_ingredients', valueText: x.keyIngredients.join(', ') || null, ...vision, confidence: 0.6 },
    { key: 'label_text', valueText: x.labelText, sourceType: 'photo_ocr', sourceId: jobId, state: 'OBSERVED', confidence: x.assetQualityConfidence },
    { key: 'packaging', valueJson: x.packaging, ...vision, confidence: 0.8 },
  ];
  if (x.sizeText) facts.push({ key: 'size', valueText: x.sizeText, sourceType: 'photo_ocr', sourceId: jobId, state: 'OBSERVED', confidence: 0.7 });
  return facts;
}

export async function analyzeProduct(ctx: TenantContext, skuId: string, projectId: string): Promise<{ status: 'ready' | 'rejected' | 'needs_input' | 'skipped'; reason?: string }> {
  const ws = ctx.workspaceId;
  const sku = await withTenant(ws, async (tx) => {
    const [s] = await tx`select * from skus where id = ${skuId}`;
    if (!s) throw new DomainError('NOT_FOUND', 'Product not found');
    return s;
  });
  if (sku.status !== 'analyzing') return { status: 'ready' }; // idempotent re-run

  const state = (sku.analysis ?? {}) as AnalysisState;

  // 1. Structured import (preferred source of truth, §16).
  let extracted: ExtractedProduct | null = null;
  let listing: ExtractedProduct | null = null;
  if (sku.source_kind === 'shopify') {
    // Created from the connected store: its facts are already recorded (Shopify API), so the page isn't read.
    extracted = await withTenant(ws, (tx) => shopifyExtracted(tx, skuId));
  } else if (sku.source_url) {
    await withTenant(ws, (tx) => step(tx, ws, skuId, 'read_page', 'active'));
    try {
      const page = await importProductUrl(sku.source_url as string);
      // A collection or home page lists several products (plan 03 P2, §42): nothing on it is this product's truth.
      if (page.pageKind === 'listing' && (page.productChoices?.length ?? 0) >= 2) listing = page;
      else extracted = page;
      if (extracted) await withTenant(ws, async (tx) => {
        await recordFacts(tx, ctx, skuId, factsFromStructured(extracted!, sku.source_url as string));
        // §42: each size/shade keeps its own price, availability and image; a link to one variant chooses it.
        if (extracted!.variants?.length) {
          await recordVariants(tx, ctx, skuId, extracted!.source === 'shopify' ? 'shopify' : 'json_ld', extracted!.variants, extracted!.currency ?? null);
          if (extracted!.selectedVariantId) {
            await tx`update projects p set sku_variant_id = v.id from sku_variants v
                     where p.id = ${projectId} and v.sku_id = ${skuId} and v.external_id = ${extracted!.selectedVariantId} and v.workspace_id = p.workspace_id`;
          }
        }
        // §42: availability as the page states it when it lists no variants (theirs decided above).
        await refreshStock(tx, ctx, skuId, extracted!.inStock ?? null);
        await step(tx, ws, skuId, 'read_page', 'done', extracted!.name ? `Found “${extracted!.name}”` : 'Page read');
        // One SKU per store product (§42 "Duplicate import"): a product already in the catalogue keeps its SKU as
        // the match; this import stays unlinked rather than competing for it.
        if (extracted!.shopifyProductId) {
          await tx`update skus set shopify_product_id = ${extracted!.shopifyProductId} where id = ${skuId}
                   and not exists (select 1 from skus o where o.shopify_product_id = ${extracted!.shopifyProductId} and o.id <> ${skuId})`;
        }
      });
    } catch (e) {
      // Blocked/JS-only pages fall back to photos without losing the URL (§42, plan 03 P2).
      await withTenant(ws, async (tx) => {
        await step(tx, ws, skuId, 'read_page', 'failed', e instanceof DomainError ? e.message : 'We couldn’t read that page');
        await recordFunnel('URL_PARSE_FAILED', { workspaceId: ws, props: { reason: (e as Error).message, category: uploadFailureCategory(e) } }, tx);
      });
    }
  }

  // 1a. "Which product?" (plan 03 P2): a collection or home page — the merchant picks one of its products before
  //     any photo is downloaded or anything is spent (chooseProduct re-reads that product's page).
  if (listing) {
    const choices = listing.productChoices!.slice(0, 12);
    await waitForMerchant(ctx, skuId, projectId, { step: 'read_page', copy: CHOOSE_PRODUCT_COPY, detail: 'choose_product', analysis: { productChoices: choices } });
    return { status: 'needs_input', reason: 'choose_product' };
  }

  // 1b. Duplicate import (§42): the same store product, barcode, link or name and size as a product already in the
  //     catalogue — ask whether to update that one or add this as new, before downloading or spending anything.
  if (extracted && sku.source_kind !== 'shopify' && !state.duplicate?.resolved) {
    const ex = extracted;
    const match = await withTenant(ws, (tx) => findDuplicateSku(tx, skuId, { url: sku.source_url as string | null, shopifyProductId: ex.shopifyProductId, gtin: ex.gtin, name: ex.name, size: ex.sizeText }));
    if (match) {
      const copy = duplicateCopy(match);
      await waitForMerchant(ctx, skuId, projectId, { step: 'photos', copy, detail: 'possible_duplicate', analysis: { duplicate: match } });
      return { status: 'needs_input', reason: 'possible_duplicate' };
    }
  }

  // 2. Photos: uploaded first, then page images (downloaded into our own storage).
  await withTenant(ws, (tx) => step(tx, ws, skuId, 'photos', 'active'));
  // The hero product the merchant tapped (a crop of a multi-product photo, plan 03 P2) leads.
  let photoIds = (await withTenant(ws, (tx) => tx`select id from assets where sku_id = ${skuId} and kind = 'product_photo' and deleted_at is null
                                                   order by (origin->>'heroCrop') is null, created_at`)).map((r) => r.id as string);
  if (photoIds.length < 3 && extracted?.images.length) {
    for (const url of extracted.images.slice(0, 3 - photoIds.length)) {
      const bytes = await fetchImage(url);
      if (!bytes) continue;
      try {
        const { validateMedia } = await import('./uploads');
        const v = await validateMedia(bytes);
        const a = await withTenant(ws, (tx) => saveAsset(tx, ws, { bytes: v.bytes, mime: v.mime, kind: 'product_photo', skuId, source: 'import', origin: { url } }));
        photoIds.push(a.id);
      } catch {
        /* skip unusable image */
      }
    }
  }
  if (!photoIds.length) {
    // The entered URL stays on the SKU; the merchant adds photos to this same product (addProductPhotos) and
    // the analysis resumes — no restart (§13, plan 03 P2 edge cases).
    await withTenant(ws, async (tx) => {
      await step(tx, ws, skuId, 'photos', 'failed', 'Add one clear photo of the front of your product.');
      await tx`update progress_steps set status = 'skipped' where subject_id = ${skuId} and status = 'pending'`;
      await tx`update skus set status = 'needs_input' where id = ${skuId}`;
      await transition(tx, ctx, projectId, 'NEEDS_USER_ACTION', { reason: NEEDS_PHOTO_COPY, detail: 'needs_photo' });
    });
    return { status: 'needs_input', reason: 'needs_photo' };
  }
  await withTenant(ws, (tx) => step(tx, ws, skuId, 'photos', 'done', `${photoIds.length} photo${photoIds.length > 1 ? 's' : ''}`));

  // 2a. The cut-out on our paper within seconds of upload (plan 04 L3): deterministic keying of the leading photo,
  //     no model spend. Shown while the analysis runs; the fingerprint reuses it when that photo is usable (step 6).
  let early = state.earlyCutout ?? null;
  if (!early || early.from !== photoIds[0]) {
    try {
      const lead = await withTenant(ws, (tx) => assetBytes(tx, photoIds[0]!));
      const keyed = await cutout(lead);
      early = await withTenant(ws, async (tx) => {
        const c = await saveAsset(tx, ws, {
          bytes: keyed.png,
          mime: 'image/png',
          kind: 'cutout',
          skuId,
          source: 'generated',
          lineage: { from: photoIds[0], keyed: keyed.keyed, technique: keyed.technique, coverage: Math.round(keyed.coverage * 1000) / 1000, spread: Math.round(keyed.spread * 1000) / 1000, preview: true },
        });
        const next = { assetId: c.id, from: photoIds[0]! };
        await tx`update skus set analysis = coalesce(analysis, '{}'::jsonb) || ${tx.json({ earlyCutout: next } as never)} where id = ${skuId}`;
        return next;
      });
    } catch {
      early = null; // an image keying can't read still goes to the analyst; the fingerprint step tries again
    }
  }

  // 3. Scope checks before any model spend — on the advertised product's own fields only, never the whole page
  //    (a serum page whose store menu lists "Sunscreen" is still a serum). Photo-only uploads are checked on
  //    what the label says, after extraction.
  const scopeText = extracted ? productScopeText(extracted) : '';
  // Imported page text is data, never instructions (§48); an injection attempt is still recorded for trust & safety.
  if (extracted) await withTenant(ws, (tx) => notePromptInjection(tx, { workspaceId: ws, source: 'product_page', text: `${scopeText}\n${extracted.rawText}`, subject: { type: 'sku', id: skuId } }));
  const excluded = excludedProductReason(scopeText);
  const other = scopeText.trim() ? nonSkincareCategory(scopeText) : null;
  if (excluded || other) {
    const reason = excluded ?? `We’re built for skincare. This looks like ${other}.`;
    await withTenant(ws, async (tx) => {
      await tx`update skus set status = 'rejected', reject_reason = ${reason} where id = ${skuId}`;
      await recordAbuseSignal(tx, { kind: 'prohibited_upload', key: allowKey.ws(ws)!, workspaceId: ws, detail: { skuId, stage: 'page', reason } });
      await step(tx, ws, skuId, 'identify', 'failed', reason);
      await transition(tx, ctx, projectId, 'BLOCKED_COMPLIANCE', { reason });
      await recordFunnel('SKU_REJECTED', { workspaceId: ws, props: { reason } }, tx);
    });
    return { status: 'rejected', reason };
  }

  // A resume after the merchant tapped the hero product reuses the analyst's reading made before they were asked
  // (it is paid for): only the concepts are left to authorise, so choosing never costs a second extraction.
  const held = state.heroSelected && state.heldExtraction ? state.heldExtraction : null;

  // 4. Free preview authorization (extraction + concepts ≤ $0.20, standard §5). A retried analysis (the job's own
  //    retry, or the merchant's "Try again") takes over the settled attempt's key as a new attempt; the per-SKU
  //    free-preview cap still bounds all attempts together. While an attempt is in flight, a duplicate delivery
  //    stands down (CONFLICT) rather than failing or double-spending.
  let auth: Awaited<ReturnType<typeof authorize>>;
  try {
    auth = await withTenant(ws, async (tx) =>
      authorizeOrTakeOver(
        tx,
        ctx,
        {
          purpose: 'free_preview',
          skuId,
          projectId,
          lines: await routedLines(tx, ws, [
            ...(held ? [] : [{ task: 'extract.product_facts', kind: 'llm' as const, inputTokens: 14_000, outputTokens: 2_000 }]),
            // Alone, the concepts line carries the call's full output budget (as a "Try 3 more" batch does).
            { task: 'creative_director.concepts', kind: 'llm', inputTokens: 6_000, outputTokens: held ? CONCEPTS_MAX_TOKENS : 3_500 },
          ]),
          idempotencyKey: `preview:${skuId}`,
        },
        ANALYSIS_STALE_MINUTES,
      ),
    );
  } catch (e) {
    if (e instanceof DomainError && e.code === 'CONFLICT') return { status: 'skipped', reason: 'duplicate delivery' };
    throw e;
  }

  try {
    // 5. Vision + text extraction.
    await withTenant(ws, (tx) => step(tx, ws, skuId, 'identify', 'active'));
    const photos = await withTenant(ws, async (tx) => Promise.all(photoIds.slice(0, 3).map((id) => assetBytes(tx, id))));
    const ext = held
      ? // The held reading's regions and views were of the photo that showed several products, not of the crop.
        { data: { ...held.data, labelBox: null, closureBox: null, photoViews: [{ index: 0, view: 'front' as const }], imageReview: [], multipleProductsVisible: false }, jobId: held.jobId }
      : await extractProduct();
    async function extractProduct() {
      const images = await Promise.all(photos.map(async (b) => ({ type: 'image' as const, mediaType: 'image/jpeg' as const, base64: await toJpegBase64(b) })));
      return llmJson({
        ctx,
        token: auth.token,
        task: 'extract.product_facts',
        subject: { type: 'sku', id: skuId },
        inputRefs: { skuId, projectId, photoAssetIds: photoIds.slice(0, 3), productPage: !!extracted },
        template: 'extract-product',
        content: [
          ...images,
          { type: 'untrusted', sourceId: 'product_page', text: extracted ? JSON.stringify({ name: extracted.name, description: extracted.description, ingredients: extracted.ingredients, size: extracted.sizeText, price: extracted.priceMicros ? extracted.priceMicros / 1e6 : null }).slice(0, 12000) : 'No product page; photos only.' },
        ],
        schema: ProductExtraction,
        mock: () => mockExtraction({ name: extracted?.name, description: extracted?.description, text: extracted?.rawText ?? '', ingredients: extracted?.ingredients, sizeText: extracted?.sizeText, photoCount: photos.length }),
        effort: 'medium',
        maxTokens: 2000,
      });
    }
    const x = ext.data;
    // §1: sunscreen/SPF and OTC drug products are out of scope — also when only the label shows it.
    const labelExcluded =
      x.category === 'drug_or_sunscreen'
        ? (excludedProductReason(extractionScopeText(x)) ?? 'Sunscreen, SPF and OTC drug products (like acne treatments) are outside what we make ads for.')
        : excludedProductReason(extractionScopeText(x));
    if (x.category === 'not_skincare' || labelExcluded) {
      const reason = labelExcluded ?? 'We’re built for skincare. This product doesn’t look like skincare.';
      await withTenant(ws, async (tx) => {
        await tx`update skus set status = 'rejected', reject_reason = ${reason} where id = ${skuId}`;
        await recordAbuseSignal(tx, { kind: 'prohibited_upload', key: allowKey.ws(ws)!, workspaceId: ws, detail: { skuId, stage: 'label', reason } });
        await step(tx, ws, skuId, 'identify', 'failed', reason);
        await transition(tx, ctx, projectId, 'BLOCKED_COMPLIANCE', { reason });
        await settle(tx, ctx, auth.authorizationId, 'consumed');
        // Plan 03 P2 events: every rejection — out of scope by label, or not skincare by the analyst — is SKU_REJECTED.
        await recordFunnel('SKU_REJECTED', { workspaceId: ws, props: { reason, stage: 'label', category: labelExcluded ? 'drug_or_sunscreen' : 'not_skincare' } }, tx);
      });
      return { status: 'rejected', reason };
    }
    // Before/after photos and photos that may show minors wait for compliance review (plan 05 §14, standard §48):
    // the analyst's look plus the photo's own name/source. They never become fingerprint references or cut-outs.
    const usable = await holdFlaggedPhotos(ws, photoIds.slice(0, 3), x.imageReview ?? []);
    if (!usable.length) {
      await withTenant(ws, async (tx) => {
        await tx`update progress_steps set status = 'failed', detail = ${PHOTOS_IN_REVIEW} where subject_id = ${skuId} and status = 'active'`;
        // The merchant can add a plain photo and try again (retryAnalysis) without waiting for our review.
        await tx`update skus set status = 'needs_input' where id = ${skuId}`;
        await transition(tx, ctx, projectId, 'NEEDS_USER_ACTION', { reason: PHOTOS_IN_REVIEW, detail: 'photos_in_review' });
        await settle(tx, ctx, auth.authorizationId, 'consumed');
      });
      return { status: 'needs_input', reason: 'photos_in_review' };
    }
    await withTenant(ws, async (tx) => {
      await recordFacts(tx, ctx, skuId, extractionFacts(x, extracted, sku.source_url as string | null, ext.jobId, photoIds.slice(0, 3)));
      const name = extracted?.name ?? x.name;
      // A photo-only product that matches one already catalogued (same name and size): offered as a merge on the
      // confirmation screen (§42 "Duplicate import"), without stopping the free preview already paid for.
      const possibleDuplicate = !extracted && !state.duplicate?.resolved ? await findDuplicateSku(tx, skuId, { name: x.name, size: x.sizeText }) : null;
      await tx`update skus set name = ${name}, category = ${x.category}, fidelity_confidence = ${x.assetQualityConfidence},
                 analysis = coalesce(analysis, '{}'::jsonb) || ${tx.json({ missingEvidence: x.missingEvidence, suggestedViews: x.suggestedViews, multipleProductsVisible: x.multipleProductsVisible, ...(possibleDuplicate ? { duplicate: possibleDuplicate } : {}) } as never)}
               where id = ${skuId}`;
      await step(tx, ws, skuId, 'identify', 'done', `${name}${x.sizeText ? ` · ${x.sizeText}` : ''}`);
      await step(tx, ws, skuId, 'claims', 'active');
      // One claim per meaning (§17): the analyst's canonical meaning joins the page's and the label's phrasings.
      for (const c of x.claimsFound) await proposeClaim(tx, ctx, skuId, { wording: c.wording, meaning: c.canonicalMeaning ?? null, origin: 'extracted', sourceText: c.sourceQuote });
      // The brand's brand-wide claims (Brand Brain, §16) join this product's vault, for approval per product.
      const brand = await brandBrainFor(tx, skuId);
      if (brand?.brain.claims.length) await proposeBrandClaims(tx, ctx, brand.id, brand.brain.claims, [skuId]);
      const [cc] = await tx`select count(*) filter (where status in ('BLOCKED','RESTRICTED'))::int as risky, count(*)::int as n from claims where sku_id = ${skuId}`;
      await step(tx, ws, skuId, 'claims', 'done', cc!.n ? `${cc!.n} claim${cc!.n > 1 ? 's' : ''} found${cc!.risky ? ` · ${cc!.risky} we won’t use` : ''}` : 'No claims found on the page');
    });

    // 6a. Several products in the photo (plan 03 P2 edge case, §42): the merchant taps the hero product before
    //     anything is keyed or drawn from it; the analysis resumes from their crop (selectHeroProduct).
    if (x.multipleProductsVisible && !(sku.analysis as { heroSelected?: boolean } | null)?.heroSelected) {
      await withTenant(ws, async (tx) => {
        await step(tx, ws, skuId, 'fingerprint', 'failed', SELECT_PRODUCT_COPY);
        await tx`update progress_steps set status = 'skipped' where subject_id = ${skuId} and status = 'pending'`;
        await tx`update skus set status = 'needs_input', analysis = coalesce(analysis, '{}'::jsonb) || ${tx.json({ selectPhotoId: usable[0], heldExtraction: { data: x, jobId: ext.jobId } } as never)} where id = ${skuId}`;
        await transition(tx, ctx, projectId, 'NEEDS_USER_ACTION', { reason: SELECT_PRODUCT_COPY, detail: 'select_product' });
        await settle(tx, ctx, auth.authorizationId, 'consumed');
      });
      return { status: 'needs_input', reason: 'select_product' };
    }

    // 6. Visual Fingerprint + cut-out (deterministic keying; a photo keying can't separate gets one background-removal
    //    try when the storyboard first needs the cut-out — see cutout.ts).
    await withTenant(ws, (tx) => step(tx, ws, skuId, 'fingerprint', 'active'));
    const cutFrom = photoIds.indexOf(usable[0]!);
    // The cut-out shown since upload is the fingerprint's when it was keyed from the photo the fingerprint leads with.
    const reuse = early && early.from === usable[0] ? await withTenant(ws, async (tx) => {
      const [a] = await tx`select lineage from assets where id = ${early!.assetId} and sku_id = ${skuId} and deleted_at is null`;
      return a ? { assetId: early!.assetId, png: await assetBytes(tx, early!.assetId), lineage: a.lineage as { keyed?: boolean; technique?: string } } : null;
    }) : null;
    const cut = reuse ? null : await cutout(photos[cutFrom]!);
    const cutPng = reuse?.png ?? cut!.png;
    const keyedCut = reuse ? reuse.lineage.keyed !== false : cut!.keyed;
    const technique = reuse ? (reuse.lineage.technique ?? null) : cut!.technique;
    const colors = await dominantColors(cutPng);
    // §16 geometry: the analyst's silhouette and proportions, and the keyed cut-out's measured bounding box.
    const measured = keyedCut ? await measuredGeometry(cutPng) : null;
    // §16 label crop and critical regions, from the first photo (the one the boxes were given for) when usable.
    const first = usable.includes(photoIds[0]!) ? photoIds[0]! : null;
    const labelCrop = first && x.labelBox ? await cropRegion(photos[0]!, x.labelBox) : null;
    await withTenant(ws, async (tx) => {
      let cutoutId = reuse?.assetId ?? null;
      if (!cutoutId) {
        const c = await saveAsset(tx, ws, {
          bytes: cut!.png,
          mime: 'image/png',
          kind: 'cutout',
          skuId,
          source: 'generated',
          lineage: { from: usable[0], keyed: cut!.keyed, technique: cut!.technique, coverage: Math.round(cut!.coverage * 1000) / 1000, spread: Math.round(cut!.spread * 1000) / 1000 },
        });
        cutoutId = c.id;
        // The preview cut-out came from a photo the fingerprint doesn't use (held for review, or not the hero): gone.
        if (early) await tx`update assets set deleted_at = now() where id = ${early.assetId} and sku_id = ${skuId} and deleted_at is null`;
      }
      const crop = labelCrop
        ? await saveAsset(tx, ws, { bytes: labelCrop.png, mime: 'image/png', kind: 'label_crop', skuId, source: 'generated', lineage: { from: first, box: x.labelBox, providerJobId: ext.jobId } })
        : null;
      const references = [...usable, ...(await usableAssetIds(tx, photoIds.slice(3)))];
      const views = Object.fromEntries(
        (x.photoViews ?? []).map((pv) => [photoIds[pv.index], pv.view] as const).filter(([id]) => !!id && references.includes(id!)),
      ) as Record<string, PhotoView>;
      const regions: CriticalRegion[] = [
        ...(first && x.labelBox ? [{ kind: 'label' as const, assetId: first, box: x.labelBox, cropAssetId: crop?.id ?? null }] : []),
        ...(first && x.closureBox ? [{ kind: 'closure' as const, assetId: first, box: x.closureBox }] : []),
      ];
      const v = await versionFingerprint(
        tx,
        ctx,
        skuId,
        {
          reference_asset_ids: references,
          cutout_asset_id: cutoutId,
          label_text: x.labelText,
          brand_text: x.brand,
          package_type: x.packaging.type,
          closure: x.packaging.closure,
          dominant_colors: colors,
          liquid_color: x.liquidColor?.trim() || null,
          transparency: x.packaging.transparent ? 'transparent' : 'opaque',
          critical_regions: regions,
          thresholds: { ...DEFAULT_FIDELITY_THRESHOLDS, labelMustMatch: !!x.labelText },
          views,
          approved_view_ids: [],
          label_crop_asset_id: crop?.id ?? null,
          geometry: { ...(x.geometry ? { silhouette: x.geometry.silhouette, aspectRatio: x.geometry.aspectRatio } : {}), ...(measured ? { widthPx: measured.widthPx, heightPx: measured.heightPx, measuredAspectRatio: measured.aspectRatio } : {}) },
        },
        { reason: 'analysis', payload: { keyed: keyedCut, technique }, refs: { providerJobId: ext.jobId } },
      );
      void v;
      await step(tx, ws, skuId, 'fingerprint', 'done', `${x.packaging.type.replace('_', ' ')}${x.packaging.closure ? ` · ${x.packaging.closure}` : ''}`);
      await tx`update skus set status = 'active', analysis = coalesce(analysis, '{}'::jsonb) - 'heldExtraction' where id = ${skuId}`;
      // A subscriber's new SKU gets its first recommended experiments now (standard §9 "Day 1-2"), not on the
      // next Monday's weekly run.
      // Only a SKU the weekly run covers (its first WEEKLY_RECOMMENDATION_SKUS active products): a store import of
      // hundreds of products doesn't start hundreds of paid recommendation runs.
      const [sub] = await tx`select 1 from workspaces w where w.id = ${ws} and w.state = 'ACTIVE_PAID' and w.plan_code is not null
                               and (select count(*) from skus o where o.workspace_id = w.id and o.status = 'active' and o.id <> ${skuId}
                                      and o.catalogue_no < (select catalogue_no from skus where id = ${skuId})) < ${WEEKLY_RECOMMENDATION_SKUS}`;
      if (sub) {
        const week = weekOf();
        await enqueue(tx, ws, Queues.weeklyRecommendations, { week, skuId }, { singletonKey: `recs:${ws}:${skuId}:${week}` });
      }
      await transition(tx, ctx, projectId, 'PRODUCT_ANALYZED');
      await transition(tx, ctx, projectId, 'BRIEF_READY');
      await emit(tx, ctx, 'PRODUCT_IMPORTED', { type: 'sku', id: skuId }, { source: extracted?.source ?? 'photos' });
      await recordFunnel('SKU_VALIDATED', { workspaceId: ws }, tx);
      // Plan 03 P3 "PRODUCT_ANALYZED {duration}": from the product's upload to its analysed Product Brain.
      await recordFunnel('PRODUCT_ANALYZED', { workspaceId: ws, props: { durationMs: Math.max(0, Date.now() - new Date(sku.created_at as string).getTime()) } }, tx);
    });

    // 7. Concepts (same free-preview authorization).
    await withTenant(ws, (tx) => step(tx, ws, skuId, 'concepts', 'active'));
    await generateConcepts({ ctx, token: auth.token, skuId, projectId, batch: 1 });
    await withTenant(ws, async (tx) => {
      await transition(tx, ctx, projectId, 'CONCEPTS_READY');
      await step(tx, ws, skuId, 'concepts', 'done', 'Three test ideas ready');
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      await recordFunnel('CONCEPTS_READY', { workspaceId: ws }, tx);
    });
    return { status: 'ready' };
  } catch (e) {
    await withTenant(ws, async (tx) => {
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      await tx`update progress_steps set status = 'failed', detail = 'Something went wrong on our side. Retrying…', completed_at = now()
               where subject_id = ${skuId} and status = 'active'`;
    });
    throw e;
  }
}

/** Customer copy when the photo shows several products (plan 03 P2 "tap-to-select the hero product"). */
export const SELECT_PRODUCT_COPY = 'Your photo shows more than one product. Tap the one this ad is for.';
/** Customer copy when the link is a collection or home page (plan 03 P2 "Which product?"). */
export const CHOOSE_PRODUCT_COPY = 'That link shows several products. Which one is this ad for?';

/** What the analysis keeps on the SKU between runs (skus.analysis). */
interface AnalysisState {
  heroSelected?: boolean;
  selectPhotoId?: string;
  productChoices?: { name: string; url: string }[];
  earlyCutout?: { assetId: string; from: string } | null;
  /** The analyst's reading while the merchant picks the hero product (reused on resume, never paid twice). */
  heldExtraction?: { data: ProductExtraction; jobId: string | null };
  duplicate?: DuplicateMatch & { resolved?: 'kept' | 'merged' };
}

/** A product already in the catalogue that this import looks like (§42 "Duplicate import"). */
export interface DuplicateMatch {
  skuId: string;
  catalogueNo: number;
  name: string;
  /** What matched: the store's product id, the barcode, the product link, or the name and size. */
  reason: 'store_product' | 'barcode' | 'link' | 'name_size';
}

export const duplicateCopy = (m: Pick<DuplicateMatch, 'catalogueNo' | 'name'>) =>
  `This looks like No. ${String(m.catalogueNo).padStart(3, '0')} (${m.name}), already in your catalogue. Update that one, or add this as a new product?`;

/** A product link without what doesn't name the product: query, fragment, trailing slash, "www.", collection path. */
export function normalizedProductUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/collections\/[^/]+(?=\/products\/)/, '').replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    return null;
  }
}

/**
 * An earlier product in this catalogue that is the same product (§42 "Detect source/product match"): the same
 * store product, barcode (GTIN), product link, or name and size. Only products that finished or are waiting in
 * their own analysis and were catalogued before this one — two imports in flight never flag each other. Runs in
 * the tenant's transaction (RLS scopes it to the workspace).
 */
export async function findDuplicateSku(
  tx: Tx,
  skuId: string,
  probe: { url?: string | null; shopifyProductId?: string | null; gtin?: string | null; name?: string | null; size?: string | null },
): Promise<DuplicateMatch | null> {
  const others = await tx`select o.id, o.catalogue_no, o.name, o.source_url, o.shopify_product_id from skus o, skus me
                          where me.id = ${skuId} and o.workspace_id = me.workspace_id and o.id <> me.id and o.catalogue_no < me.catalogue_no
                            and o.status in ('active', 'out_of_stock', 'needs_input')
                          order by o.catalogue_no`;
  if (!others.length) return null;
  const as = (o: Record<string, unknown>, reason: DuplicateMatch['reason']): DuplicateMatch => ({ skuId: o.id as string, catalogueNo: Number(o.catalogue_no), name: o.name as string, reason });
  if (probe.shopifyProductId) {
    const o = others.find((x) => x.shopify_product_id === probe.shopifyProductId);
    if (o) return as(o, 'store_product');
  }
  const ids = others.map((o) => o.id as string);
  if (probe.gtin?.trim()) {
    const [g] = await tx`select sku_id from product_facts where normalized_key = 'gtin' and status <> 'SUPERSEDED' and value_text = ${probe.gtin.trim()}
                         and sku_id = any(${ids}::uuid[]) limit 1`;
    const o = g && others.find((x) => x.id === g.sku_id);
    if (o) return as(o, 'barcode');
  }
  const url = normalizedProductUrl(probe.url);
  if (url) {
    const o = others.find((x) => normalizedProductUrl(x.source_url as string | null) === url);
    if (o) return as(o, 'link');
  }
  if (probe.name?.trim()) {
    const sizes = await tx`select distinct on (sku_id) sku_id, value_text from product_facts where normalized_key = 'size' and status <> 'SUPERSEDED'
                           and sku_id = any(${ids}::uuid[]) order by sku_id, (state = 'DECIDED') desc, observed_at desc`;
    const sizeOf = new Map(sizes.map((s) => [s.sku_id as string, s.value_text as string | null]));
    const exact = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9%.]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9%.]+/g, ' ').trim();
    for (const o of others) {
      const theirs = sizeOf.get(o.id as string) ?? null;
      const size = probe.size?.trim() || null;
      const sameName = size && theirs ? sameValue('name', { valueText: o.name as string }, { valueText: probe.name }) : exact(o.name as string, probe.name);
      if (!sameName) continue;
      // Same name and the same size (any unit), or the same exact name when neither states a size.
      if ((size && theirs && sameValue('size', { valueText: theirs }, { valueText: size })) || (!size && !theirs)) return as(o, 'name_size');
    }
  }
  return null;
}

/** Stop the analysis for the merchant's answer: the step says why, the rest are skipped, the project waits. */
async function waitForMerchant(
  ctx: TenantContext,
  skuId: string,
  projectId: string,
  o: { step: string; copy: string; detail: string; analysis?: Record<string, unknown>; authorizationId?: string },
) {
  const ws = ctx.workspaceId;
  await withTenant(ws, async (tx) => {
    await step(tx, ws, skuId, o.step, 'failed', o.copy);
    await tx`update progress_steps set status = 'skipped' where subject_id = ${skuId} and status in ('pending', 'active')`;
    await tx`update skus set status = 'needs_input', analysis = coalesce(analysis, '{}'::jsonb) || ${tx.json((o.analysis ?? {}) as never)} where id = ${skuId}`;
    await transition(tx, ctx, projectId, 'NEEDS_USER_ACTION', { reason: o.copy, detail: o.detail });
    if (o.authorizationId) await settle(tx, ctx, o.authorizationId, 'consumed');
  });
}

/**
 * "Which product?" (plan 03 P2): the merchant picks one of the products the collection page listed. Only a link
 * from that list (same site) is accepted; it becomes the product's link and the analysis reads it — the SKU,
 * project and anything entered are kept.
 */
export async function chooseProduct(tx: Tx, ctx: TenantContext, projectId: string, url: string): Promise<{ skuId: string }> {
  assertCan(ctx, 'sku.edit');
  const [p] = await tx`select p.state, p.sku_id, s.status, s.analysis, s.source_url from projects p join skus s on s.id = p.sku_id where p.id = ${projectId} for update of p, s`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  const choices = ((p.analysis as AnalysisState | null)?.productChoices ?? []).map((c) => c.url);
  if (p.status !== 'needs_input' || p.state !== 'NEEDS_USER_ACTION' || !choices.length) throw new DomainError('CONFLICT', 'There’s no product to choose right now.');
  if (!choices.includes(url)) throw new DomainError('INVALID', 'Choose one of the products from your page.');
  let sameSite = false;
  try {
    sameSite = new URL(url).origin === new URL(p.source_url as string).origin;
  } catch {
    sameSite = false;
  }
  if (!sameSite) throw new DomainError('INVALID', 'Choose one of the products from your page.');
  await tx`update skus set source_url = ${url}, analysis = (analysis - 'productChoices') || ${tx.json({ chosenFrom: p.source_url as string } as never)} where id = ${p.sku_id}`;
  await retryAnalysis(tx, ctx, projectId);
  return { skuId: p.sku_id as string };
}

/**
 * The merchant's answer to "This looks like No. 003" (§42 "offer merge rather than creating competing Product
 * Brains"): `merge` folds this import into the existing product (mergeSkus) and ends this preview; `keep` adds it
 * as a new product and the analysis carries on.
 */
export async function resolveDuplicate(tx: Tx, ctx: TenantContext, projectId: string, choice: 'merge' | 'keep'): Promise<{ skuId: string; mergedInto?: string }> {
  assertCan(ctx, 'sku.edit');
  const [p] = await tx`select p.state, p.sku_id, s.status, s.analysis from projects p join skus s on s.id = p.sku_id where p.id = ${projectId} for update of p, s`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  const dup = (p.analysis as AnalysisState | null)?.duplicate;
  if (!dup || dup.resolved) throw new DomainError('CONFLICT', 'There’s nothing to decide here any more.');
  const skuId = p.sku_id as string;
  if (choice === 'keep') {
    await tx`update skus set analysis = analysis || ${tx.json({ duplicate: { ...dup, resolved: 'kept' } } as never)} where id = ${skuId}`;
    // Waiting on this answer (a link import): read on. A photo import already finished and just keeps its SKU.
    if (p.status === 'needs_input' && p.state === 'NEEDS_USER_ACTION') await retryAnalysis(tx, ctx, projectId);
    return { skuId };
  }
  await mergeSkus(tx, ctx, skuId, dup.skuId);
  return { skuId, mergedInto: dup.skuId };
}

/**
 * The merchant marks the hero product in a photo that shows several (plan 03 P2 edge case; §42). The box is in
 * fractions of the photo (0–1). The crop becomes this product's leading photo — validated and re-encoded like any
 * upload — and the analysis resumes from it (no restart of what the merchant entered).
 */
export async function selectHeroProduct(tx: Tx, ctx: TenantContext, projectId: string, box: { x: number; y: number; w: number; h: number }): Promise<{ skuId: string; assetId: string }> {
  assertCan(ctx, 'sku.edit');
  const [p] = await tx`select p.state, p.sku_id, s.status, s.analysis from projects p join skus s on s.id = p.sku_id where p.id = ${projectId} for update of p, s`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  const photoId = (p.analysis as { selectPhotoId?: string } | null)?.selectPhotoId;
  if (p.status !== 'needs_input' || p.state !== 'NEEDS_USER_ACTION' || !photoId) throw new DomainError('CONFLICT', 'There’s no product to pick right now.');
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x0 = clamp(box.x);
  const y0 = clamp(box.y);
  const x1 = clamp(box.x + box.w);
  const y1 = clamp(box.y + box.h);
  const { default: sharp } = await import('sharp');
  const src = await assetBytes(tx, photoId);
  const meta = await sharp(src).rotate().metadata();
  const W = meta.autoOrient?.width ?? meta.width ?? 0;
  const H = meta.autoOrient?.height ?? meta.height ?? 0;
  const region = { left: Math.round(x0 * W), top: Math.round(y0 * H), width: Math.round((x1 - x0) * W), height: Math.round((y1 - y0) * H) };
  if (region.width < 64 || region.height < 64) throw new DomainError('INVALID', 'Draw the box around the whole product.');
  const crop = await sharp(src).rotate().extract(region).jpeg({ quality: 92 }).toBuffer();
  const asset = await ingestBytes(tx, ctx, crop, 'product_photo', p.sku_id as string, { heroCrop: true, from: photoId, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  await tx`update skus set analysis = coalesce(analysis, '{}'::jsonb) || ${tx.json({ heroSelected: true } as never)} where id = ${p.sku_id}`;
  await retryAnalysis(tx, ctx, projectId);
  return { skuId: p.sku_id as string, assetId: asset.id };
}

export const PHOTOS_IN_REVIEW = 'Your photos need a quick check by our team (before/after or people in shot). Add a plain photo of the product to continue now.';
/** Customer copy when neither the page nor the upload gave us a product photo (the URL is kept). */
export const NEEDS_PHOTO_COPY = 'We couldn’t get product photos from that page. Add 1–3 photos of your product and we’ll carry on from here.';

/**
 * Hold the analysed photos the product analyst flagged (by position) or whose source names a before/after or a
 * child, and return the ones production may use, in order.
 */
async function holdFlaggedPhotos(ws: string, photoIds: string[], review: { index: number; beforeAfter: boolean; possibleMinor: boolean }[]): Promise<string[]> {
  return withTenant(ws, async (tx) => {
    const rows = await tx`select id, origin from assets where id = any(${photoIds}::uuid[])`;
    const items = photoIds.map((id, i) => {
      const seen = review.find((r) => r.index === i);
      const named = nameReviewFlags(JSON.stringify(rows.find((r) => r.id === id)?.origin ?? {}));
      const sources: MediaReviewFlags['sources'] = [];
      if (seen && (seen.beforeAfter || seen.possibleMinor)) sources.push('vision');
      if (named.beforeAfter || named.possibleMinor) sources.push('name');
      return { assetId: id, flags: { beforeAfter: !!seen?.beforeAfter || named.beforeAfter, possibleMinor: !!seen?.possibleMinor || named.possibleMinor, sources } };
    });
    await holdForReview(tx, items);
    return usableAssetIds(tx, photoIds);
  });
}

// ───────────── A failed analysis (plan 03 P3 edge cases) ─────────────

/** Facts a merchant is asked for when the analysis could not find them. */
export const ANALYSIS_KEY_FACTS = [
  { key: 'name', label: 'Product name' },
  { key: 'category', label: 'Category (e.g. serum, moisturiser)' },
  { key: 'size', label: 'Size (e.g. 30 ml)' },
  { key: 'ingredients', label: 'Ingredient list' },
] as const;

/** An analysis attempt with no result after this long is presumed dead and may be taken over by a retry. */
const ANALYSIS_STALE_MINUTES = 10;

/** Customer-facing copy for a failed analysis (project failure_reason, shown in the funnel). */
export const ANALYSIS_FAILED_COPY = 'We couldn’t finish reading this product. Here’s what we found — add what’s missing, or try again.';
const ANALYSIS_FAILED_STEP = 'We couldn’t finish this step. Nothing was charged.';
/** Project states of an analysis still under way (NEEDS_USER_ACTION already waits for the merchant). */
export const ANALYSIS_STATES: readonly ProjectState[] = ['PRODUCT_UPLOADED', 'PRODUCT_ANALYZED', 'BRIEF_READY'];

/** Key facts the SKU still lacks (any source), for the "show what we have and ask for the missing field" screen. */
export async function missingAnalysisFacts(tx: Tx, skuId: string): Promise<string[]> {
  const rows = await tx`select distinct normalized_key from product_facts where sku_id = ${skuId} and status <> 'SUPERSEDED'`;
  const have = new Set(rows.map((r) => r.normalized_key as string));
  return ANALYSIS_KEY_FACTS.filter((k) => !have.has(k.key) && !(k.key === 'ingredients' && have.has('key_ingredients'))).map((k) => k.key);
}

/**
 * The analysis will not finish (its job ran out of retries, hit a final error, or stalled): the SKU waits for the
 * merchant (needs_input) with what was found so far and the key facts still missing, the project asks for
 * action, and the progress steps show a final state instead of "Retrying…". Idempotent; a SKU that already
 * finished analysing, or was rejected, is left alone. Returns whether the analysis was failed now.
 */
export async function failAnalysis(ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, skuId: string, projectId: string, detail: string): Promise<boolean> {
  return withTenant(ctx.workspaceId, async (tx) => {
    const [p] = await tx`select p.state, s.status from projects p join skus s on s.id = p.sku_id
                         where p.id = ${projectId} and p.sku_id = ${skuId} for update of p, s`;
    // Only an analysis still under way can fail (the SKU turns active at the fingerprint step, before concepts).
    if (!p || !ANALYSIS_STATES.includes(p.state as ProjectState) || !['analyzing', 'active'].includes(p.status as string)) return false;
    const missing = await missingAnalysisFacts(tx, skuId);
    await tx`update skus set status = 'needs_input',
               analysis = analysis || ${tx.json({ failure: { at: new Date().toISOString(), detail: detail.slice(0, 300), missing } } as never)}
             where id = ${skuId}`;
    await transition(tx, ctx, projectId, 'NEEDS_USER_ACTION', { reason: ANALYSIS_FAILED_COPY, detail: detail.slice(0, 300) });
    await tx`update progress_steps set status = case when status = 'pending' then 'skipped' else 'failed' end,
               detail = case when status = 'pending' then detail else ${ANALYSIS_FAILED_STEP} end, completed_at = now()
             where subject_id = ${skuId} and (status in ('active','pending') or (status = 'failed' and detail like '%Retrying%'))`;
    return true;
  });
}

/**
 * "Try again" on a failed analysis: the SKU goes back to analysing, its steps restart and the analysis is queued
 * again (a new attempt under the same free-preview cap). A double click finds it already analysing.
 */
export async function retryAnalysis(tx: Tx, ctx: TenantContext, projectId: string): Promise<{ skuId: string }> {
  assertCan(ctx, 'sku.edit');
  const [p] = await tx`select p.state, p.sku_id, s.status from projects p join skus s on s.id = p.sku_id where p.id = ${projectId} for update of p, s`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  if (p.status !== 'needs_input' || p.state !== 'NEEDS_USER_ACTION') throw new DomainError('CONFLICT', p.status === 'analyzing' ? 'We’re already reading this product.' : 'There’s nothing to retry.');
  await tx`update skus set status = 'analyzing' where id = ${p.sku_id}`;
  await transition(tx, ctx, projectId, 'PRODUCT_UPLOADED', { detail: 'analysis retried' });
  await tx`update progress_steps set status = 'pending', detail = null, started_at = null, completed_at = null, expected_ms = null where subject_id = ${p.sku_id}`;
  await enqueue(tx, ctx.workspaceId, queueFor(Queues.analyzeProduct, ctx), { skuId: p.sku_id, projectId, actor: ctx.actor, retry: true }, { priority: priorityFor(ctx) });
  return { skuId: p.sku_id as string };
}

/** Photos a merchant can add in one go (the upload module's own limit). */
export const MAX_ADDED_PHOTOS = 6;
/** Project states in which extra reference views can still sharpen the fingerprint (before production). */
const REFERENCE_VIEW_STATES: readonly ProjectState[] = ['PRODUCT_ANALYZED', 'BRIEF_READY', 'CONCEPTS_READY', 'CONCEPT_SELECTED', 'STORYBOARD_READY'];

export interface AddedPhoto {
  bytes: Buffer;
  filename?: string | null;
}

/**
 * Add photos to an existing product (§13 "request images/details without forcing restart"; plan 03 P4 "Add a
 * side/back photo for sharper product accuracy"):
 *  - the analysis is waiting for photos (the URL failed, or every photo went to review): they become product
 *    photos of the same SKU — its URL and anything already found are kept — and the analysis resumes;
 *  - the product is already analysed: they become reference views and a new Visual Fingerprint version lists
 *    them (photos held for compliance review are stored but never referenced).
 * The state is checked under the project/SKU lock before any file is stored.
 */
export async function addProductPhotos(tx: Tx, ctx: TenantContext, projectId: string, files: AddedPhoto[]): Promise<{ skuId: string; mode: 'resumed' | 'reference'; added: number }> {
  assertCan(ctx, 'sku.edit');
  if (!files.length) throw new DomainError('INVALID', 'Add at least one photo.');
  if (files.length > MAX_ADDED_PHOTOS) throw new DomainError('INVALID', `Add up to ${MAX_ADDED_PHOTOS} photos at a time.`);
  const [p] = await tx`select p.state, p.sku_id, s.status from projects p join skus s on s.id = p.sku_id where p.id = ${projectId} for update of p, s`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  const skuId = p.sku_id as string;
  if (p.status === 'needs_input' && p.state === 'NEEDS_USER_ACTION') {
    for (const f of files) await ingestBytes(tx, ctx, f.bytes, 'product_photo', skuId, { filename: f.filename ?? null, addedAfter: 'analysis' });
    await retryAnalysis(tx, ctx, projectId);
    await emit(tx, ctx, 'UPLOAD_COMPLETED', { type: 'sku', id: skuId }, { method: 'photos', added: files.length, resumed: true });
    return { skuId, mode: 'resumed', added: files.length };
  }
  if (p.status !== 'active' || !REFERENCE_VIEW_STATES.includes(p.state as ProjectState)) {
    throw new DomainError('CONFLICT', p.status === 'analyzing' ? 'We’re still reading this product.' : 'Photos can’t be added to this ad any more.');
  }
  const ids: string[] = [];
  for (const f of files) ids.push((await ingestBytes(tx, ctx, f.bytes, 'reference_view', skuId, { filename: f.filename ?? null })).id);
  const usable = await usableAssetIds(tx, ids);
  const [fp] = await tx`select * from visual_fingerprints where sku_id = ${skuId} and active order by version desc limit 1 for update`;
  if (fp && usable.length) {
    const refs = [...new Set([...((fp.reference_asset_ids as string[]) ?? []), ...usable])];
    await versionFingerprint(tx, ctx, skuId, { reference_asset_ids: refs }, { reason: 'added_views', payload: { addedViews: usable.length } });
  }
  // The P4 prompt is shown until the merchant has added views.
  const [views] = await tx`select count(*)::int as n from assets where sku_id = ${skuId} and kind = 'reference_view' and deleted_at is null`;
  await tx`update skus set analysis = analysis || ${tx.json({ addedViews: views!.n as number } as never)} where id = ${skuId}`;
  return { skuId, mode: 'reference', added: ids.length };
}

/** Progress key for one requested concept batch (subject: the project). */
export const conceptStepKey = (batch: number) => `concepts.batch.${batch}`;
/** A request older than this with no result is treated as abandoned (crashed worker) and may be re-issued. */
const CONCEPT_REQUEST_STALE_MINUTES = 10;

/**
 * "Try 3 more" (plan 03 P5). Only records the request and enqueues it in the same transaction (§34: AI work is
 * asynchronous and resumable); the concepts are drafted by the `generate-concepts` job. Limited on provisional
 * workspaces to bound free COGS. A double-click or second tab gets the request already in flight.
 */
export async function requestConcepts(tx: Tx, ctx: TenantContext, projectId: string, opts: { goal?: CreativeGoal } = {}): Promise<{ batch: number; subjectId: string; replayed: boolean }> {
  assertCan(ctx, 'sku.edit');
  const [p] = await tx`select sku_id, state, goal from projects where id = ${projectId} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  if (!['CONCEPTS_READY', 'CONCEPT_SELECTED', 'STORYBOARD_READY'].includes(p.state as string))
    throw new DomainError('CONFLICT', p.state === 'STORYBOARD_APPROVED' || isTerminal(p.state as ProjectState) ? 'This ad is already in production.' : 'Your first ideas are still being drafted.');
  const [pending] = await tx`select step_key from progress_steps where subject_id = ${projectId} and step_key like 'concepts.batch.%'
                             and status in ('pending','active') and started_at > now() - make_interval(mins => ${CONCEPT_REQUEST_STALE_MINUTES})
                             order by started_at desc limit 1`;
  if (pending) {
    if (opts.goal && opts.goal !== p.goal) throw new DomainError('CONFLICT', 'We’re still drafting your last ideas. Change the goal once they’re ready.');
    return { batch: Number(String(pending.step_key).split('.').pop()), subjectId: projectId, replayed: true };
  }
  const [b] = await tx`select coalesce(max(batch), 0) as b from concepts where project_id = ${projectId}`;
  const batch = Number(b!.b) + 1;
  if (ctx.workspaceState === 'PROVISIONAL' && batch > 1 + PROVISIONAL.MAX_CONCEPT_REGENERATIONS)
    throw new DomainError('PAYMENT_REQUIRED', 'Save your work to see more ideas.', { needsAccount: true });
  if (ctx.workspaceState !== 'PROVISIONAL' && isFreeTier(ctx) && batch > FREE_EXPLORATION.CONCEPT_BATCHES_PER_SKU)
    throw new DomainError('PAYMENT_REQUIRED', 'Produce this one to keep exploring — you’ve seen all the free ideas for this product.', { freeLimit: 'concept_batches' });
  // §8: a new goal applies to this batch and the ones after it (the worker reads it from the project).
  if (opts.goal && opts.goal !== p.goal) {
    await tx`update projects set goal = ${opts.goal} where id = ${projectId} and workspace_id = ${ctx.workspaceId}`;
    await emit(tx, ctx, 'PROJECT_GOAL_CHANGED', { type: 'project', id: projectId }, { from: p.goal as string, to: opts.goal, batch });
  }
  await tx`insert into progress_steps (workspace_id, subject_id, step_key, label, status, started_at, position)
           values (${ctx.workspaceId}, ${projectId}, ${conceptStepKey(batch)}, 'Drafting three more ideas', 'pending', now(), 0)
           on conflict (workspace_id, subject_id, step_key) do update set status = 'pending', detail = null, started_at = now(), completed_at = null`;
  await enqueue(tx, ctx.workspaceId, queueFor(Queues.generateConcepts, ctx), { projectId, batch, actor: ctx.actor },
    { singletonKey: `concepts:${projectId}:${batch}`, priority: priorityFor(ctx) });
  return { batch, subjectId: projectId, replayed: false };
}

/**
 * Worker (`generate-concepts`): draft one requested batch under its own Cost Governor authorization, keyed
 * `concepts:<project>:<batch>`. Idempotent: an existing batch is never redrafted, a live duplicate delivery is
 * skipped, and a reservation stranded by a crashed attempt is taken over.
 */
export async function generateConceptBatch(ctx: TenantContext, projectId: string, batch: number): Promise<'done' | 'skipped'> {
  const ws = ctx.workspaceId;
  const key = conceptStepKey(batch);
  const info = await withTenant(ws, async (tx) => {
    const [p] = await tx`select sku_id from projects where id = ${projectId}`;
    if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
    const [done] = await tx`select 1 from concepts where project_id = ${projectId} and batch = ${batch} limit 1`;
    return { skuId: p.sku_id as string, done: !!done };
  });
  if (info.done) {
    await withTenant(ws, (tx) => step(tx, ws, projectId, key, 'done', 'Three more ideas ready'));
    return 'done';
  }
  let auth: Awaited<ReturnType<typeof authorize>>;
  try {
    auth = await withTenant(ws, async (tx) => {
      // Priced on the model the concepts task routes to for this workspace, with the call's full output budget.
      const a = await authorizeOrTakeOver(
        tx,
        ctx,
        {
          purpose: ctx.workspaceState === 'PROVISIONAL' ? 'free_preview' : 'storyboard',
          skuId: info.skuId,
          projectId,
          lines: await routedLines(tx, ws, [{ task: 'creative_director.concepts', kind: 'llm', inputTokens: 6_000, outputTokens: CONCEPTS_MAX_TOKENS }]),
          idempotencyKey: `concepts:${projectId}:${batch}`,
        },
        CONCEPT_REQUEST_STALE_MINUTES,
      );
      await step(tx, ws, projectId, key, 'active');
      return a;
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'CONFLICT') return 'skipped'; // a live duplicate delivery is drafting it
    await withTenant(ws, (tx) => step(tx, ws, projectId, key, 'failed', conceptFailure(e)));
    throw e;
  }
  try {
    await generateConcepts({ ctx, token: auth.token, skuId: info.skuId, projectId, batch });
    await withTenant(ws, async (tx) => {
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      await step(tx, ws, projectId, key, 'done', 'Three more ideas ready');
    });
    return 'done';
  } catch (e) {
    await withTenant(ws, async (tx) => {
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      await step(tx, ws, projectId, key, 'failed', conceptFailure(e));
    });
    throw e;
  }
}

function conceptFailure(e: unknown): string {
  if (e instanceof DomainError && (e.code === 'GATE_BLOCKED' || e.code === 'PAYMENT_REQUIRED' || e.code === 'UNAVAILABLE')) {
    return e.code === 'GATE_BLOCKED' && /ceiling/i.test(e.message) ? 'You’ve seen all the free ideas for this product. Save your work to see more.' : e.message;
  }
  return 'We couldn’t draft more ideas just now. Please try again.';
}
