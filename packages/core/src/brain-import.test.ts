import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';

/**
 * Link imports end to end without the network: the page reader returns fixture pages parsed by the real parser
 * (the SSRF-guarded fetch itself is covered in ingest.test.ts).
 */
vi.mock('./ingest', async (orig) => {
  const m = await orig<typeof import('./ingest')>();
  return { ...m, importProductUrl: vi.fn() };
});

const ingest = await import('./ingest');
const { analyzeProduct, chooseProduct, resolveDuplicate, startPreview, CHOOSE_PRODUCT_COPY } = await import('./analysis');
const { ctxFor, productPhoto } = await import('./testing');
const { ingestBytes } = await import('./uploads');

const fixture = (name: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/pages', name), 'utf8');
const productPage = (name: string, extra = '', gtin: string | null = '0123456789012') =>
  `<!doctype html><html><head><title>${name} | Lumen</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name, description: `A lightweight niacinamide serum. Skin feels hydrated. 30 ml. ${extra}`, ...(gtin ? { gtin13: gtin } : {}), offers: { price: '38.00', priceCurrency: 'USD' } })}</script></head><body><h1>${name}</h1></body></html>`;

/** url → page html; each import is hashed like the real reader does. */
const pages = new Map<string, string>();
vi.mocked(ingest.importProductUrl).mockImplementation(async (url: string) => {
  const html = pages.get(url);
  if (!html) throw new Error(`no fixture for ${url}`);
  return { ...ingest.parseProductHtml(html, url), contentHash: 'f'.repeat(64) };
});

beforeEach(async () => {
  pages.clear();
  await truncateAll();
});
afterAll(closeAll);

async function importLink(t: Awaited<ReturnType<typeof makeTenant>>, url: string) {
  const ctx = ctxFor(t.workspaceId, t.userId);
  const photo = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  return { ctx, ...(await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { url, photoAssetIds: [photo.id] }))) };
}

