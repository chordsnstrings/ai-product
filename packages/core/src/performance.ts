import { globalTx, withTenant, type Tx } from '@arkiv/db';
import { DomainError, env } from '@arkiv/shared';
import {
  ConnectorError,
  decryptToken,
  encryptToken,
  metaFetchInsights,
  shopifyFetchProducts,
  tiktokFetchReport,
  normalizeTikTokRow,
  type NormalizedObservation,
} from '@arkiv/integrations';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { autoLinkByCode } from './experiments';
import { enqueue, Queues } from './outbox';
import { recordFacts } from './product-truth';
import { nextCatalogueNo } from './workspaces';

/**
 * PerformanceIngestionService (§33) + data freshness (§31) + integration edge cases (§47).
 * Observations store raw counts with attribution context; derived metrics are always computed by us.
 */

export type Provider = 'shopify' | 'meta' | 'tiktok';
export const FRESHNESS_DAYS = 7;

export async function saveIntegration(
  tx: Tx,
  ctx: TenantContext,
  input: { provider: Provider; externalAccountId: string; displayName?: string | null; token: string; refreshToken?: string | null; scopes: string[]; timezone?: string | null; currency?: string | null },
) {
  assertCan(ctx, 'integration.manage');
  if (input.provider === 'shopify') {
    // One active workspace per shop — webhook routing must be unambiguous (plan 02 §3 layer 8).
    // shopify_shops is tenant-scoped; the cross-tenant "connected elsewhere" check is a narrow definer function.
    const [owner] = await tx`select shop_connected_elsewhere(${input.externalAccountId}) as elsewhere`;
    if (owner?.elsewhere) {
      throw new DomainError('CONFLICT', 'This store is connected to another workspace. Ask its owner to disconnect it, or request a transfer.', { transfer: true });
    }
  }
  const [row] = await tx`
    insert into integrations (workspace_id, provider, external_account_id, display_name, scopes, status, token_enc, refresh_token_enc, timezone, currency)
    values (${ctx.workspaceId}, ${input.provider}, ${input.externalAccountId}, ${input.displayName ?? null}, ${input.scopes}, 'active',
            ${encryptToken(input.token)}, ${input.refreshToken ? encryptToken(input.refreshToken) : null}, ${input.timezone ?? null}, ${input.currency ?? null})
    on conflict (workspace_id, provider, external_account_id) do update set token_enc = excluded.token_enc,
      refresh_token_enc = coalesce(excluded.refresh_token_enc, integrations.refresh_token_enc), scopes = excluded.scopes, status = 'active', error = null
    returning id`;
  if (input.provider === 'shopify') {
    await tx`insert into shopify_shops (shop_domain, workspace_id, integration_id) values (${input.externalAccountId}, ${ctx.workspaceId}, ${row!.id})
             on conflict (shop_domain) do nothing`;
  }
  await emit(tx, ctx, 'INTEGRATION_CONNECTED', { type: 'integration', id: row!.id as string }, { provider: input.provider, scopes: input.scopes });
  await enqueue(tx, ctx.workspaceId, Queues.syncIntegration, { integrationId: row!.id, full: true }, { singletonKey: `sync:${row!.id}` });
  return row!.id as string;
}

export async function disconnectIntegration(tx: Tx, ctx: TenantContext, integrationId: string) {
  assertCan(ctx, 'integration.manage');
  const [i] = await tx`update integrations set status = 'disconnected', token_enc = null, refresh_token_enc = null where id = ${integrationId}
                       returning provider, external_account_id`;
  if (!i) throw new DomainError('NOT_FOUND', 'Integration not found');
  if (i.provider === 'shopify') await tx`delete from shopify_shops where shop_domain = ${i.external_account_id} and workspace_id = ${ctx.workspaceId}`;
  await emit(tx, ctx, 'INTEGRATION_DISCONNECTED', { type: 'integration', id: integrationId }, { provider: i.provider });
}

/**
 * Insert observations with revision history: a changed row for the same key supersedes the old one
 * (late conversions / backfills, §45) without rewriting history.
 */
