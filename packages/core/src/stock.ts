import type { Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { issueTasteOffer } from './offers';

/**
 * Stock (standard §42 "Out of stock: flag before offer/production; recommendations can focus on waitlist/launch
 * only if merchant intends"). A SKU is out of stock when the store says so: every variant it sells is unavailable
 * (store sync, product JSON), or — without variants — the product page's own availability. Unknown is not out.
 * Production of an out-of-stock SKU waits until the merchant says the ad is for a waitlist or a launch; with that
 * intent, recommendations focus on it. The intent lapses when the product is back in stock.
 */

export const STOCK_INTENTS = ['waitlist', 'launch'] as const;
export type StockIntent = (typeof STOCK_INTENTS)[number];

export interface StockState {
  inStock: boolean | null;
  intent: StockIntent | null;
  /** Out of stock with no stated intent: production and recommendations wait for the merchant. */
  needsIntent: boolean;
}

export const OUT_OF_STOCK_COPY = 'This product is out of stock at your store, so an ad can’t sell it right now. If the ad is for a waitlist or a relaunch, say so on the product page and we’ll produce it for that.';

export async function stockState(tx: Tx, skuId: string): Promise<StockState> {
  const [s] = await tx`select in_stock, stock_intent from skus where id = ${skuId}`;
  const inStock = (s?.in_stock as boolean | null) ?? null;
  const intent = (s?.stock_intent as StockIntent | null) ?? null;
  return { inStock, intent, needsIntent: inStock === false && !intent };
}

/** Refuse production (checkout, test approval) of an out-of-stock SKU the merchant hasn't said is for a waitlist or launch. */
export async function assertStockCleared(tx: Tx, skuId: string): Promise<void> {
  if ((await stockState(tx, skuId)).needsIntent) throw new DomainError('CONFLICT', OUT_OF_STOCK_COPY, { outOfStock: true, skuId });
}

/**
 * Recompute a SKU's stock from its variants' availability (the store's current catalogue), else from the page's
 * own availability (`fallback`). Called whenever variants or the page are read. A restock clears the intent.
 * Returns the new value.
 */
export async function refreshStock(tx: Tx, ctx: Pick<TenantContext, 'workspaceId'>, skuId: string, fallback: boolean | null = null): Promise<boolean | null> {
  const [v] = await tx`select count(*) filter (where available is not null)::int as known, count(*) filter (where available)::int as available
                       from sku_variants where sku_id = ${skuId} and workspace_id = ${ctx.workspaceId}`;
  const derived = Number(v!.known) > 0 ? Number(v!.available) > 0 : fallback;
  if (derived === null) return null;
  const [before] = await tx`select in_stock from skus where id = ${skuId} and workspace_id = ${ctx.workspaceId} for update`;
  if (!before || before.in_stock === derived) return derived;
  await tx`update skus set in_stock = ${derived}, stock_intent = case when ${derived} then null else stock_intent end
           where id = ${skuId} and workspace_id = ${ctx.workspaceId}`;
  return derived;
}

/** The merchant states what an ad for an out-of-stock product is for (or withdraws it). */
export async function setStockIntent(tx: Tx, ctx: TenantContext, skuId: string, intent: StockIntent | null): Promise<StockState> {
  assertCan(ctx, 'sku.edit');
  const [s] = await tx`select in_stock from skus where id = ${skuId} for update`;
  if (!s) throw new DomainError('NOT_FOUND', 'Product not found');
  if (intent && s.in_stock !== false) throw new DomainError('CONFLICT', 'This product is in stock: its ads sell it as usual.');
  await tx`update skus set stock_intent = ${intent} where id = ${skuId}`;
  // A storyboard held back from its intro offer (§42) gets it now: its window starts when the ad can be bought.
  if (intent) {
    const ready = await tx`select id from projects where sku_id = ${skuId} and state = 'STORYBOARD_READY' and kind = 'preview' order by created_at`;
    for (const p of ready) await issueTasteOffer(tx, ctx, p.id as string);
  }
  return stockState(tx, skuId);
}
