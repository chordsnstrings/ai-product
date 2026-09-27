import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@arkiv/shared';
import { liveTokenRevoker, META_API, metaRevoke, shopifyRevoke, TIKTOK_API, tiktokRevoke } from './connectors';

/** Token revocation at each platform (plan 02 §7 purge step 1), with the platform's HTTP answered by a stub. */
type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
function stub(answer: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: (init.body as string | undefined) ?? null };
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TIKTOK_APP_ID;
  delete process.env.TIKTOK_APP_SECRET;
  resetEnvCache();
});

describe('platform token revocation', () => {
  it('Shopify: deletes the app’s API permission for the shop; an already-dead token counts as revoked', async () => {
    const calls = stub(() => ({ status: 200, body: {} }));
    await shopifyRevoke('glow.myshopify.com', 'shpat_1');
    expect(calls[0]).toMatchObject({ url: 'https://glow.myshopify.com/admin/api_permissions/current.json', method: 'DELETE', headers: { 'X-Shopify-Access-Token': 'shpat_1' } });
    stub(() => ({ status: 401, body: { errors: 'Invalid API key or access token' } }));
    await expect(shopifyRevoke('glow.myshopify.com', 'shpat_1')).resolves.toBeUndefined();
    stub(() => ({ status: 503, body: {} }));
    await expect(shopifyRevoke('glow.myshopify.com', 'shpat_1')).rejects.toMatchObject({ kind: 'network' });
  });

  it('Meta: DELETE /me/permissions; error 190 (already invalid) counts as revoked', async () => {
    const calls = stub(() => ({ status: 200, body: { success: true } }));
    await metaRevoke('EAAB');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${META_API}/me/permissions?access_token=EAAB`);
    stub(() => ({ status: 400, body: { error: { code: 190, message: 'Error validating access token' } } }));
    await expect(metaRevoke('EAAB')).resolves.toBeUndefined();
    stub(() => ({ status: 500, body: { error: { code: 2, message: 'Service temporarily unavailable', is_transient: true } } }));
    await expect(metaRevoke('EAAB')).rejects.toThrow(/revoke failed/);
  });

  it('TikTok: revoke_token with the app credentials; a revoked-token code counts as revoked', async () => {
    process.env.TIKTOK_APP_ID = 'app-1';
    process.env.TIKTOK_APP_SECRET = 'sec-1';
    resetEnvCache();
    const calls = stub(() => ({ status: 200, body: { code: 0, message: 'OK' } }));
    await tiktokRevoke('tt-token');
    expect(calls[0]).toMatchObject({ url: `${TIKTOK_API}/oauth2/revoke_token/`, method: 'POST' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ app_id: 'app-1', secret: 'sec-1', access_token: 'tt-token' });
    stub(() => ({ status: 200, body: { code: 40105, message: 'access token is invalid' } }));
    await expect(tiktokRevoke('tt-token')).resolves.toBeUndefined();
    stub(() => ({ status: 200, body: { code: 50002, message: 'system error' } }));
    await expect(tiktokRevoke('tt-token')).rejects.toThrow(/revoke failed/);
  });

  it('the live revoker routes by provider (the shop is the Shopify account)', async () => {
    const calls = stub((c) => ({ status: 200, body: c.url.includes('tiktok') ? { code: 0 } : { success: true } }));
    await liveTokenRevoker.revoke('shopify', 's', 'calm.myshopify.com');
    await liveTokenRevoker.revoke('meta', 'm', 'act_1');
    await liveTokenRevoker.revoke('tiktok', 't', '7001');
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['calm.myshopify.com', 'graph.facebook.com', 'business-api.tiktok.com']);
  });
});
