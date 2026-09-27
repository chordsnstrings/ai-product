import type { Tx } from '@arkiv/db';
import { DomainError, type ProjectState } from '@arkiv/shared';
import { assertCan } from './authz';
import { proposeClaim } from './claims';
import type { TenantContext } from './context';
import { emit } from './events';
import { versionFingerprint } from './fingerprint';
import { decideFact, recordFacts, type FactInput, type SourceType } from './product-truth';
import { transition } from './projects';
import { usableAssetIds } from './vision';

/**
 * Duplicate import → merge (standard §42 "Detect source/product match and offer merge rather than creating
 * competing Product Brains"). An import that turned out to be a product already in the catalogue is folded into
 * it: its observations become new observations of the existing product (with their original source and
 * provenance, so disagreements surface as disputes rather than overwriting), its claims join the existing claims
 * by meaning, its photos become reference views of a new fingerprint version, and the import is archived with a
 * pointer to the product it became. Only an import nothing has been made from yet can be merged.
 */

/** States of a project nothing has been bought or made for yet. */
const MERGEABLE_STATES: ReadonlySet<ProjectState> = new Set(['PRODUCT_UPLOADED', 'PRODUCT_ANALYZED', 'BRIEF_READY', 'CONCEPTS_READY', 'CONCEPT_SELECTED', 'NEEDS_USER_ACTION', 'CANCELLED']);
/** Assets that describe the product (not generated ads), moved to the product they belong to. */
const PRODUCT_ASSET_KINDS = ['product_photo', 'reference_view', 'cutout', 'label_crop', 'evidence_doc'];

export interface MergeResult {
  from: string;
  into: string;
  counts: { facts: number; claims: number; assets: number; variants: number; signals: number; projects: number };
}

