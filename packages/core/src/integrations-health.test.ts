import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withSystem } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { encryptToken, missingScopes, mockShopifyWebhooks, SHOPIFY_WEBHOOK_TOPICS } from '@arkiv/integrations';
import { env } from '@arkiv/shared';
import { apiVersionFlag, assertContractTestsPass, contractResultsByProvider, recordContractRun, upcomingSunsets, verifyShopifyWebhooks, type ApiVersionInfo } from './integrations-health';

beforeEach(truncateAll);
afterAll(closeAll);

async function shop(domain: string, status = 'active', token: string | null = 'shpat_x') {
  const t = await makeTenant();
  const [i] = await ownerPool()`insert into integrations (workspace_id, provider, external_account_id, status, scopes, token_enc)
                                values (${t.workspaceId}, 'shopify', ${domain}, ${status}, '{read_products}', ${token ? encryptToken(token) : null}) returning id`;
  await ownerPool()`insert into shopify_shops (shop_domain, workspace_id, integration_id) values (${domain}, ${t.workspaceId}, ${i!.id})`;
  return t.workspaceId;
}

describe('Shopify webhook verification (plan 05 §16)', () => {
  it('registers missing topics per shop, records health, and reports shops it cannot check', async () => {
    const address = `${env().APP_URL}/api/webhooks/shopify`;
    await shop('ok.myshopify.com');
    await shop('partial.myshopify.com');
    await shop('gone.myshopify.com', 'revoked', null);
    const client = mockShopifyWebhooks({
      'ok.myshopify.com': SHOPIFY_WEBHOOK_TOPICS.map((topic, i) => ({ id: `w${i}`, topic, address })),
      // One topic registered to an old address, one missing entirely.
      'partial.myshopify.com': [{ id: 'p1', topic: 'app/uninstalled', address }, { id: 'p2', topic: 'products/update', address: 'https://old.example/hooks' }],
    });
    expect(await verifyShopifyWebhooks(client)).toEqual({ shops: 3, healthy: 2, repaired: 1, failed: 1 });
    const rows = await ownerPool()`select shop_domain, webhooks_verified_at is not null as checked, webhook_health from shopify_shops order by shop_domain`;
    expect(rows).toMatchObject([
      { shop_domain: 'gone.myshopify.com', checked: true, webhook_health: { ok: false, error: expect.stringMatching(/revoked/) } },
      { shop_domain: 'ok.myshopify.com', checked: true, webhook_health: { ok: true, missing: [], repaired: [] } },
      { shop_domain: 'partial.myshopify.com', checked: true, webhook_health: { ok: true, missing: ['products/create', 'products/update', 'products/delete'], repaired: ['products/create', 'products/update', 'products/delete'] } },
    ]);
    expect((await client.list('partial.myshopify.com', 'shpat_x')).filter((w) => w.address === address).map((w) => w.topic).sort()).toEqual([...SHOPIFY_WEBHOOK_TOPICS].sort());
  });
});

describe('connector policy, API sunsets and the contract gate (plan 05 §16)', () => {
  it('reports requested scopes that were not granted', () => {
    expect(missingScopes('meta', [])).toEqual(['ads_read']);
    expect(missingScopes('meta', ['ads_read', 'business_management'])).toEqual([]);
    expect(missingScopes('tiktok', [])).toEqual([]);
  });

  it('lists versions whose sunset is within the banner window', () => {
    const v = (version: string, sunsetOn: string | null): ApiVersionInfo => ({ provider: 'meta', api: 'Meta', version, deprecatesOn: null, sunsetOn, notes: null });
    const now = new Date('2026-09-24T00:00:00Z');
    const r = upcomingSunsets([v('v22.0', '2026-09-01'), v('v23.0', '2026-11-01'), v('v24.0', '2027-06-01'), v('v25.0', null)], 60, now);
    expect(r.map((x) => [x.version, x.daysLeft])).toEqual([['v22.0', -23], ['v23.0', 38]]);
  });

  it('only lets an API-version flag be enabled after a recent passing contract run for that version', async () => {
    expect(apiVersionFlag('api.meta_version.v24_0')).toEqual({ provider: 'meta', version: 'v24_0' });
    expect(apiVersionFlag('kill.renders')).toBeNull();
    const gate = (key: string, enabling = true) => withAdmin((tx) => assertContractTestsPass(tx, key, enabling));
    await expect(gate('api.meta_version.v24_0')).rejects.toThrow(/No contract test run/);
    await expect(gate('api.meta_version.v24_0', false)).resolves.toBeUndefined();
    await expect(gate('kill.renders')).resolves.toBeUndefined();
    await withSystem((tx) => recordContractRun(tx, { provider: 'meta', apiVersion: 'v24.0', suite: 's', passed: true, total: 5, failed: 0 }));
    await expect(gate('api.meta_version.v24_0')).resolves.toBeUndefined();
    // A later failing run blocks again; a stale pass does not count.
    await withSystem((tx) => recordContractRun(tx, { provider: 'meta', apiVersion: 'v24.0', suite: 's', passed: false, total: 5, failed: 1 }));
    await expect(gate('api.meta_version.v24_0')).rejects.toThrow(/failed/);
    await ownerPool()`insert into contract_test_runs (provider, api_version, suite, passed, ran_at) values ('shopify', '2026-10', 's', true, now() - interval '40 days')`;
    await expect(gate('api.shopify_version.2026_10')).rejects.toThrow(/No contract test run/);
  });

  it('groups a vitest JSON report by platform', () => {
    const r = contractResultsByProvider({
      testResults: [
        {
          assertionResults: [
            { ancestorTitles: ['Meta insights normalization'], fullName: 'Meta insights normalization maps actions', status: 'passed' },
            { ancestorTitles: ['Meta insights normalization'], fullName: 'Meta insights normalization placement', status: 'failed' },
            { ancestorTitles: ['TikTok normalization'], fullName: 'TikTok normalization gmv max', status: 'passed' },
            { ancestorTitles: ['token encryption'], fullName: 'token encryption round trips', status: 'passed' },
          ],
        },
      ],
    });
    expect(r.get('meta')).toEqual({ total: 2, failed: 1, failures: ['Meta insights normalization placement'] });
    expect(r.get('tiktok')).toEqual({ total: 1, failed: 0, failures: [] });
    expect(r.has('shopify')).toBe(false);
  });
});
