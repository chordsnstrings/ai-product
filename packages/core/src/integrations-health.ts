import { withSystem, type Tx } from '@arkiv/db';
import { ConnectorError, decryptToken, missingShopifyWebhooks, shopifyWebhookClient, type ConnectorProvider, type ShopifyWebhookClient } from '@arkiv/integrations';
import { DomainError, env } from '@arkiv/shared';
import { getSetting } from './settings';

export { API_VERSIONS, CONNECTOR_POLICY, missingScopes, SHOPIFY_WEBHOOK_TOPICS, type ConnectorPolicy, type ConnectorProvider } from '@arkiv/integrations';

/**
 * Integrations health (plan 05 §16): nightly Shopify webhook verification, API versions with their sunset dates,
 * and the contract-test gate on switching an API version.
 */

// ───────────── Shopify webhook registrations ─────────────

export interface WebhookHealth {
  ok: boolean;
  /** Required topics that were missing (or pointed elsewhere) when checked. */
  missing: string[];
  /** Topics registered by this check. */
  repaired: string[];
  error: string | null;
}

/**
 * Verify every routed shop's webhook registrations and register what is missing (plan 05 §16 "Shopify webhook
 * registrations verified nightly"). System role: reads each shop's own integration token (filtered by the shop's
 * workspace) and records the result on shopify_shops. Returns totals for the ops command / sweep log.
 */
export async function verifyShopifyWebhooks(client: ShopifyWebhookClient = shopifyWebhookClient()): Promise<{ shops: number; healthy: number; repaired: number; failed: number }> {
  const address = `${env().APP_URL}/api/webhooks/shopify`;
  const shops = await withSystem((tx) => tx`
    select s.shop_domain, s.workspace_id, i.token_enc, i.status
    from shopify_shops s join integrations i on i.id = s.integration_id and i.workspace_id = s.workspace_id`);
  let healthy = 0;
  let repaired = 0;
  let failed = 0;
  for (const s of shops) {
    const shop = s.shop_domain as string;
    const health: WebhookHealth = { ok: false, missing: [], repaired: [], error: null };
    try {
      if (!s.token_enc || ['revoked', 'disconnected'].includes(s.status as string)) throw new Error(`integration ${s.status as string}; no usable token`);
      const token = decryptToken(s.token_enc as string);
      health.missing = missingShopifyWebhooks(await client.list(shop, token), address);
      for (const topic of health.missing) {
        await client.create(shop, token, topic, address);
        health.repaired.push(topic);
      }
      health.ok = missingShopifyWebhooks(await client.list(shop, token), address).length === 0;
    } catch (e) {
      health.error = e instanceof ConnectorError ? `${e.kind}: ${e.message}` : (e as Error).message.slice(0, 300);
    }
    if (health.ok) healthy++;
    else failed++;
    if (health.repaired.length) repaired++;
    await withSystem((tx) => tx`update shopify_shops set webhooks_verified_at = now(), webhook_health = ${tx.json(health as never)}
                                where shop_domain = ${shop} and workspace_id = ${s.workspace_id as string}`);
  }
  return { shops: shops.length, healthy, repaired, failed };
}

// ───────────── API versions and sunsets ─────────────

export interface ApiVersionInfo {
  provider: ConnectorProvider;
  api: string;
  version: string;
  deprecatesOn: string | null;
  sunsetOn: string | null;
  notes: string | null;
}

/** API versions in use with their dates (setting `integrations.api_versions`, maintained by staff). */
export async function apiVersions(tx: Tx): Promise<ApiVersionInfo[]> {
  const v = await getSetting<unknown[]>(tx, 'integrations.api_versions', []);
  return (Array.isArray(v) ? v : []).filter((x): x is ApiVersionInfo => !!x && typeof x === 'object' && typeof (x as ApiVersionInfo).provider === 'string');
}