export async function mergeSkus(tx: Tx, ctx: TenantContext, fromSkuId: string, intoSkuId: string): Promise<MergeResult> {
  assertCan(ctx, 'sku.edit');
  if (fromSkuId === intoSkuId) throw new DomainError('INVALID', 'Choose a different product to merge into.');
  const ws = ctx.workspaceId;
  const rows = await tx`select id, status, catalogue_no, name from skus where id in (${fromSkuId}, ${intoSkuId}) and workspace_id = ${ws} order by id for update`;
  const from = rows.find((r) => r.id === fromSkuId);
  const into = rows.find((r) => r.id === intoSkuId);
  if (!from || !into) throw new DomainError('NOT_FOUND', 'Product not found');
  if (['archived', 'rejected'].includes(into.status as string)) throw new DomainError('CONFLICT', 'That product is no longer in your catalogue.');
  if (from.status === 'archived') throw new DomainError('CONFLICT', 'This product was already merged or archived.');
  const projects = await tx`select p.id, p.state, p.storyboard_id from projects p where p.sku_id = ${fromSkuId} and p.workspace_id = ${ws} for update`;
  const made = projects.some((p) => !MERGEABLE_STATES.has(p.state as ProjectState) || p.storyboard_id);
  const [used] = await tx`select (select count(*) from experiments where sku_id = ${fromSkuId} and workspace_id = ${ws})::int
                               + (select count(*) from creatives where sku_id = ${fromSkuId} and workspace_id = ${ws})::int as n`;
  if (made || Number(used!.n) > 0) throw new DomainError('CONFLICT', 'Ads were already made for this product, so it can’t be merged.');

  // Facts: every live observation becomes a new observation of the product, with its own source and provenance.
  const facts = await tx`select * from product_facts where sku_id = ${fromSkuId} and workspace_id = ${ws} and status <> 'SUPERSEDED' order by observed_at`;
  const observed: FactInput[] = facts
    .filter((f) => f.state !== 'DECIDED')
    .map((f) => ({
      key: f.normalized_key as string,
      factType: f.fact_type as string,
      valueText: (f.value_text as string | null) ?? null,
      valueNumber: f.value_number == null ? null : Number(f.value_number),
      valueJson: f.value_json ?? undefined,
      sourceType: f.source_type as SourceType,
      sourceId: (f.source_id as string | null) ?? null,
      sourceUrl: (f.source_url as string | null) ?? null,
      confidence: Number(f.confidence),
      state: f.state as FactInput['state'],
    }));
  const r = await recordFacts(tx, ctx, intoSkuId, observed);
  // The merchant's own decisions on the import apply where the product has none of its own for that fact.
  let decided = 0;
  for (const f of facts.filter((x) => x.state === 'DECIDED')) {
    const [mine] = await tx`select 1 from product_facts where sku_id = ${intoSkuId} and normalized_key = ${f.normalized_key} and state = 'DECIDED' and status <> 'SUPERSEDED'`;
    if (mine) continue;
    await decideFact(tx, ctx, intoSkuId, f.normalized_key as string, { text: (f.value_text as string | null) ?? null, number: f.value_number == null ? null : Number(f.value_number), json: f.value_json ?? undefined });
    decided++;
  }

  // Claims join the product's by meaning (§17); evidence follows the claim it supports.
  const claims = await tx`select * from claims where sku_id = ${fromSkuId} and workspace_id = ${ws} order by created_at`;
  for (const c of claims) {
    const target = await proposeClaim(tx, ctx, intoSkuId, { wording: c.preferred_wording as string, meaning: c.canonical_meaning as string, origin: c.origin as 'extracted', sourceText: (c.source_text as string | null) ?? null });
    for (const alt of (c.alt_wordings as string[]) ?? []) await proposeClaim(tx, ctx, intoSkuId, { wording: alt, meaning: c.canonical_meaning as string, origin: c.origin as 'extracted', sourceText: (c.source_text as string | null) ?? null });
    await tx`insert into claim_evidence (workspace_id, claim_id, evidence_type, source_asset_id, source_location, supplied_by, applicability, evidence_strength, expiry_date, substantiated_wording)
             select workspace_id, ${target.id}, evidence_type, source_asset_id, source_location, supplied_by, applicability, evidence_strength, expiry_date, substantiated_wording
             from claim_evidence where claim_id = ${c.id} and workspace_id = ${ws}`;
  }

  // Photos, cut-outs, label crops and evidence files belong to the product now.
  const moved = await tx`update assets set sku_id = ${intoSkuId} where sku_id = ${fromSkuId} and workspace_id = ${ws} and kind in ${tx(PRODUCT_ASSET_KINDS)} returning id, kind`;
  // The import's photos become reference views of the product's fingerprint (a new version; photos held for review never do).
  const [fromFp] = await tx`select * from visual_fingerprints where sku_id = ${fromSkuId} and workspace_id = ${ws} and active`;
  const [intoFp] = await tx`select reference_asset_ids from visual_fingerprints where sku_id = ${intoSkuId} and workspace_id = ${ws} and active`;
  const photos = await usableAssetIds(tx, moved.filter((a) => a.kind === 'product_photo' || a.kind === 'reference_view').map((a) => a.id as string));
  if (intoFp && photos.length) {
    const refs = [...new Set([...((intoFp.reference_asset_ids as string[]) ?? []), ...photos])];
    await versionFingerprint(tx, ctx, intoSkuId, { reference_asset_ids: refs }, { reason: 'merged', payload: { mergedFrom: fromSkuId, addedViews: refs.length - ((intoFp.reference_asset_ids as string[]) ?? []).length } });
  } else if (!intoFp && fromFp) {
    await versionFingerprint(
      tx,
      ctx,
      intoSkuId,
      {
        reference_asset_ids: fromFp.reference_asset_ids as string[],
        cutout_asset_id: fromFp.cutout_asset_id as string | null,
        label_text: fromFp.label_text as string | null,
        brand_text: fromFp.brand_text as string | null,
        package_type: fromFp.package_type as string | null,
        closure: fromFp.closure as string | null,
        dominant_colors: fromFp.dominant_colors as string[],
        liquid_color: fromFp.liquid_color as string | null,
        transparency: fromFp.transparency as string | null,
        critical_regions: fromFp.critical_regions as never,
        thresholds: fromFp.thresholds as Record<string, unknown>,
        views: fromFp.views as never,
        label_crop_asset_id: fromFp.label_crop_asset_id as string | null,
        geometry: fromFp.geometry as never,
      },
      { reason: 'merged', payload: { mergedFrom: fromSkuId } },
    );
  }

  // Sizes/shades the product doesn't list yet (§42 variants), and the customer language imported for the import.
  const variants = await tx`insert into sku_variants (workspace_id, sku_id, source, external_id, title, options, size, shade, price_micros, compare_at_micros,
                              currency, sku_code, gtin, available, image_url, image_asset_ids, position)
                            select workspace_id, ${intoSkuId}, source, external_id, title, options, size, shade, price_micros, compare_at_micros,
                              currency, sku_code, gtin, available, image_url, image_asset_ids, position
                            from sku_variants where sku_id = ${fromSkuId} and workspace_id = ${ws}
                            on conflict (workspace_id, sku_id, source, external_id) do nothing returning id`;
  const signals = await tx`insert into customer_signals (workspace_id, sku_id, source, source_ref, text, rating, author_hash, observed_at, imported_at)
                           select s.workspace_id, ${intoSkuId}, s.source, s.source_ref, s.text, s.rating, s.author_hash, s.observed_at, s.imported_at
                           from customer_signals s where s.sku_id = ${fromSkuId} and s.workspace_id = ${ws}
                             and not exists (select 1 from customer_signals t where t.sku_id = ${intoSkuId} and t.workspace_id = ${ws} and t.text = s.text and t.source = s.source)
                           returning id`;

  // The import's previews end; the import stays (archived) as the record of where these observations came from.
  const reason = `Merged into No. ${String(into.catalogue_no).padStart(3, '0')} (${into.name as string})`;
  let ended = 0;
  for (const p of projects) {
    if (p.state === 'CANCELLED') continue;
    await transition(tx, ctx, p.id as string, 'CANCELLED', { reason, detail: 'merged_duplicate' });
    ended++;
  }
  await tx`update progress_steps set status = 'skipped' where subject_id = ${fromSkuId} and status in ('pending', 'active')`;
  await tx`update skus set status = 'archived',
             analysis = coalesce(analysis, '{}'::jsonb) || ${tx.json({ mergedInto: intoSkuId, duplicate: { skuId: intoSkuId, catalogueNo: Number(into.catalogue_no), name: into.name, resolved: 'merged' } } as never)}
           where id = ${fromSkuId} and workspace_id = ${ws}`;
  const counts = { facts: r.recorded + decided, claims: claims.length, assets: moved.length, variants: variants.length, signals: signals.length, projects: ended };
  await emit(tx, ctx, 'SKU_MERGED', { type: 'sku', id: fromSkuId }, { into: intoSkuId, intoCatalogueNo: Number(into.catalogue_no), counts }, { skuId: fromSkuId });
  return { from: fromSkuId, into: intoSkuId, counts };
}