export async function ingestObservations(tx: Tx, ctx: TenantContext, integrationId: string | null, rows: NormalizedObservation[]) {
  let inserted = 0;
  let revised = 0;
  for (const o of rows) {
    const [prev] = await tx`
      select id, revision, spend_micros, impressions, clicks, purchases, purchase_value_micros, video_75 from performance_observations
      where platform = ${o.platform} and ad_id = ${o.adId} and date = ${o.date} and measurement_context = ${o.measurementContext}
        and attribution_window = ${o.attributionWindow} and superseded_at is null`;
    const same = prev && Number(prev.spend_micros) === o.spendMicros && Number(prev.impressions) === o.impressions && Number(prev.clicks) === o.clicks &&
      Number(prev.purchases) === o.purchases && Number(prev.purchase_value_micros) === o.purchaseValueMicros && Number(prev.video_75 ?? 0) === (o.video75 ?? 0);
    if (same) continue;
    if (prev) {
      await tx`update performance_observations set superseded_at = now() where id = ${prev.id}`;
      revised++;
    }
    await tx`
      insert into performance_observations (workspace_id, integration_id, platform, account_id, campaign_id, adgroup_id, ad_id, date, currency,
        spend_micros, impressions, reach, frequency, clicks, outbound_clicks, video_starts, video_25, video_50, video_75, video_100, avg_watch_ms,
        add_to_cart, checkout, purchases, purchase_value_micros, attribution_model, attribution_window, optimization_event, campaign_type,
        measurement_context, revision)
      values (${ctx.workspaceId}, ${integrationId}, ${o.platform}, ${o.accountId}, ${o.campaignId}, ${o.adgroupId}, ${o.adId}, ${o.date}, ${o.currency},
        ${o.spendMicros}, ${o.impressions}, ${o.reach}, ${o.frequency}, ${o.clicks}, ${o.outboundClicks}, ${o.videoStarts}, ${o.video25}, ${o.video50},
        ${o.video75}, ${o.video100}, ${o.avgWatchMs == null ? null : Math.round(o.avgWatchMs)}, ${o.addToCart}, ${o.checkout}, ${o.purchases}, ${o.purchaseValueMicros},
        ${o.attributionModel}, ${o.attributionWindow}, ${o.optimizationEvent}, ${o.campaignType}, ${o.measurementContext}, ${prev ? Number(prev.revision) + 1 : 1})`;
    inserted++;
    const [linked] = await tx`select variant_id from performance_observations where platform = ${o.platform} and ad_id = ${o.adId} and variant_id is not null limit 1`;
    if (linked?.variant_id) {
      await tx`update performance_observations set variant_id = ${linked.variant_id} where platform = ${o.platform} and ad_id = ${o.adId} and variant_id is null`;
    } else {
      await autoLinkByCode(tx, o.platform, o.adId, o.adName);
    }
  }
  if (inserted) {
    await emit(tx, ctx, 'PERFORMANCE_INGESTED', integrationId ? { type: 'integration', id: integrationId } : null, { inserted, revised });
    const exps = await tx`select distinct v.experiment_id from performance_observations o join variants v on v.id = o.variant_id
                          where o.ingested_at > now() - interval '5 minutes'`;
    for (const e of exps) await enqueue(tx, ctx.workspaceId, Queues.computeResults, { experimentId: e.experiment_id, reason: 'new_data' }, { singletonKey: `results:${e.experiment_id}` });
  }
  return { inserted, revised };
}

