import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { extractionFacts } from './analysis';
import type { ExtractedProduct } from './ingest';
import { mockExtraction } from './mock-intel';
import { acceptSourceFact, confirmFacts, currentFacts, decideFact, parseSizes, recordFacts, sameValue } from './product-truth';
import { ctxFor } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

async function sku() {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const skuId = await makeSku(t.workspaceId);
  return { t, ctx, skuId };
}

const rows = (skuId: string, key: string) =>
  ownerPool()`select id, source_type, state, status, value_text, value_number::float8 as value_number, valid_to, supersedes_fact_id
              from product_facts where sku_id = ${skuId} and normalized_key = ${key} order by observed_at, id`;
const events = (skuId: string, type: string) => ownerPool()`select payload from events where subject_id = ${skuId} and type = ${type} order by at`;

describe('value comparison (§42: formatting differences are not disputes)', () => {
  it('reads pack sizes in any unit', () => {
    expect(parseSizes('30 ml / 1.0 fl. oz')).toEqual([{ dim: 'vol', amount: 30 }, { dim: 'vol', amount: 29.5735 }]);
    expect(sameValue('size', { valueText: '30ml' }, { valueText: '1 fl oz' })).toBe(true);
    expect(sameValue('size', { valueText: '30 mL' }, { valueText: '30 ml' })).toBe(true);
    expect(sameValue('size', { valueText: '50 ml' }, { valueText: '30 ml' })).toBe(false);
    expect(sameValue('size', { valueText: '50 g' }, { valueText: '50 ml' })).toBe(false);
    expect(sameValue('size', { valueText: '1.7 oz' }, { valueText: '48 g' })).toBe(true);
  });

  it('treats a brand prefix or punctuation in a name as the same name, a different product as different', () => {
    expect(sameValue('name', { valueText: 'Glow Serum No. 3' }, { valueText: 'Lumen Glow Serum No 3' })).toBe(true);
    expect(sameValue('name', { valueText: 'Niacinamide 10% + Zinc 1%' }, { valueText: 'niacinamide 10% zinc 1%' })).toBe(true);
    expect(sameValue('name', { valueText: 'Glow Serum' }, { valueText: 'Barrier Cream' })).toBe(false);
    expect(sameValue('price', { valueNumber: 38 }, { valueNumber: 38.0 })).toBe(true);
    expect(sameValue('price', { valueNumber: 38 }, { valueNumber: 42 })).toBe(false);
  });
});

