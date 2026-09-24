import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, FREE_EXPLORATION, PROVISIONAL, newId, type ProjectState } from '@arkiv/shared';
import { allowKey, isAllowlisted } from './allowlist';
import { assetBytes, saveAsset } from './assets';
import { assertCan } from './authz';
import { proposeClaim } from './claims';
import { excludedProductReason, nonSkincareCategory } from './compliance';
import type { TenantContext } from './context';
import { authorize, authorizeOrTakeOver, settle } from './cost-governor';
import { CONCEPTS_MAX_TOKENS, generateConcepts } from './creative-director';
import { emit } from './events';
import { recordFunnel, uploadFailureCategory } from './funnel';
import { fetchImage, importProductUrl, type ExtractedProduct } from './ingest';
import { ProductExtraction } from './intel-schemas';
import { mockExtraction } from './mock-intel';
import { llmJson, routedLines } from './model-gateway';
import { enqueue, isFreeTier, priorityFor, queueFor, Queues } from './outbox';
import { planSteps, step } from './progress';
import { recordFacts, type FactInput } from './product-truth';
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
}

/** Create the SKU + preview project and enqueue analysis (transactional). */
export async function startPreview(tx: Tx, ctx: TenantContext, input: StartPreviewInput) {
  assertCan(ctx, 'sku.create');
  if (!input.url && !input.photoAssetIds?.length) throw new DomainError('INVALID', 'Add a product link or at least one photo.');
  // The SKU caps are counted under the workspace row lock (the same lock nextCatalogueNo takes), so parallel
  // submissions queue here and each sees the others' SKUs instead of all counting before any commits.
  if (ctx.workspaceState === 'PROVISIONAL' || isFreeTier(ctx)) await tx`select 1 from workspaces where id = ${ctx.workspaceId} for update`;
  if (ctx.workspaceState === 'PROVISIONAL') {
    const [n] = await tx`select count(*)::int as n from skus`;
    if (n!.n >= PROVISIONAL.MAX_SKUS) {
      // Staff-allowlisted evaluators (agencies, photographers) get a higher, still bounded, allowance (plan 05 §15).
      const allowed = n!.n < PROVISIONAL.ALLOWLISTED_MAX_SKUS && (await isAllowlisted(tx, [allowKey.ws(ctx.workspaceId), allowKey.ip(input.ip)]));
      if (!allowed) throw new DomainError('PAYMENT_REQUIRED', 'Save your work to add more products.', { needsAccount: true });
    }
  } else if (isFreeTier(ctx)) {
    // Signed in but not paying: a few new products a day (standard §5 bounded free preview COGS).
    const [n] = await tx`select count(*)::int as n from skus where created_at > now() - interval '24 hours'`;
    if (n!.n >= FREE_EXPLORATION.SKUS_PER_DAY) {
      throw new DomainError('PAYMENT_REQUIRED', `Free accounts can add ${FREE_EXPLORATION.SKUS_PER_DAY} products a day. Produce an ad from one of them, or come back tomorrow.`, { freeLimit: 'skus_per_day' });
    }
  }
  const skuId = newId();
  const projectId = newId();
  const no = await nextCatalogueNo(tx);
  const [brand] = await tx`select id from brands order by created_at limit 1`;
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

function factsFromStructured(p: ExtractedProduct, url: string | null): FactInput[] {
  const src = p.source === 'shopify' ? 'shopify' : p.source === 'json_ld' ? 'json_ld' : 'product_page';
  const f: FactInput[] = [];
  const add = (key: string, v: Partial<FactInput>) => f.push({ key, sourceType: src, sourceUrl: url, state: 'OBSERVED', ...v });
  if (p.name) add('name', { valueText: p.name });
  if (p.brand) add('brand', { valueText: p.brand });
  if (p.priceMicros) add('price', { valueNumber: p.priceMicros / 1_000_000, valueJson: { currency: p.currency ?? 'USD' } });
  if (p.compareAtMicros) add('compare_at_price', { valueNumber: p.compareAtMicros / 1_000_000 });
  if (p.sizeText) add('size', { valueText: p.sizeText });
  if (p.ingredients) add('ingredients', { valueText: p.ingredients.slice(0, 2000) });
  if (p.sku) add('sku_code', { valueText: p.sku });
  if (p.gtin) add('gtin', { valueText: p.gtin });
  if (p.inStock !== undefined) add('in_stock', { valueJson: p.inStock });
  if (p.variants?.length) add('variants', { valueJson: p.variants });
  if (p.description) add('description', { valueText: p.description.slice(0, 4000) });
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
export function extractionFacts(x: ProductExtraction, extracted: ExtractedProduct | null, url: string | null, jobId: string | null): FactInput[] {
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
      ? { key: 'key_ingredients', valueText: onPage.join(', '), sourceType: pageSrc, sourceUrl: url, state: 'OBSERVED', confidence: 0.8 }
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

  // 1. Structured import (preferred source of truth, §16).
  let extracted: ExtractedProduct | null = null;
  if (sku.source_url) {
    await withTenant(ws, (tx) => step(tx, ws, skuId, 'read_page', 'active'));
    try {
      extracted = await importProductUrl(sku.source_url as string);
      await withTenant(ws, async (tx) => {
        await recordFacts(tx, ctx, skuId, factsFromStructured(extracted!, sku.source_url as string));
        // §42: each size/shade keeps its own price, availability and image; a link to one variant chooses it.
        if (extracted!.variants?.length) {
          await recordVariants(tx, ctx, skuId, extracted!.source === 'shopify' ? 'shopify' : 'json_ld', extracted!.variants, extracted!.currency ?? null);
          if (extracted!.selectedVariantId) {
            await tx`update projects p set sku_variant_id = v.id from sku_variants v
                     where p.id = ${projectId} and v.sku_id = ${skuId} and v.external_id = ${extracted!.selectedVariantId} and v.workspace_id = p.workspace_id`;
          }
        }
        await step(tx, ws, skuId, 'read_page', 'done', extracted!.name ? `Found “${extracted!.name}”` : 'Page read');
        await tx`update skus set shopify_product_id = ${extracted!.shopifyProductId ?? null} where id = ${skuId}`;
      });
    } catch (e) {
      // Blocked/JS-only pages fall back to photos without losing the URL (§42, plan 03 P2).
      await withTenant(ws, async (tx) => {
        await step(tx, ws, skuId, 'read_page', 'failed', e instanceof DomainError ? e.message : 'We couldn’t read that page');
        await recordFunnel('URL_PARSE_FAILED', { workspaceId: ws, props: { reason: (e as Error).message, category: uploadFailureCategory(e) } }, tx);
      });
    }
  }

  // 2. Photos: uploaded first, then page images (downloaded into our own storage).
  await withTenant(ws, (tx) => step(tx, ws, skuId, 'photos', 'active'));
  let photoIds = (await withTenant(ws, (tx) => tx`select id from assets where sku_id = ${skuId} and kind = 'product_photo' and deleted_at is null order by created_at`)).map((r) => r.id as string);
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

  // 3. Scope checks before any model spend — on the advertised product's own fields only, never the whole page
  //    (a serum page whose store menu lists "Sunscreen" is still a serum). Photo-only uploads are checked on
  //    what the label says, after extraction.
  const scopeText = extracted ? productScopeText(extracted) : '';
  const excluded = excludedProductReason(scopeText);
  const other = scopeText.trim() ? nonSkincareCategory(scopeText) : null;
  if (excluded || other) {
    const reason = excluded ?? `We’re built for skincare. This looks like ${other}.`;
    await withTenant(ws, async (tx) => {
      await tx`update skus set status = 'rejected', reject_reason = ${reason} where id = ${skuId}`;
      await step(tx, ws, skuId, 'identify', 'failed', reason);
      await transition(tx, ctx, projectId, 'BLOCKED_COMPLIANCE', { reason });
      await recordFunnel('SKU_REJECTED', { workspaceId: ws, props: { reason } }, tx);
    });
    return { status: 'rejected', reason };
  }

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
            { task: 'extract.product_facts', kind: 'llm', inputTokens: 14_000, outputTokens: 2_000 },
            { task: 'creative_director.concepts', kind: 'llm', inputTokens: 6_000, outputTokens: 3_500 },
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
    const images = await Promise.all(photos.map(async (b) => ({ type: 'image' as const, mediaType: 'image/jpeg' as const, base64: await toJpegBase64(b) })));
    const ext = await llmJson({
      ctx,
      token: auth.token,
      task: 'extract.product_facts',
      subject: { type: 'sku', id: skuId },
      template: 'extract-product',
      content: [
        ...images,
        { type: 'untrusted', sourceId: 'product_page', text: extracted ? JSON.stringify({ name: extracted.name, description: extracted.description, ingredients: extracted.ingredients, size: extracted.sizeText, price: extracted.priceMicros ? extracted.priceMicros / 1e6 : null }).slice(0, 12000) : 'No product page; photos only.' },
      ],
      schema: ProductExtraction,
      mock: () => mockExtraction({ name: extracted?.name, description: extracted?.description, text: extracted?.rawText ?? '', ingredients: extracted?.ingredients, sizeText: extracted?.sizeText }),
      effort: 'medium',
      maxTokens: 2000,
    });
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
        await step(tx, ws, skuId, 'identify', 'failed', reason);
        await transition(tx, ctx, projectId, 'BLOCKED_COMPLIANCE', { reason });
        await settle(tx, ctx, auth.authorizationId, 'consumed');
        if (labelExcluded) await recordFunnel('SKU_REJECTED', { workspaceId: ws, props: { reason } }, tx);
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
      await recordFacts(tx, ctx, skuId, extractionFacts(x, extracted, sku.source_url as string | null, ext.jobId));
      const name = extracted?.name ?? x.name;
      await tx`update skus set name = ${name}, category = ${x.category}, fidelity_confidence = ${x.assetQualityConfidence},
                 analysis = ${tx.json({ missingEvidence: x.missingEvidence, suggestedViews: x.suggestedViews, multipleProductsVisible: x.multipleProductsVisible } as never)}
               where id = ${skuId}`;
      await step(tx, ws, skuId, 'identify', 'done', `${name}${x.sizeText ? ` · ${x.sizeText}` : ''}`);
      await step(tx, ws, skuId, 'claims', 'active');
      for (const c of x.claimsFound) await proposeClaim(tx, ctx, skuId, { wording: c.wording, origin: 'extracted', sourceText: c.sourceQuote });
      const [cc] = await tx`select count(*) filter (where status in ('BLOCKED','RESTRICTED'))::int as risky, count(*)::int as n from claims where sku_id = ${skuId}`;
      await step(tx, ws, skuId, 'claims', 'done', cc!.n ? `${cc!.n} claim${cc!.n > 1 ? 's' : ''} found${cc!.risky ? ` · ${cc!.risky} we won’t use` : ''}` : 'No claims found on the page');
    });

    // 6. Visual Fingerprint + cut-out (deterministic keying; a photo keying can't separate gets one background-removal
    //    try when the storyboard first needs the cut-out — see cutout.ts).
    await withTenant(ws, (tx) => step(tx, ws, skuId, 'fingerprint', 'active'));
    const cutFrom = photoIds.indexOf(usable[0]!);
    const cut = await cutout(photos[cutFrom]!);
    const colors = await dominantColors(cut.png);
    await withTenant(ws, async (tx) => {
      const c = await saveAsset(tx, ws, {
        bytes: cut.png,
        mime: 'image/png',
        kind: 'cutout',
        skuId,
        source: 'generated',
        lineage: { from: usable[0], keyed: cut.keyed, technique: cut.technique, coverage: Math.round(cut.coverage * 1000) / 1000, spread: Math.round(cut.spread * 1000) / 1000 },
      });
      const [v] = await tx`select coalesce(max(version), 0) + 1 as v from visual_fingerprints where sku_id = ${skuId}`;
      await tx`update visual_fingerprints set active = false where sku_id = ${skuId}`;
      await tx`insert into visual_fingerprints (workspace_id, sku_id, version, reference_asset_ids, cutout_asset_id, label_text, brand_text,
                 package_type, closure, dominant_colors, transparency, thresholds)
               values (${ws}, ${skuId}, ${v!.v}, ${[...usable, ...(await usableAssetIds(tx, photoIds.slice(3)))]}, ${c.id}, ${x.labelText}, ${x.brand}, ${x.packaging.type}, ${x.packaging.closure},
                 ${tx.json(colors)}, ${x.packaging.transparent ? 'transparent' : 'opaque'},
                 ${tx.json({ ...DEFAULT_FIDELITY_THRESHOLDS, labelMustMatch: !!x.labelText } as never)})`;
      await emit(tx, ctx, 'VISUAL_FINGERPRINT_VERSIONED', { type: 'sku', id: skuId }, { version: v!.v, keyed: cut.keyed, technique: cut.technique });
      await step(tx, ws, skuId, 'fingerprint', 'done', `${x.packaging.type.replace('_', ' ')}${x.packaging.closure ? ` · ${x.packaging.closure}` : ''}`);
      await tx`update skus set status = 'active' where id = ${skuId}`;
      await transition(tx, ctx, projectId, 'PRODUCT_ANALYZED');
      await transition(tx, ctx, projectId, 'BRIEF_READY');
      await emit(tx, ctx, 'PRODUCT_IMPORTED', { type: 'sku', id: skuId }, { source: extracted?.source ?? 'photos' });
      await recordFunnel('SKU_VALIDATED', { workspaceId: ws }, tx);
      await recordFunnel('PRODUCT_ANALYZED', { workspaceId: ws }, tx);
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
    const [v] = await tx`select coalesce(max(version), 0) + 1 as v from visual_fingerprints where sku_id = ${skuId}`;
    const refs = [...new Set([...((fp.reference_asset_ids as string[]) ?? []), ...usable])];
    await tx`update visual_fingerprints set active = false where sku_id = ${skuId}`;
    await tx`insert into visual_fingerprints (workspace_id, sku_id, version, reference_asset_ids, cutout_asset_id, label_text, brand_text, package_type, closure,
               dominant_colors, liquid_color, transparency, critical_regions, thresholds)
             select workspace_id, sku_id, ${v!.v}, ${refs}::uuid[], cutout_asset_id, label_text, brand_text, package_type, closure,
               dominant_colors, liquid_color, transparency, critical_regions, thresholds
             from visual_fingerprints where id = ${fp.id}`;
    await emit(tx, ctx, 'VISUAL_FINGERPRINT_VERSIONED', { type: 'sku', id: skuId }, { version: v!.v, addedViews: usable.length });
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
export async function requestConcepts(tx: Tx, ctx: TenantContext, projectId: string): Promise<{ batch: number; subjectId: string; replayed: boolean }> {
  assertCan(ctx, 'sku.edit');
  const [p] = await tx`select sku_id, state from projects where id = ${projectId} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  if (!['CONCEPTS_READY', 'CONCEPT_SELECTED', 'STORYBOARD_READY'].includes(p.state as string))
    throw new DomainError('CONFLICT', p.state === 'STORYBOARD_APPROVED' || isTerminal(p.state as ProjectState) ? 'This ad is already in production.' : 'Your first ideas are still being drafted.');
  const [pending] = await tx`select step_key from progress_steps where subject_id = ${projectId} and step_key like 'concepts.batch.%'
                             and status in ('pending','active') and started_at > now() - make_interval(mins => ${CONCEPT_REQUEST_STALE_MINUTES})
                             order by started_at desc limit 1`;
  if (pending) return { batch: Number(String(pending.step_key).split('.').pop()), subjectId: projectId, replayed: true };
  const [b] = await tx`select coalesce(max(batch), 0) as b from concepts where project_id = ${projectId}`;
  const batch = Number(b!.b) + 1;
  if (ctx.workspaceState === 'PROVISIONAL' && batch > 1 + PROVISIONAL.MAX_CONCEPT_REGENERATIONS)
    throw new DomainError('PAYMENT_REQUIRED', 'Save your work to see more ideas.', { needsAccount: true });
  if (ctx.workspaceState !== 'PROVISIONAL' && isFreeTier(ctx) && batch > FREE_EXPLORATION.CONCEPT_BATCHES_PER_SKU)
    throw new DomainError('PAYMENT_REQUIRED', 'Produce this one to keep exploring — you’ve seen all the free ideas for this product.', { freeLimit: 'concept_batches' });
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
