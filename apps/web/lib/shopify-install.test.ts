import { describe, expect, it } from 'vitest';
import { hmacHex, signState } from '@arkiv/integrations';
import { acceptShopifyLaunch, launchedShop, SHOPIFY_INSTALL_COOKIE } from './shopify-install';

const { GET } = await import('../app/api/integrations/[provider]/install/route');

/** Shopify signs its app-URL query like an OAuth callback: hex HMAC of the sorted params (the dev secret in tests). */
function launch(q: Record<string, string>) {
  const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&');
  return { ...q, hmac: hmacHex('dev', msg) };
}
const now = () => String(Math.floor(Date.now() / 1000));

describe('installs started from Shopify (plan 06 Phase 5 #1)', () => {
  it('accepts a signed, recent launch for a myshopify.com shop', () => {
    const r = acceptShopifyLaunch(launch({ shop: 'glow.myshopify.com', timestamp: now(), host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZ2xvdw' }));
    expect(r).toMatchObject({ shop: 'glow.myshopify.com', next: '/connect/shopify?shop=glow.myshopify.com' });
    expect(launchedShop(r!.cookie, 'glow.myshopify.com')).toBe('glow.myshopify.com');
  });

  it('rejects a bad HMAC, an old or future timestamp and a shop outside myshopify.com', () => {
    const good = launch({ shop: 'glow.myshopify.com', timestamp: now() });
    expect(acceptShopifyLaunch({ ...good, hmac: '0'.repeat(64) })).toBeNull();
    expect(acceptShopifyLaunch({ ...good, shop: 'other.myshopify.com' })).toBeNull(); // HMAC no longer matches
    expect(acceptShopifyLaunch(launch({ shop: 'glow.myshopify.com', timestamp: String(Math.floor(Date.now() / 1000) - 301) }))).toBeNull();
    expect(acceptShopifyLaunch(launch({ shop: 'glow.myshopify.com', timestamp: String(Math.floor(Date.now() / 1000) + 3600) }))).toBeNull();
    expect(acceptShopifyLaunch(launch({ shop: 'evil.example.com', timestamp: now() }))).toBeNull();
  });

  it('binds the choice page to the launched shop: another shop, a forged or an OAuth state cookie is refused', () => {
    const r = acceptShopifyLaunch(launch({ shop: 'glow.myshopify.com', timestamp: now() }))!;
    expect(launchedShop(r.cookie, 'other.myshopify.com')).toBeNull();
    expect(launchedShop(`${r.cookie.slice(0, -2)}xx`, 'glow.myshopify.com')).toBeNull();
    expect(launchedShop(signState({ ws: 'w', uid: 'u', slug: 's', provider: 'shopify', shop: 'glow.myshopify.com' }), 'glow.myshopify.com')).toBeNull();
    expect(launchedShop(null, 'glow.myshopify.com')).toBeNull();
  });

  it('the app URL sets the launch cookie and sends the merchant on; anything else goes to the retry page', async () => {
    const q = new URLSearchParams(launch({ shop: 'glow.myshopify.com', timestamp: now() }));
    const ok = await GET(new Request(`http://localhost/api/integrations/shopify/install?${q}`), { params: Promise.resolve({ provider: 'shopify' }) });
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get('location')!).pathname + new URL(ok.headers.get('location')!).search).toBe('/connect/shopify?shop=glow.myshopify.com');
    const set = ok.headers.get('set-cookie') ?? '';
    expect(set).toContain(`${SHOPIFY_INSTALL_COOKIE}=`);
    expect(set.toLowerCase()).toContain('httponly');
    q.set('hmac', 'f'.repeat(64));
    const bad = await GET(new Request(`http://localhost/api/integrations/shopify/install?${q}`), { params: Promise.resolve({ provider: 'shopify' }) });
    expect(bad.headers.get('location')).toMatch(/\/connect\/shopify\?error=invalid$/);
    expect(bad.headers.get('set-cookie')).toBeNull();
    expect((await GET(new Request('http://localhost/api/integrations/meta/install'), { params: Promise.resolve({ provider: 'meta' }) })).status).toBe(404);
  });
});
