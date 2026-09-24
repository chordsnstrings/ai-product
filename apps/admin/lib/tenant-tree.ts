/** Brands & SKUs tab (plan 05 §2.2 "Tree with counts: facts, claims by status, assets, experiments"). */
type SkuMeta = Record<string, unknown>;
export interface BrandNode {
  name: string;
  skus: SkuMeta[];
  facts: number;
  assets: number;
  experiments: number;
  claims: Record<string, number>;
}

/** Group SKU rows under their brand, with per-brand totals. Brands without SKUs are listed; SKUs without a brand go last. */
export function brandTree(rows: SkuMeta[], emptyBrands: SkuMeta[] = []): BrandNode[] {
  const byBrand = new Map<string, BrandNode>();
  for (const r of rows) {
    const key = (r.brand_id as string) ?? '';
    let b = byBrand.get(key);
    if (!b) byBrand.set(key, (b = { name: (r.brand as string) ?? 'No brand', skus: [], facts: 0, assets: 0, experiments: 0, claims: {} }));
    b.skus.push(r);
    b.facts += Number(r.facts ?? 0);
    b.assets += Number(r.assets ?? 0);
    b.experiments += Number(r.experiments ?? 0);
    for (const [k, n] of Object.entries((r.claims as Record<string, number>) ?? {})) b.claims[k] = (b.claims[k] ?? 0) + Number(n);
  }
  for (const e of emptyBrands) if (!byBrand.has(e.id as string)) byBrand.set(e.id as string, { name: e.name as string, skus: [], facts: 0, assets: 0, experiments: 0, claims: {} });
  const named = [...byBrand.entries()].filter(([k]) => k !== '').map(([, v]) => v).sort((a, b) => a.name.localeCompare(b.name));
  const none = byBrand.get('');
  return none ? [...named, none] : named;
}

/** "verified 3 · blocked 1" */
export const claimCounts = (c: Record<string, number> | null | undefined) =>
  Object.entries(c ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k.toLowerCase()} ${n}`)
    .join(' · ') || '—';