describe('recordFacts: versions and disputes (§16, §28, §42)', () => {
  it('a Shopify re-sync supersedes the store’s earlier value instead of disputing it', async () => {
    const { t, ctx, skuId } = await sku();
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'price', valueNumber: 38, sourceType: 'shopify', sourceId: 'v1', state: 'OBSERVED' }]));
    const r = await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'price', valueNumber: 42, sourceType: 'shopify', sourceId: 'v2', state: 'OBSERVED' }]));
    expect(r.disputes).toEqual([]);
    const [old, cur] = await rows(skuId, 'price');
    expect(old).toMatchObject({ status: 'SUPERSEDED', value_number: 38 });
    expect(old!.valid_to).not.toBeNull();
    expect(cur).toMatchObject({ status: 'ACTIVE', value_number: 42, supersedes_fact_id: old!.id });
    expect(await events(skuId, 'PRODUCT_CONFLICT_DETECTED')).toHaveLength(0);
    const changed = await events(skuId, 'PRODUCT_FACT_CHANGED');
    expect(changed.map((e) => e.payload)).toContainEqual(expect.objectContaining({ key: 'price', supersedes: [old!.id] }));
    const facts = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(facts.price).toMatchObject({ disputed: false, sourceConflict: null });
    expect(facts.price!.value.valueNumber).toBe(42);
  });

  it('different sources that disagree on a material key are both kept and DISPUTED; formatting differences are not', async () => {
    const { t, ctx, skuId } = await sku();
    await withTenant(t.workspaceId, (tx) =>
      recordFacts(tx, ctx, skuId, [
        { key: 'size', valueText: '30 ml', sourceType: 'product_page', state: 'OBSERVED' },
        { key: 'name', valueText: 'Glow Serum No. 3', sourceType: 'product_page', state: 'OBSERVED' },
      ]),
    );
    const r = await withTenant(t.workspaceId, (tx) =>
      recordFacts(tx, ctx, skuId, [
        { key: 'size', valueText: '50 ml', sourceType: 'photo_ocr', state: 'OBSERVED' },
        { key: 'name', valueText: 'LUMEN Glow Serum No 3', sourceType: 'photo_ocr', state: 'OBSERVED' },
        // An interpretation never disputes a source.
        { key: 'category', valueText: 'serum', sourceType: 'vision', state: 'INFERRED' },
      ]),
    );
    expect(r.disputes).toEqual(['size']);
    expect((await rows(skuId, 'size')).map((x) => x.status)).toEqual(['DISPUTED', 'DISPUTED']);
    expect((await rows(skuId, 'name')).map((x) => x.status)).toEqual(['ACTIVE', 'ACTIVE']);
    const facts = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(facts.size!.disputed).toBe(true);
    expect(facts.name!.disputed).toBe(false);
  });

  it('a dispute ends when the disagreeing source re-reads a matching value', async () => {
    const { t, ctx, skuId } = await sku();
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'price', valueNumber: 38, sourceType: 'product_page', state: 'OBSERVED' }]));
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'price', valueNumber: 35, sourceType: 'shopify', state: 'OBSERVED' }]));
    expect((await rows(skuId, 'price')).map((x) => x.status)).toEqual(['DISPUTED', 'DISPUTED']);
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'price', valueNumber: 38, sourceType: 'shopify', state: 'OBSERVED' }]));
    expect((await rows(skuId, 'price')).map((x) => x.status)).toEqual(['ACTIVE', 'SUPERSEDED', 'ACTIVE']);
    const facts = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(facts.price!.disputed).toBe(false);
  });
});

describe('a merchant decision never hides a source that disagrees (§28, §42)', () => {
  it('shows the Shopify value next to the correction, and a later store change as newer, with both ways out', async () => {
    const { t, ctx, skuId } = await sku();
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'price', valueNumber: 38, sourceType: 'shopify', state: 'OBSERVED' }]));
    await withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'price', { number: 36 }));
    let facts = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(facts.price!.value).toMatchObject({ state: 'DECIDED', valueNumber: 36 });
    expect(facts.price!.sourceConflict).toMatchObject({ newer: false, fact: { sourceType: 'shopify', valueNumber: 38 } });

    // The store changes its price after the decision: it is recorded, flagged against the merchant, and newer.
    const r = await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'price', valueNumber: 40, sourceType: 'shopify', state: 'OBSERVED' }]));
    expect(r.disputes).toEqual(['price']);
    expect((await events(skuId, 'PRODUCT_CONFLICT_DETECTED')).map((e) => e.payload)).toContainEqual(expect.objectContaining({ key: 'price', vs: 'merchant' }));
    facts = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(facts.price!.value.valueNumber).toBe(36);
    expect(facts.price!.sourceConflict).toMatchObject({ newer: true, fact: { sourceType: 'shopify', valueNumber: 40 } });

    // "Keep yours": a fresh decision acknowledges the store value — still shown, no longer asked about.
    await withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'price', { number: 36 }));
    facts = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(facts.price!.sourceConflict).toMatchObject({ newer: false, fact: { valueNumber: 40 } });

    // "Use store value": the decision is superseded and the store's reading is the truth again.
    await withTenant(t.workspaceId, (tx) => acceptSourceFact(tx, ctx, skuId, facts.price!.sourceConflict!.fact.id));
    facts = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(facts.price!.value).toMatchObject({ state: 'OBSERVED', sourceType: 'shopify', valueNumber: 40, status: 'ACTIVE' });
    expect(facts.price).toMatchObject({ disputed: false, sourceConflict: null });
    const decided = await ownerPool()`select status from product_facts where sku_id = ${skuId} and state = 'DECIDED'`;
    expect(decided.every((d) => d.status === 'SUPERSEDED')).toBe(true);
    // A value that is gone cannot be accepted.
    const [gone] = await ownerPool()`select id from product_facts where sku_id = ${skuId} and status = 'SUPERSEDED' and state = 'OBSERVED' limit 1`;
    await expect(withTenant(t.workspaceId, (tx) => acceptSourceFact(tx, ctx, skuId, gone!.id as string))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('concurrent decisions on one key leave exactly one current decision', async () => {
    const { t, ctx, skuId } = await sku();
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'size', valueText: '30 ml', sourceType: 'product_page', state: 'OBSERVED' }]));
    await Promise.all([
      withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'size', { text: '50 ml' })),
      withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'size', { text: '100 ml' })),
    ]);
    const decided = (await rows(skuId, 'size')).filter((r) => r.state === 'DECIDED');
    expect(decided).toHaveLength(2);
    expect(decided.filter((d) => d.status !== 'SUPERSEDED')).toHaveLength(1);
    expect(decided.find((d) => d.status === 'SUPERSEDED')!.valid_to).not.toBeNull();
  });

  it('concurrent identical observations are recorded once', async () => {
    const { t, ctx, skuId } = await sku();
    const obs = [{ key: 'price', valueNumber: 38, sourceType: 'shopify' as const, state: 'OBSERVED' as const }];
    await Promise.all([1, 2, 3].map(() => withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, obs))));
    expect(await rows(skuId, 'price')).toHaveLength(1);
  });
});

