import { withTenant, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { saveAsset } from './assets';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { pinnedFingerprintId } from './fingerprint';
import { fetchImage, findSize, type ExtractedVariant } from './ingest';
import { refreshStock } from './stock';
import { usableAssetIds } from './vision';

/**
 * Product variants (standard §42 "Variants / sizes: store variant-specific price/media where relevant; do not
 * show wrong size/shade"). A SKU sold in several sizes or shades keeps each variant's price, availability and
 * image; a project records which variant it advertises, and creative uses that variant's size, shade and price
 * — or, when none is chosen and the variants differ, states no size or price at all.
 */

export interface SkuVariant {
  id: string;
  title: string;
  options: Record<string, string>;
  size: string | null;
  shade: string | null;
  priceMicros: number | null;
  compareAtMicros: number | null;
  currency: string | null;
  available: boolean | null;
  imageUrl: string | null;
  imageAssetIds: string[];
}

const SIZE_OPTION = /size|volume|capacity|amount|ml|oz/i;
const SHADE_OPTION = /shade|colou?r|tone|tint|finish/i;

/** Size and shade of a variant, from its option names (Size, Shade…) or, for size, from its title. */
export function variantDimensions(v: Pick<ExtractedVariant, 'title' | 'options'>): { size: string | null; shade: string | null } {
  const entries = Object.entries(v.options ?? {});
  const size = entries.find(([k]) => SIZE_OPTION.test(k))?.[1] ?? findSize(v.title) ?? null;
  const shade = entries.find(([k]) => SHADE_OPTION.test(k))?.[1] ?? null;
  return { size: size?.trim() || null, shade: shade?.trim() || null };
}

const rowToVariant = (r: Record<string, unknown>): SkuVariant => ({
  id: r.id as string,
  title: r.title as string,
  options: (r.options as Record<string, string>) ?? {},
  size: (r.size as string) ?? null,
  shade: (r.shade as string) ?? null,
  priceMicros: r.price_micros == null ? null : Number(r.price_micros),
  compareAtMicros: r.compare_at_micros == null ? null : Number(r.compare_at_micros),
  currency: (r.currency as string) ?? null,
  available: (r.available as boolean | null) ?? null,
  imageUrl: (r.image_url as string) ?? null,
  imageAssetIds: (r.image_asset_ids as string[]) ?? [],
});

/**
 * Upsert a store's variants for a SKU (current catalogue state; the `variants` fact keeps the history). A variant
 * the store no longer lists is kept (an ad may have been made for it) but marked unavailable.
 */
export async function recordVariants(tx: Tx, ctx: Pick<TenantContext, 'workspaceId'>, skuId: string, source: 'shopify' | 'json_ld' | 'manual', variants: readonly ExtractedVariant[], currency?: string | null): Promise<number> {
  let n = 0;
  const seen: string[] = [];
  for (const [i, v] of variants.slice(0, 50).entries()) {
    const externalId = v.externalId ?? v.sku ?? v.title;
    if (!externalId || !v.title) continue;
    seen.push(externalId);
    const { size, shade } = variantDimensions(v);
    await tx`
      insert into sku_variants (workspace_id, sku_id, source, external_id, title, options, size, shade, price_micros, compare_at_micros,
        currency, sku_code, gtin, available, image_url, position)
      values (${ctx.workspaceId}, ${skuId}, ${source}, ${externalId}, ${v.title.slice(0, 200)}, ${tx.json((v.options ?? {}) as never)}, ${size}, ${shade},
        ${v.priceMicros ?? null}, ${v.compareAtMicros ?? null}, ${currency ?? null}, ${v.sku ?? null}, ${v.gtin ?? null}, ${v.available ?? null},
        ${v.imageUrl ?? null}, ${i})
      on conflict (workspace_id, sku_id, source, external_id) do update set
        title = excluded.title, options = excluded.options, size = excluded.size, shade = excluded.shade,
        price_micros = excluded.price_micros, compare_at_micros = excluded.compare_at_micros, currency = excluded.currency,
        sku_code = excluded.sku_code, gtin = excluded.gtin, available = excluded.available, position = excluded.position,
        image_asset_ids = case when sku_variants.image_url is distinct from excluded.image_url then '{}' else sku_variants.image_asset_ids end,
        image_url = excluded.image_url`;
    n++;
  }
  if (seen.length) {
    await tx`update sku_variants set available = false
             where sku_id = ${skuId} and source = ${source} and external_id <> all(${seen}::text[]) and available is distinct from false`;
  }
  // §42 "Out of stock": the SKU is out when none of the variants the store sells is available.
  await refreshStock(tx, ctx, skuId);
  return n;
}

export async function listVariants(tx: Tx, skuId: string): Promise<SkuVariant[]> {
  return (await tx`select * from sku_variants where sku_id = ${skuId} order by position, title`).map(rowToVariant);
}

/** The variant a project advertises, if one was chosen. */
export async function projectVariant(tx: Tx, projectId: string): Promise<SkuVariant | null> {
  const [r] = await tx`select v.* from projects p join sku_variants v on v.id = p.sku_variant_id and v.workspace_id = p.workspace_id where p.id = ${projectId}`;
  return r ? rowToVariant(r) : null;
}

/** States in which the advertised variant may still change: before a concept (and its storyboard) is chosen. */
const VARIANT_EDITABLE = ['PRODUCT_UPLOADED', 'PRODUCT_ANALYZED', 'BRIEF_READY', 'CONCEPTS_READY', 'NEEDS_USER_ACTION'];

/** The merchant picks which size/shade this ad is for (confirmation step), or clears the choice. */
export async function selectVariant(tx: Tx, ctx: TenantContext, projectId: string, variantId: string | null): Promise<SkuVariant | null> {
  assertCan(ctx, 'sku.edit');
  const [p] = await tx`select sku_id, state from projects where id = ${projectId} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  if (!VARIANT_EDITABLE.includes(p.state as string)) throw new DomainError('CONFLICT', 'Choose the size or shade before picking an idea — the storyboard is drawn for it.');
  if (variantId) {
    const [v] = await tx`select id from sku_variants where id = ${variantId} and sku_id = ${p.sku_id}`;
    if (!v) throw new DomainError('NOT_FOUND', 'That option isn’t one of this product’s variants.');
  }
  await tx`update projects set sku_variant_id = ${variantId} where id = ${projectId}`;
  return variantId ? projectVariant(tx, projectId) : null;
}

/**
 * What creative may say about size, shade and price for a SKU (and project): the chosen variant's values; with
 * no choice, a value only when every variant shares it (e.g. shades of one size); with no variants, the facts.
 */
export function variantTruth(variants: readonly SkuVariant[], chosen: SkuVariant | null, facts: { size: string | null; priceMicros: number | null }) {
  const one = <T>(vals: (T | null)[]): T | null => {
    const set = [...new Set(vals)];
    return set.length === 1 ? set[0]! : null;
  };
  if (chosen) {
    return {
      size: chosen.size ?? (variants.length <= 1 ? facts.size : null),
      shade: chosen.shade,
      priceMicros: chosen.priceMicros ?? (variants.length <= 1 ? facts.priceMicros : null),
      variantTitle: variants.length > 1 ? chosen.title : null,
      ambiguous: false,
    };
  }
  if (variants.length <= 1) {
    const v = variants[0] ?? null;
    return { size: v?.size ?? facts.size, shade: v?.shade ?? null, priceMicros: v?.priceMicros ?? facts.priceMicros, variantTitle: null, ambiguous: false };
  }
  const sizes = variants.map((v) => v.size);
  const size = sizes.every((s) => s == null) ? facts.size : one(sizes);
  return { size, shade: one(variants.map((v) => v.shade)), priceMicros: one(variants.map((v) => v.priceMicros)), variantTitle: null, ambiguous: true };
}

/**
 * Product references for generated frames and fidelity QA: the advertised variant's own image first (§42 "do not
 * show the wrong size/shade"), then the fingerprint's reference photos.
 */
export async function referenceAssetIds(tx: Tx, skuId: string, projectId: string | null): Promise<string[]> {
  // The packaging the project's storyboard was drawn for (§42), else the SKU's current fingerprint.
  const pinned = projectId ? await pinnedFingerprintId(tx, projectId) : null;
  const [fp] = await tx`select reference_asset_ids from visual_fingerprints where sku_id = ${skuId} and (id = ${pinned}::uuid or active)
                        order by (id = ${pinned}::uuid) desc nulls last, version desc limit 1`;
  const variant = projectId ? await projectVariant(tx, projectId) : null;
  // Media held for compliance review (before/after, possible minors) or rejected is never a production input (plan 05 §14).
  return (await usableAssetIds(tx, [...new Set([...(variant?.imageAssetIds ?? []), ...((fp?.reference_asset_ids as string[]) ?? [])])])).slice(0, 2);
}

/**
 * Own a copy of the variant's image (fingerprint references prefer it over the SKU's generic photos). Runs in
 * workers; a missing or unusable image leaves the SKU's references in use.
 */
export async function ensureVariantImage(ctx: Pick<TenantContext, 'workspaceId'>, variantId: string): Promise<string[]> {
  const ws = ctx.workspaceId;
  const [v] = await withTenant(ws, (tx) => tx`select sku_id, image_url, image_asset_ids from sku_variants where id = ${variantId}`);
  if (!v) return [];
  if ((v.image_asset_ids as string[]).length || !v.image_url) return v.image_asset_ids as string[];
  const bytes = await fetchImage(v.image_url as string);
  if (!bytes) return [];
  try {
    const { validateMedia } = await import('./uploads');
    const m = await validateMedia(bytes);
    return await withTenant(ws, async (tx) => {
      const a = await saveAsset(tx, ws, { bytes: m.bytes, mime: m.mime, kind: 'reference_view', skuId: v.sku_id as string, source: 'import', origin: { url: v.image_url }, lineage: { variantId } });
      await tx`update sku_variants set image_asset_ids = ${[a.id]}::uuid[] where id = ${variantId}`;
      return [a.id];
    });
  } catch {
    return [];
  }
}