describe('"Which product?" on a collection or home page (plan 03 P2)', () => {
  it('asks before spending anything, accepts only a listed same-site product, and reads that product', async () => {
    const t = await makeTenant();
    pages.set('https://lumen.example/collections/serums', fixture('collection.html'));
    const chosen = 'https://lumen.example/collections/serums/products/glow-serum';
    pages.set(chosen, productPage('Glow Serum No. 3'));
    const { ctx, skuId, projectId } = await importLink(t, 'https://lumen.example/collections/serums');
    expect(await analyzeProduct(ctx, skuId, projectId)).toEqual({ status: 'needs_input', reason: 'choose_product' });
    const [s] = await ownerPool()`select s.status, s.name, s.analysis, p.state, p.failure_reason from skus s join projects p on p.sku_id = s.id where s.id = ${skuId}`;
    expect(s).toMatchObject({ status: 'needs_input', state: 'NEEDS_USER_ACTION', failure_reason: CHOOSE_PRODUCT_COPY, name: 'Reading your product…' });
    expect((s!.analysis as { productChoices: { url: string }[] }).productChoices.map((c) => c.url)).toContain(chosen);
    // Nothing read from the listing became this product's truth, and nothing was authorised.
    expect((await ownerPool()`select count(*)::int as n from product_facts where sku_id = ${skuId}`)[0]!.n).toBe(0);
    expect((await ownerPool()`select count(*)::int as n from cost_authorizations where project_id = ${projectId}`)[0]!.n).toBe(0);

    await expect(withTenant(t.workspaceId, (tx) => chooseProduct(tx, ctx, projectId, 'https://other-store.example/products/copycat'))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(withTenant(t.workspaceId, (tx) => chooseProduct(tx, ctx, projectId, 'https://lumen.example/products/not-listed'))).rejects.toMatchObject({ code: 'INVALID' });
    await withTenant(t.workspaceId, (tx) => chooseProduct(tx, ctx, projectId, chosen));
    await expect(withTenant(t.workspaceId, (tx) => chooseProduct(tx, ctx, projectId, chosen))).rejects.toMatchObject({ code: 'CONFLICT' });
    const [after] = await ownerPool()`select source_url, status, analysis from skus where id = ${skuId}`;
    expect(after).toMatchObject({ source_url: chosen, status: 'analyzing' });
    expect((after!.analysis as { productChoices?: unknown }).productChoices).toBeUndefined();

    expect((await analyzeProduct(ctx, skuId, projectId)).status).toBe('ready');
    expect((await ownerPool()`select name from skus where id = ${skuId}`)[0]!.name).toBe('Glow Serum No. 3');
  }, 60_000);
});

describe('duplicate imports (§42 "offer merge rather than creating competing Product Brains")', () => {
  it('pauses a second import of the same product; "keep" adds it as new, "merge" folds it into the first', async () => {
    const t = await makeTenant();
    const url = 'https://lumen.example/products/glow-serum';
    pages.set(url, productPage('Glow Serum'));
    pages.set(`${url}?utm_source=ig`, productPage('Glow Serum', '', null));
    const first = await importLink(t, url);
    expect((await analyzeProduct(first.ctx, first.skuId, first.projectId)).status).toBe('ready');

    // The same link (tracking parameters aside): asked before any spend.
    const second = await importLink(t, `${url}?utm_source=ig`);
    expect(await analyzeProduct(second.ctx, second.skuId, second.projectId)).toEqual({ status: 'needs_input', reason: 'possible_duplicate' });
    const [s2] = await ownerPool()`select analysis from skus where id = ${second.skuId}`;
    expect((s2!.analysis as { duplicate: unknown }).duplicate).toMatchObject({ skuId: first.skuId, catalogueNo: 1, reason: 'link' });
    expect((await ownerPool()`select count(*)::int as n from cost_authorizations where project_id = ${second.projectId}`)[0]!.n).toBe(0);
    await withTenant(t.workspaceId, (tx) => resolveDuplicate(tx, second.ctx, second.projectId, 'keep'));
    await expect(withTenant(t.workspaceId, (tx) => resolveDuplicate(tx, second.ctx, second.projectId, 'merge'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await analyzeProduct(second.ctx, second.skuId, second.projectId)).status).toBe('ready');

    // A third import matches by barcode too; this time it is merged.
    const other = 'https://lumen.example/products/glow-serum-refill';
    pages.set(other, productPage('Glow Serum', 'Refill.'));
    const third = await importLink(t, other);
    expect(await analyzeProduct(third.ctx, third.skuId, third.projectId)).toEqual({ status: 'needs_input', reason: 'possible_duplicate' });
    const [s3] = await ownerPool()`select analysis from skus where id = ${third.skuId}`;
    expect((s3!.analysis as { duplicate: { reason: string } }).duplicate.reason).toBe('barcode');
    const r = await withTenant(t.workspaceId, (tx) => resolveDuplicate(tx, third.ctx, third.projectId, 'merge'));
    expect(r).toMatchObject({ skuId: third.skuId, mergedInto: first.skuId });
    const [gone] = await ownerPool()`select s.status, s.analysis, p.state from skus s join projects p on p.sku_id = s.id where s.id = ${third.skuId}`;
    expect(gone).toMatchObject({ status: 'archived', state: 'CANCELLED' });
    expect((gone!.analysis as { mergedInto: string }).mergedInto).toBe(first.skuId);
    // Its observations and photos now belong to the first product; its facts are new observations, not overwrites.
    const photos = await ownerPool()`select count(*)::int as n from assets where sku_id = ${first.skuId} and kind = 'product_photo'`;
    expect(photos[0]!.n).toBe(2);
    const fps = await ownerPool()`select reason, reference_asset_ids from visual_fingerprints where sku_id = ${first.skuId} and active`;
    expect(fps[0]!.reason).toBe('merged');
    expect((fps[0]!.reference_asset_ids as string[]).length).toBe(2);
    const ev = await ownerPool()`select subject_id, payload from events where type = 'SKU_MERGED'`;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ subject_id: third.skuId, payload: { into: first.skuId } });
  }, 120_000);
});

describe('prompt injection through the whole analysis (plan 06 Phase 1)', () => {
  it('page text telling the analyst to approve claims changes no claim status and no spend', async () => {
    const t = await makeTenant();
    const url = 'https://lumen.example/products/glow';
    pages.set(url, fixture('injection.html'));
    const { ctx, skuId, projectId } = await importLink(t, url);
    expect((await analyzeProduct(ctx, skuId, projectId)).status).toBe('ready');
    const claims = await ownerPool()`select preferred_wording, status from claims where sku_id = ${skuId}`;
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.filter((c) => ['VERIFIED', 'VERIFIED_WITH_QUALIFIER'].includes(c.status as string))).toEqual([]);
    expect(claims.find((c) => /acne/i.test(c.preferred_wording as string))?.status).toMatch(/BLOCKED|RESTRICTED/);
    const [spend] = await ownerPool()`select coalesce(sum(spent_micros), 0)::bigint as n from cost_authorizations where project_id = ${projectId}`;
    expect(Number(spend!.n)).toBeLessThanOrEqual(200_000);
    // Structured page facts carry the hash of the page they were read from (§15).
    const facts = await ownerPool()`select source_id from product_facts where sku_id = ${skuId} and source_type = 'json_ld'`;
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.source_id === `sha256:${'f'.repeat(64)}`)).toBe(true);
    // The attempt is recorded for trust & safety.
    expect((await ownerPool()`select count(*)::int as n from abuse_signals where workspace_id = ${t.workspaceId}`)[0]!.n).toBeGreaterThan(0);
  }, 60_000);
});