describe('extraction facts are labelled for what they are (§15)', () => {
  const page: ExtractedProduct = {
    source: 'json_ld',
    name: 'Glow Serum No. 3',
    description: 'A lightweight niacinamide serum.',
    ingredients: 'Aqua, Niacinamide, Zinc PCA, Glycerin',
    sizeText: '30 ml',
    images: [],
    rawText: '',
  };

  it('no vision fact is OBSERVED, and page-sourced key ingredients are the page’s own INCI entries', () => {
    const x = { ...mockExtraction({ name: page.name, description: page.description, text: '', ingredients: page.ingredients, sizeText: '50 ml' }), keyIngredients: ['niacinamide', 'Vitamin C', 'zinc pca'] };
    const f = extractionFacts(x, page, 'https://shop.example/p', 'job-1');
    expect(f.filter((a) => a.sourceType === 'vision').every((a) => a.state === 'INFERRED')).toBe(true);
    expect(f.find((a) => a.key === 'key_ingredients')).toMatchObject({ valueText: 'Niacinamide, Zinc PCA', sourceType: 'json_ld', state: 'OBSERVED' });
    for (const a of f.filter((a) => ['product_page', 'json_ld'].includes(a.sourceType))) {
      for (const part of String(a.valueText).split(', ')) expect(page.ingredients).toContain(part);
    }
    // The label's size is always recorded, so a label that disagrees with the page surfaces as a dispute.
    expect(f.find((a) => a.key === 'size')).toMatchObject({ valueText: '50 ml', sourceType: 'photo_ocr', state: 'OBSERVED' });
    // The name read verbatim on the label is an observation of the label.
    expect(f.find((a) => a.key === 'name')).toMatchObject({ sourceType: 'photo_ocr', state: 'OBSERVED' });
  });

  it('a name or ingredient the label does not show is the model’s inference', () => {
    const x = { ...mockExtraction({ text: '' }), name: 'Brightening Serum', labelText: 'LUMEN 30 ml', keyIngredients: ['vitamin c'] };
    const f = extractionFacts(x, null, null, 'job-2');
    expect(f.find((a) => a.key === 'name')).toMatchObject({ sourceType: 'vision', state: 'INFERRED' });
    expect(f.find((a) => a.key === 'key_ingredients')).toMatchObject({ sourceType: 'vision', state: 'INFERRED' });
  });

  it('a label size that disagrees with the page is disputed once recorded', async () => {
    const { t, ctx, skuId } = await sku();
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'size', valueText: '30 ml', sourceType: 'json_ld', state: 'OBSERVED' }]));
    const x = mockExtraction({ name: page.name, text: '', sizeText: '50 ml' });
    const r = await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, extractionFacts(x, page, null, 'job-3')));
    expect(r.disputes).toEqual(['size']);
    // The same label size as "1 fl oz" is not a dispute.
    const { t: t2, ctx: c2, skuId: s2 } = await sku();
    await withTenant(t2.workspaceId, (tx) => recordFacts(tx, c2, s2, [{ key: 'size', valueText: '30 ml', sourceType: 'json_ld', state: 'OBSERVED' }]));
    const r2 = await withTenant(t2.workspaceId, (tx) => recordFacts(tx, c2, s2, extractionFacts(mockExtraction({ name: page.name, text: '', sizeText: '1 fl oz' }), page, null, 'job-4')));
    expect(r2.disputes).toEqual([]);
  });
});

