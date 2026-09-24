import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { listShopifyProductsForPick } from '@arkiv/core';
import { Banner, LinkButton } from '@arkiv/ui';
import { previewContext } from '@/lib/preview-context';
import { ShopifyPicker } from '@/components/shopify-picker';

export const metadata: Metadata = { title: 'Pick a product · Arkiv', robots: { index: false } };

/**
 * After "Connect Shopify" on the upload step (plan 03 P2): the store's products, to pick the one to preview. Only
 * the visitor's own preview (or signed-in workspace) is read.
 */
export default async function Page() {
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  let store: Awaited<ReturnType<typeof listShopifyProductsForPick>> = null;
  let error: string | null = null;
  try {
    const ctx = await previewContext({ ip, userAgent: h.get('user-agent'), acceptLanguage: h.get('accept-language'), asn: h.get('x-client-asn') }, { create: false });
    store = await listShopifyProductsForPick(ctx);
  } catch (e) {
    error = e instanceof Error ? e.message : 'We couldn’t read your store just now.';
  }
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 720 }}>
      <h1 className="ak-h1">Which product should we start with?</h1>
      {store ? <p className="ak-body-l ak-muted">From {store.shop}. We read its details from your store — nothing is changed there.</p> : null}
      {error || !store ? (
        <div className="ak-stack">
          <Banner tone="warn">{error && !/not found/i.test(error) ? error : 'Your store isn’t connected in this browser yet.'}</Banner>
          <div><LinkButton href="/start" variant="secondary">Back</LinkButton></div>
        </div>
      ) : store.products.length ? (
        <ShopifyPicker products={store.products} />
      ) : (
        <Banner>No active products in this store yet. Paste a product link or add a photo instead.</Banner>
      )}
    </div>
  );
}
