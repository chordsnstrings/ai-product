import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { SHOPIFY_DEMO_SHOP } from '@arkiv/integrations';
import { PROVISIONAL } from '@arkiv/shared';
import { listShopifyProductsForPick, pickShopifyProduct, saveIntegration, syncIntegration } from './performance';
import type { TenantContext } from './context';

/** "Connect Shopify" from the upload step (standard §13, plan 03 P2), against the mock-mode demo store. */
beforeEach(truncateAll);
afterAll(closeAll);

async function provisionalWithStore() {
  const t = await makeTenant({ state: 'PROVISIONAL' });
  const ctx: TenantContext = { workspaceId: t.workspaceId, workspaceState: 'PROVISIONAL', role: 'OWNER', actor: { kind: 'provisional', id: t.workspaceId }, requestId: 'test' };
  const integrationId = await withTenant(t.workspaceId, (tx) => saveIntegration(tx, ctx, { provider: 'shopify', externalAccountId: SHOPIFY_DEMO_SHOP, displayName: SHOPIFY_DEMO_SHOP, token: 'demo-shop-token', scopes: ['read_products'] }));
  return { t, ctx, integrationId };
}

describe('Shopify from the upload step', () => {
  it('an unsaved preview never imports the catalogue: the visitor picks one product, previewed like a link import', async () => {
    const { t, ctx, integrationId } = await provisionalWithStore();
    // The connection's first sync runs, but imports no products into a provisional workspace.
    await syncIntegration(ctx, integrationId, { full: true });
    expect(await ownerPool()`select 1 from skus where workspace_id = ${t.workspaceId}`).toHaveLength(0);

    const store = await listShopifyProductsForPick(ctx);
    expect(store!.shop).toBe(SHOPIFY_DEMO_SHOP);
    expect(store!.products.map((p) => p.title)).toContain('Dew Drop Hydrating Serum');
    const serum = store!.products.find((p) => p.title === 'Dew Drop Hydrating Serum')!;
    expect(serum.priceMicros).toBe(34_000_000);

    const r = await pickShopifyProduct(ctx, serum.id, { visitorId: 'visitor-1' });
    const [sku] = await ownerPool()`select source_kind, shopify_product_id, status, origin_visitor_id from skus where id = ${r.skuId}`;
    expect(sku).toMatchObject({ source_kind: 'shopify', shopify_product_id: serum.id, status: 'analyzing', origin_visitor_id: 'visitor-1' });
    const [p] = await ownerPool()`select kind, state, sku_id from projects where id = ${r.projectId}`;
    expect(p).toMatchObject({ kind: 'preview', state: 'PRODUCT_UPLOADED', sku_id: r.skuId });
    // Store facts are observed from Shopify (with provenance), and the analysis is queued.
    const [price] = await ownerPool()`select value_number, source_type, state from product_facts where sku_id = ${r.skuId} and normalized_key = 'price'`;
    expect(price).toMatchObject({ source_type: 'shopify', state: 'OBSERVED' });
    expect(Number(price!.value_number)).toBe(34);
    expect(await ownerPool()`select 1 from outbox where queue like 'analyze-product%' and payload->>'projectId' = ${r.projectId}`).toHaveLength(1);
    // Picking the same product again opens the same preview.
    expect(await pickShopifyProduct(ctx, serum.id)).toEqual(r);
  }, 60_000);

  it('respects the preview product cap and stays in its own workspace', async () => {
    const { t, ctx } = await provisionalWithStore();
    const store = await listShopifyProductsForPick(ctx);
    const next = store!.products.find((p) => p.title === 'Gentle Milk Cleanser')!;
    // The preview is already at its product cap (two store picks plus a photo upload, say).
    for (const p of store!.products.filter((x) => x.id !== next.id).slice(0, PROVISIONAL.MAX_SKUS - 1)) await pickShopifyProduct(ctx, p.id);
    await ownerPool()`insert into skus (workspace_id, catalogue_no, name, status, source_kind) values (${t.workspaceId}, 99, 'Other', 'active', 'photos')`;
    await expect(pickShopifyProduct(ctx, next.id)).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED', details: { needsAccount: true } });
    // Another workspace has no store to pick from.
    const other = await makeTenant({ state: 'PROVISIONAL' });
    const octx: TenantContext = { workspaceId: other.workspaceId, workspaceState: 'PROVISIONAL', role: 'OWNER', actor: { kind: 'provisional', id: other.workspaceId }, requestId: 'test' };
    expect(await listShopifyProductsForPick(octx)).toBeNull();
    await expect(pickShopifyProduct(octx, next.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);
});