describe('merchant confirmation (§13, §16 merchant_confirmed)', () => {
  it('confirms the shown facts of this SKU only, once, and not for a viewer', async () => {
    const { t, ctx, skuId } = await sku();
    const other = await makeSku(t.workspaceId, 'Other');
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'size', valueText: '30 ml', sourceType: 'product_page', state: 'OBSERVED' }, { key: 'texture', valueText: 'gel', sourceType: 'vision', state: 'INFERRED' }]));
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, other, [{ key: 'size', valueText: '50 ml', sourceType: 'product_page', state: 'OBSERVED' }]));
    const ids = (await ownerPool()`select id, sku_id from product_facts where workspace_id = ${t.workspaceId}`).map((r) => ({ id: r.id as string, mine: r.sku_id === skuId }));
    const viewer = ctxFor(t.workspaceId, t.userId, 'VIEWER');
    await expect(withTenant(t.workspaceId, (tx) => confirmFacts(tx, viewer, skuId, ids.map((i) => i.id)))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const confirmed = await withTenant(t.workspaceId, (tx) => confirmFacts(tx, ctx, skuId, ids.map((i) => i.id)));
    expect(confirmed.sort()).toEqual(ids.filter((i) => i.mine).map((i) => i.id).sort());
    expect(await withTenant(t.workspaceId, (tx) => confirmFacts(tx, ctx, skuId, ids.map((i) => i.id)))).toEqual([]); // idempotent
    const flags = await ownerPool()`select sku_id, merchant_confirmed from product_facts where workspace_id = ${t.workspaceId}`;
    expect(flags.every((f) => f.merchant_confirmed === (f.sku_id === skuId))).toBe(true);
    const cur = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(cur.size!.value.merchantConfirmed).toBe(true);
    expect((await events(skuId, 'PRODUCT_FACT_CHANGED')).filter((e) => (e.payload as { confirmed?: boolean }).confirmed)).toHaveLength(2);
  });
});

describe('source precedence (standard §51 "unit tests for ... source precedence")', () => {
  it('a non-material key shows the highest-precedence source, whatever order the readings arrived in', async () => {
    const { t, ctx, skuId } = await sku();
    // texture is not material: disagreeing sources are kept without a dispute, and precedence decides what shows.
    const order = [
      { key: 'texture', valueText: 'gel', sourceType: 'vision' as const, sourceId: 'v', state: 'INFERRED' as const },
      { key: 'texture', valueText: 'light lotion', sourceType: 'shopify' as const, sourceId: 's', state: 'OBSERVED' as const },
      { key: 'texture', valueText: 'watery serum', sourceType: 'product_page' as const, sourceId: 'p', state: 'OBSERVED' as const },
    ];
    for (const f of order) await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [f]));
    let facts = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(facts.texture!.value.valueText).toBe('light lotion'); // shopify (80) > product_page (50) > vision (30)
    expect(await events(skuId, 'PRODUCT_CONFLICT_DETECTED')).toHaveLength(0);
    // The merchant's own decision outranks every source.
    await withTenant(t.workspaceId, (tx) => decideFact(tx, ctx, skuId, 'texture', { text: 'silky gel-cream' }));
    facts = await withTenant(t.workspaceId, (tx) => currentFacts(tx, skuId));
    expect(facts.texture!.value.valueText).toBe('silky gel-cream');
  });
});
