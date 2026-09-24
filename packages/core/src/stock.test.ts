import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { generateRecommendations } from './recommendations';
import { recordVariants } from './sku-variants';
import { assertStockCleared, refreshStock, setStockIntent, stockState } from './stock';
import { ctxFor } from './testing';

/** Standard §42 "Out of stock": flag before offer/production; waitlist/launch only if the merchant intends it. */
beforeEach(truncateAll);
afterAll(closeAll);

const variant = (id: string, available: boolean | undefined) => ({ externalId: id, title: `Size ${id}`, available });

describe('stock (§42)', () => {
  it('follows the store: out when no variant can be bought, back in when one can; unknown is never out', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const skuId = await makeSku(t.workspaceId);
    await withTenant(t.workspaceId, async (tx) => {
      await recordVariants(tx, ctx, skuId, 'shopify', [variant('a', undefined)]);
      expect(await stockState(tx, skuId)).toEqual({ inStock: null, intent: null, needsIntent: false });
      await recordVariants(tx, ctx, skuId, 'shopify', [variant('a', false), variant('b', false)]);
      expect(await stockState(tx, skuId)).toMatchObject({ inStock: false, needsIntent: true });
      await expect(assertStockCleared(tx, skuId)).rejects.toMatchObject({ code: 'CONFLICT', details: { outOfStock: true } });
      // The merchant says the ad is for a waitlist: production may go ahead.
      expect(await setStockIntent(tx, ctx, skuId, 'waitlist')).toEqual({ inStock: false, intent: 'waitlist', needsIntent: false });
      await assertStockCleared(tx, skuId);
      // Restocked: the intent lapses, and can't be set on an in-stock product.
      await recordVariants(tx, ctx, skuId, 'shopify', [variant('a', false), variant('b', true)]);
      expect(await stockState(tx, skuId)).toEqual({ inStock: true, intent: null, needsIntent: false });
      await expect(setStockIntent(tx, ctx, skuId, 'launch')).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  it('without variants, the page’s own availability decides', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await withTenant(t.workspaceId, async (tx) => {
      expect(await refreshStock(tx, ctx, skuId, null)).toBeNull();
      expect(await refreshStock(tx, ctx, skuId, false)).toBe(false);
      expect((await stockState(tx, skuId)).needsIntent).toBe(true);
    });
    // Viewers can't state an intent.
    await expect(withTenant(t.workspaceId, (tx) => setStockIntent(tx, ctxFor(t.workspaceId, t.userId, 'VIEWER'), skuId, 'launch'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('recommendations wait for an out-of-stock product until the merchant states an intent', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const skuId = await makeSku(t.workspaceId);
    await withTenant(t.workspaceId, (tx) => refreshStock(tx, ctx, skuId, false));
    expect(await generateRecommendations(ctx, skuId, '2026-09-21')).toBe(0);
    expect(await ownerPool()`select 1 from provider_jobs where workspace_id = ${t.workspaceId}`).toHaveLength(0); // nothing was spent
    await withTenant(t.workspaceId, (tx) => setStockIntent(tx, ctx, skuId, 'launch'));
    expect(await generateRecommendations(ctx, skuId, '2026-09-21')).toBeGreaterThan(0);
  }, 60_000);
});
