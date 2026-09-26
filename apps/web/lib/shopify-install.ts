import { signState, verifyShopifyLaunch, verifyState } from '@arkiv/integrations';

/**
 * Installs that start in Shopify (App Store, or opening the app from the merchant's admin; plan 06 Phase 5 #1):
 * Shopify opens our app URL with a signed `shop`. The verified shop is kept in a short-lived signed cookie while the
 * merchant signs in and chooses the workspace it belongs to; only then is the usual OAuth started, with a state bound
 * to that workspace and user.
 */
export const SHOPIFY_INSTALL_COOKIE = 'arkiv_shopify_install';
/** The cookie lives as long as the signed value inside it (15 minutes). */
export const SHOPIFY_INSTALL_TTL_S = 15 * 60;

/** Where a verified launch continues: sign in (if needed), then pick a workspace. */
export const connectShopifyPath = (shop: string) => `/connect/shopify?${new URLSearchParams({ shop })}`;

/**
 * The launch request → the cookie value to set and where to go next, or null when it isn't a genuine, recent
 * launch from Shopify (bad HMAC, not a myshopify.com shop, or older than 5 minutes).
 */
export function acceptShopifyLaunch(query: Record<string, string>, now = Date.now()): { cookie: string; next: string; shop: string } | null {
  const ok = verifyShopifyLaunch(query, now);
  if (!ok) return null;
  return { cookie: signState({ purpose: 'shopify_install', shop: ok.shop }), next: connectShopifyPath(ok.shop), shop: ok.shop };
}

/**
 * The shop a launch cookie vouches for, when it names the shop being connected. A different or missing shop means
 * the page was not reached from Shopify (or the cookie expired): the merchant starts again from their admin.
 */
export function launchedShop(cookie: string | null | undefined, shop: string | null | undefined): string | null {
  if (!cookie || !shop) return null;
  const s = verifyState(cookie);
  if (!s || s.purpose !== 'shopify_install' || s.shop !== shop.toLowerCase()) return null;
  return s.shop;
}