async function markError(ctx: TenantContext, integrationId: string, e: ConnectorError) {
  await withTenant(ctx.workspaceId, async (tx) => {
    const status = e.kind === 'auth_revoked' ? 'revoked' : e.kind === 'rate_limited' ? 'active' : 'degraded';
    await tx`update integrations set status = ${status}, error = ${tx.json({ kind: e.kind, message: e.message, at: new Date().toISOString() })} where id = ${integrationId}`;
    if (status !== 'active') {
      await emit(tx, ctx, 'INTEGRATION_DEGRADED', { type: 'integration', id: integrationId }, { kind: e.kind });
      await emit(tx, ctx, 'DATA_FRESHNESS_CHANGED', { type: 'integration', id: integrationId }, { status });
    }
  });
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Sync one integration with checkpointing; rate limits back off and resume (§47). */
export async function syncIntegration(ctx: TenantContext, integrationId: string, opts: { full?: boolean } = {}) {
  const i = await withTenant(ctx.workspaceId, async (tx) => (await tx`select * from integrations where id = ${integrationId}`)[0]);
  if (!i || !i.token_enc || i.status === 'disconnected' || i.status === 'revoked' || i.status === 'paused') return { skipped: true };
  if (env().PROVIDERS_MODE === 'mock' && String(i.external_account_id).startsWith('demo')) return { skipped: true };
  const token = decryptToken(i.token_enc as string);
  const cursor = (i.cursor ?? {}) as { lastDate?: string };
  // Re-pull a trailing window each sync so late conversions can revise history.
  const since = opts.full || !cursor.lastDate ? ymd(new Date(Date.now() - 90 * 86400_000)) : ymd(new Date(new Date(cursor.lastDate).getTime() - 7 * 86400_000));
  const until = ymd(new Date());
  try {
    if (i.provider === 'meta') {
      let after: string | null = null;
      do {
        const page = await metaFetchInsights(token, i.external_account_id as string, since, until, after);
        await withTenant(ctx.workspaceId, (tx) => ingestObservations(tx, ctx, integrationId, page.rows));
        after = page.next;
      } while (after);
    } else if (i.provider === 'tiktok') {
      let pageNo = 1;
      for (;;) {
        const page = await tiktokFetchReport(token, i.external_account_id as string, since, until, pageNo);
        const rows = page.list.map((r) => normalizeTikTokRow(r, i.external_account_id as string, (i.currency as string) ?? 'USD', r.metrics.campaign_type ?? null));
        await withTenant(ctx.workspaceId, (tx) => ingestObservations(tx, ctx, integrationId, rows));
        if (!page.hasMore) break;
        pageNo++;
      }
    } else if (i.provider === 'shopify') {
      await syncShopifyProducts(ctx, integrationId, i.external_account_id as string, token);
    }
    await withTenant(ctx.workspaceId, async (tx) => {
      await tx`update integrations set status = 'active', error = null, last_success_at = now(), last_complete_date = ${until},
                 cursor = ${tx.json({ lastDate: until })} where id = ${integrationId}`;
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof ConnectorError) {
      await markError(ctx, integrationId, e);
      if (e.kind === 'rate_limited') {
        await withTenant(ctx.workspaceId, (tx) =>
          enqueue(tx, ctx.workspaceId, Queues.syncIntegration, { integrationId }, { runAfter: new Date(Date.now() + (e.retryAfterSec ?? 60) * 1000), singletonKey: `sync:${integrationId}:retry` }),
        );
      }
      return { ok: false, error: e.kind };
    }
    throw e;
  }
}

/** Shopify is the canonical commerce source (§28): capture IDs and keep raw snapshots via facts provenance. */
async function syncShopifyProducts(ctx: TenantContext, integrationId: string, shop: string, token: string) {
  let cursor: string | null = null;
  let seen = 0;
  do {
    const page = await shopifyFetchProducts(shop, token, cursor);
    for (const p of page.products) {
      if (++seen > 60) break; // ICP is 1–30 SKUs; bound the import
      await withTenant(ctx.workspaceId, async (tx) => {
        let [sku] = await tx`select id from skus where shopify_product_id = ${p.id}`;
        if (!sku) {
          if (p.status !== 'ACTIVE') return;
          const no = await nextCatalogueNo(tx);
          [sku] = await tx`insert into skus (workspace_id, catalogue_no, name, status, source_kind, shopify_product_id, source_url)
                           values (${ctx.workspaceId}, ${no}, ${p.title}, 'active', 'shopify', ${p.id}, ${`https://${shop}`}) returning id`;
        }
        const v0 = p.variants[0];
        await recordFacts(tx, ctx, sku!.id as string, [
          { key: 'name', valueText: p.title, sourceType: 'shopify', sourceId: p.id, state: 'OBSERVED' },
          { key: 'description', valueText: p.descriptionText.slice(0, 4000) || null, sourceType: 'shopify', sourceId: p.id, state: 'OBSERVED' },
          { key: 'price', valueNumber: v0?.price ?? null, sourceType: 'shopify', sourceId: v0?.id, state: 'OBSERVED' },
          { key: 'compare_at_price', valueNumber: v0?.compareAtPrice ?? null, sourceType: 'shopify', sourceId: v0?.id, state: 'OBSERVED' },
          { key: 'variants', valueJson: p.variants, sourceType: 'shopify', sourceId: p.id, state: 'OBSERVED' },
          { key: 'gtin', valueText: v0?.barcode ?? null, sourceType: 'shopify', sourceId: v0?.id, state: 'OBSERVED' },
        ]);
        if (p.status !== 'ACTIVE') await tx`update skus set status = 'archived' where id = ${sku!.id}`;
      });
    }
    cursor = page.next;
  } while (cursor && seen <= 60);
  void integrationId;
}

export interface Freshness {
  provider: Provider;
  status: string;
  lastSuccessAt: string | null;
  stale: boolean;
  label: string;
}

/** Freshness per connection (§31): stale ad data downgrades the recommendation basis in the UI. */
export async function freshness(tx: Tx): Promise<Freshness[]> {
  const rows = await tx`select provider, status, last_success_at, display_name from integrations where status <> 'disconnected'`;
  return rows.map((r) => {
    const last = r.last_success_at ? new Date(r.last_success_at as string) : null;
    const stale = !last || Date.now() - last.getTime() > FRESHNESS_DAYS * 86400_000 || r.status !== 'active';
    const ago = last ? Math.round((Date.now() - last.getTime()) / 3600_000) : null;
    return {
      provider: r.provider as Provider,
      status: r.status as string,
      lastSuccessAt: last?.toISOString() ?? null,
      stale,
      label: r.status === 'revoked' ? 'Access revoked — reconnect' : !last ? 'Waiting for first sync' : ago! < 1 ? 'Synced just now' : ago! < 48 ? `Synced ${ago}h ago` : `Synced ${Math.round(ago! / 24)}d ago`,
    };
  });
}

/** Resolve a Shopify webhook to its workspace via the global routing table (never guessed). */
export async function workspaceForShop(shop: string): Promise<string | null> {
  const [r] = await globalTx((tx) => tx`select workspace_for_shop(${shop}) as workspace_id`);
  return (r?.workspace_id as string) ?? null;
}

/**
 * Manual import (CSV from Ads Manager) — MERCHANT_IMPORTED context, never mixed with API-attributed data.
 */
export function parsePerformanceCsv(csv: string): NormalizedObservation[] {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines.shift()!.split(',').map((h) => h.trim().toLowerCase());
  const col = (row: string[], ...names: string[]) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return row[i]?.trim() ?? '';
    }
    return '';
  };
  return lines.filter(Boolean).map((l) => {
    const r = l.split(',');
    const n = (v: string) => (v ? Number(v.replace(/[$,]/g, '')) : 0);
    return {
      platform: /tiktok/i.test(col(r, 'platform')) ? 'tiktok' : 'meta',
      accountId: col(r, 'account id', 'account') || 'manual',
      campaignId: col(r, 'campaign id') || null,
      adgroupId: null,
      adId: col(r, 'ad id', 'ad') || col(r, 'ad name'),
      adName: col(r, 'ad name') || null,
      date: col(r, 'date', 'day', 'reporting starts'),
      currency: col(r, 'currency') || 'USD',
      spendMicros: Math.round(n(col(r, 'spend', 'amount spent (usd)', 'amount spent')) * 1e6),
      impressions: n(col(r, 'impressions')),
      reach: null,
      frequency: null,
      clicks: n(col(r, 'clicks', 'link clicks')),
      outboundClicks: null,
      videoStarts: n(col(r, 'video plays', '3-second video plays')) || null,
      video25: null,
      video50: null,
      video75: n(col(r, 'video plays at 75%')) || null,
      video100: null,
      avgWatchMs: null,
      addToCart: null,
      checkout: null,
      purchases: n(col(r, 'purchases', 'results')),
      purchaseValueMicros: Math.round(n(col(r, 'purchase value', 'purchases conversion value')) * 1e6),
      attributionModel: 'merchant_import',
      attributionWindow: 'merchant_import',
      optimizationEvent: null,
      campaignType: null,
      measurementContext: 'MERCHANT_IMPORTED' as const,
    };
  });
}