/** Versions whose sunset is within `days` (or past): the console banner (plan 05 §16 "banner N days before"). */
export function upcomingSunsets(versions: ApiVersionInfo[], days: number, now = new Date()): (ApiVersionInfo & { daysLeft: number })[] {
  return versions
    .filter((v) => v.sunsetOn && !Number.isNaN(Date.parse(v.sunsetOn)))
    .map((v) => ({ ...v, daysLeft: Math.ceil((Date.parse(v.sunsetOn!) - now.getTime()) / 86400_000) }))
    .filter((v) => v.daysLeft <= days)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

// ───────────── Contract tests gate (standard §51) ─────────────

/** `api.meta_version.v24_0` → { provider: 'meta', version: 'v24_0' }; null for other flags. */
export function apiVersionFlag(key: string): { provider: ConnectorProvider; version: string } | null {
  const m = /^api\.(meta|tiktok|shopify)_version\.([a-z0-9_.-]+)$/i.exec(key);
  return m ? { provider: m[1]!.toLowerCase() as ConnectorProvider, version: m[2]! } : null;
}
/** Versions compare with separators ignored: v24.0 = v24_0, 2026-10 = 2026_10. */
export const versionKey = (v: string) => v.trim().toLowerCase().replace(/[._-]/g, '_');

/** How recent a passing contract run must be to enable a version switch. */
export const CONTRACT_RUN_MAX_AGE_DAYS = 30;

/**
 * Enabling an API-version switch flag needs a recent passing contract run for that provider and version, with no
 * failing run after it (plan 05 §16). Other flags, and disabling, are not gated.
 */
export async function assertContractTestsPass(tx: Tx, flagKey: string, enabling: boolean): Promise<void> {
  const f = apiVersionFlag(flagKey);
  if (!f || !enabling) return;
  const runs = await tx`select api_version, passed, ran_at from contract_test_runs
                        where provider = ${f.provider} and ran_at > now() - make_interval(days => ${CONTRACT_RUN_MAX_AGE_DAYS}) order by ran_at desc`;
  const latest = runs.find((r) => versionKey(r.api_version as string) === versionKey(f.version));
  if (!latest) throw new DomainError('CONFLICT', `No contract test run for ${f.provider} ${f.version} in the last ${CONTRACT_RUN_MAX_AGE_DAYS} days. Run the contract suite against the new version first.`);
  if (!latest.passed) throw new DomainError('CONFLICT', `The latest contract test run for ${f.provider} ${f.version} failed. Fix the adapter before switching.`);
}

export interface ContractRun {
  provider: ConnectorProvider;
  apiVersion: string;
  suite: string;
  passed: boolean;
  total: number;
  failed: number;
  commitSha?: string | null;
  detail?: Record<string, unknown>;
}

export async function recordContractRun(tx: Tx, r: ContractRun): Promise<void> {
  await tx`insert into contract_test_runs (provider, api_version, suite, passed, total, failed, commit_sha, detail)
           values (${r.provider}, ${r.apiVersion}, ${r.suite}, ${r.passed}, ${r.total}, ${r.failed}, ${r.commitSha ?? null}, ${tx.json((r.detail ?? {}) as never)})`;
}

/** Contract suites by provider: a test belongs to a provider when its describe block names it. */
const SUITE_PROVIDER: [RegExp, ConnectorProvider][] = [
  [/shopify/i, 'shopify'],
  [/meta/i, 'meta'],
  [/tiktok/i, 'tiktok'],
];

/** Group a vitest JSON report's assertions into one result per provider. */
export function contractResultsByProvider(report: { testResults?: { assertionResults?: { ancestorTitles?: string[]; fullName?: string; status: string }[] }[] }): Map<ConnectorProvider, { total: number; failed: number; failures: string[] }> {
  const out = new Map<ConnectorProvider, { total: number; failed: number; failures: string[] }>();
  for (const file of report.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      const title = [...(a.ancestorTitles ?? []), a.fullName ?? ''].join(' ');
      const provider = SUITE_PROVIDER.find(([re]) => re.test(title))?.[1];
      if (!provider || a.status === 'skipped' || a.status === 'pending') continue;
      const r = out.get(provider) ?? { total: 0, failed: 0, failures: [] };
      r.total++;
      if (a.status !== 'passed') {
        r.failed++;
        r.failures.push((a.fullName ?? title).slice(0, 200));
      }
      out.set(provider, r);
    }
  }
  return out;
}
