import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import type { LlmJsonRequest, LlmProvider } from '@arkiv/providers';
import { analyzeProduct, extractionScopeText, productScopeText, startPreview } from './analysis';
import { excludedProductReason, nonSkincareCategory } from './compliance';
import { parseProductHtml } from './ingest';
import type { ProductExtraction } from './intel-schemas';
import { mockExtraction } from './mock-intel';
import { ctxFor, MockImage, MockLlm, MockTts, MockVideo, productPhoto, setProviders } from './testing';
import { ingestBytes } from './uploads';

beforeEach(truncateAll);
afterEach(() => setProviders(undefined));
afterAll(closeAll);

const page = (product: Record<string, unknown>, nav = '') => `<!doctype html><html><head><title>${product.name} | Lumen</title>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', offers: { price: '38.00', priceCurrency: 'USD' }, ...product })}</script>
</head><body><header><nav>${nav}</nav></header><main><h1>${product.name}</h1><p>${product.description}</p></main>
<footer>Shop all: Cleansers · Serums · Sunscreen SPF 50 · Candles · Hair oil</footer></body></html>`;

describe('scope checks read the advertised product, not the page chrome (§1, plan 03 P2)', () => {
  it('a serum page whose menu and footer list Sunscreen/SPF and candles is in scope', () => {
    const p = parseProductHtml(page({ name: 'Glow Serum No. 3', description: 'A lightweight niacinamide serum for daily use.' }, '<a href="/c/spf">Sunscreen</a> <a href="/c/spf">SPF</a> <a href="/c/candles">Candles</a>'), 'https://lumen.example/products/glow');
    expect(p.rawText).toMatch(/Sunscreen/); // the chrome is on the page…
    expect(excludedProductReason(productScopeText(p))).toBeNull(); // …but not in the product's own words
    expect(nonSkincareCategory(productScopeText(p))).toBeNull();
  });

  it('a real SPF product, and an OTC acne product by its ingredients, are excluded', () => {
    const spf = parseProductHtml(page({ name: 'Daily Defense Moisturiser SPF 30', description: 'Broad spectrum protection.' }), 'https://lumen.example/products/dd');
    expect(excludedProductReason(productScopeText(spf))).toMatch(/Sunscreen/);
    const acne = productScopeText({ name: 'Clear Gel', description: 'A spot gel.', ingredients: 'Benzoyl Peroxide 5%, Water' });
    expect(excludedProductReason(acne)).toMatch(/OTC drug/);
    const typed = productScopeText({ name: 'Everyday Fluid', productType: 'Sunscreen' });
    expect(excludedProductReason(typed)).toMatch(/Sunscreen/);
  });

  it('the store category from JSON-LD and Shopify is captured for the check', () => {
    expect(parseProductHtml(page({ name: 'Everyday Fluid', description: 'Light fluid.', category: 'Sunscreen' }), 'https://x.example/p').productType).toBe('Sunscreen');
  });

  it('the post-extraction check reads the label and the brand’s claims', () => {
    const x = { ...mockExtraction({ text: '' }), name: 'Daily Fluid', labelText: 'DAILY FLUID SPF 30 BROAD SPECTRUM' };
    expect(excludedProductReason(extractionScopeText(x))).toMatch(/Sunscreen/);
    expect(mockExtraction({ text: '', labelText: 'Drug Facts Active ingredient: Adapalene 0.1%' }).category).toBe('drug_or_sunscreen');
    // The mock never flags a product from the page's menus.
    expect(mockExtraction({ name: 'Glow Serum', text: 'Shop Sunscreen SPF 50' }).category).toBe('serum');
  });
});

/** The vision model reads the label of a photo-only upload as the given text. */
class LabelReads implements LlmProvider {
  readonly name = 'anthropic';
  private mock = new MockLlm();
  constructor(private label: string, private category?: ProductExtraction['category']) {}
  async json<T>(req: LlmJsonRequest<T>) {
    if (!req.system.includes('product analyst')) return this.mock.json(req);
    const x = mockExtraction({ text: '', labelText: this.label });
    return this.mock.json({ ...req, mock: () => ({ ...x, name: 'Daily Fluid', ...(this.category ? { category: this.category } : {}) }) as T });
  }
}

async function photoOnly(label: string, category?: ProductExtraction['category']) {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  setProviders({ llm: new LabelReads(label, category), image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
  return { t, ctx, skuId, projectId };
}

describe('photo-only uploads are held to the same scope (§1 sunscreen/SPF and OTC drugs)', () => {
  it('a label reading "SPF 30" is rejected after extraction, before any concepts, with the spend settled', async () => {
    const { ctx, skuId, projectId } = await photoOnly('Daily Fluid SPF 30 Broad Spectrum Sunscreen');
    const r = await analyzeProduct(ctx, skuId, projectId);
    expect(r.status).toBe('rejected');
    expect(r.reason).toMatch(/Sunscreen/);
    const [s] = await ownerPool()`select status, reject_reason from skus where id = ${skuId}`;
    expect(s).toMatchObject({ status: 'rejected' });
    const [p] = await ownerPool()`select state from projects where id = ${projectId}`;
    expect(p!.state).toBe('BLOCKED_COMPLIANCE');
    expect(await ownerPool()`select 1 from concepts where project_id = ${projectId}`).toHaveLength(0);
    const [auth] = await ownerPool()`select status from cost_authorizations where idempotency_key = ${`preview:${skuId}`}`;
    expect(auth!.status).toBe('settled');
    expect(await ownerPool()`select 1 from funnel_events where type = 'SKU_REJECTED' and workspace_id = ${ctx.workspaceId}`).toHaveLength(1);
  }, 60_000);

  it('the model’s own drug/sunscreen category rejects too, with a customer-safe reason', async () => {
    const { ctx, skuId, projectId } = await photoOnly('LUMEN Clear', 'drug_or_sunscreen');
    const r = await analyzeProduct(ctx, skuId, projectId);
    expect(r).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/Sunscreen, SPF and OTC drug/) });
  }, 60_000);

  it('an ordinary cosmetic label goes through', async () => {
    const { ctx, skuId, projectId } = await photoOnly('Daily Fluid lightweight moisturiser 50 ml');
    expect((await analyzeProduct(ctx, skuId, projectId)).status).toBe('ready');
  }, 60_000);
});
