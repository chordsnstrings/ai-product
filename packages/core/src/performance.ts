import { globalTx, withTenant, type Tx } from '@arkiv/db';
import { csvContext, DomainError, env, type CsvPlatform } from '@arkiv/shared';
import {
  ConnectorError,
  decryptToken,
  encryptToken,
  metaFetchInsights,
  shopifyFetchProducts,
  tiktokFetchReport,
  normalizeTikTokRow,
  type NormalizedObservation,
  type ShopifyProduct,
} from '@arkiv/integrations';
import { closeAutomaticConfounders, recordAutomaticConfounder } from './experiment-state';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { autoLinkByCode } from './experiments';
import { recordFunnel, workspaceVisitor } from './funnel';
import { enqueue, Queues } from './outbox';
import { recordFacts } from './product-truth';
import { nextCatalogueNo } from './workspaces';
import { recordVariants } from './sku-variants';

/**
 * PerformanceIngestionService (§33) + data freshness (§31) + integration edge cases (§47).
 * Observations store raw counts with attribution context; derived metrics are always computed by us.
 */

export type Provider = 'shopify' | 'meta' | 'tiktok';
export const FRESHNESS_DAYS = 7;

export async function saveIntegration(
  tx: Tx,
  ctx: TenantContext,
  input: { provider: Provider; externalAccountId: string; displayName?: string | null; token: string; refreshToken?: string | null; scopes: string[]; timezone?: string | null; currency?: string | null; platformUserId?: string | null },
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
    insert into integrations (workspace_id, provider, external_account_id, display_name, scopes, status, token_enc, refresh_token_enc, timezone, currency, platform_user_id)
    values (${ctx.workspaceId}, ${input.provider}, ${input.externalAccountId}, ${input.displayName ?? null}, ${input.scopes}, 'active',
            ${encryptToken(input.token)}, ${input.refreshToken ? encryptToken(input.refreshToken) : null}, ${input.timezone ?? null}, ${input.currency ?? null}, ${input.platformUserId ?? null})
    on conflict (workspace_id, provider, external_account_id) do update set token_enc = excluded.token_enc,
      platform_user_id = coalesce(excluded.platform_user_id, integrations.platform_user_id),
      refresh_token_enc = coalesce(excluded.refresh_token_enc, integrations.refresh_token_enc), scopes = excluded.scopes, status = 'active', error = null,
      timezone = coalesce(excluded.timezone, integrations.timezone), currency = coalesce(excluded.currency, integrations.currency),
      display_name = coalesce(excluded.display_name, integrations.display_name)
    returning id`;
  if (input.provider === 'shopify') {
    await tx`insert into shopify_shops (shop_domain, workspace_id, integration_id) values (${input.externalAccountId}, ${ctx.workspaceId}, ${row!.id})
             on conflict (shop_domain) do nothing`;
  }
  await emit(tx, ctx, 'INTEGRATION_CONNECTED', { type: 'integration', id: row!.id as string }, { provider: input.provider, scopes: input.scopes });
  // Standard §7 "Ad account connected — Meta/TikTok connection rate".
  if (input.provider === 'meta' || input.provider === 'tiktok') {
    await recordFunnel('AD_ACCOUNT_CONNECTED', { workspaceId: ctx.workspaceId, visitorId: await workspaceVisitor(tx, ctx.workspaceId), props: { provider: input.provider } }, tx);
  }
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

export interface PendingAccount {
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
}

/**
 * Hold an OAuth result while the merchant picks accounts (§47 "Wrong ad account selected: allow account switch").
 * An agency login can read many brands' accounts: none is connected until chosen. The token is stored encrypted
 * and the row expires after 30 minutes.
 */
export async function stashPendingConnection(tx: Tx, ctx: TenantContext, provider: 'meta' | 'tiktok', token: string, accounts: PendingAccount[], platformUserId: string | null = null) {
  assertCan(ctx, 'integration.manage');
  await tx`delete from pending_connections where expires_at < now()`;
  const [r] = await tx`insert into pending_connections (workspace_id, provider, token_enc, accounts, created_by, platform_user_id)
                       values (${ctx.workspaceId}, ${provider}, ${encryptToken(token)}, ${tx.json(accounts as never)}, ${ctx.actor.kind === 'user' ? ctx.actor.id : null}, ${platformUserId})
                       returning id`;
  return r!.id as string;
}

/** A live pending connection's provider and accounts (never its token), with which of them are connected now. */
export async function pendingConnection(tx: Tx, id: string) {
  const [p] = await tx`select id, provider, accounts from pending_connections where id = ${id} and expires_at > now()`;
  if (!p) return null;
  const connected = await tx`select external_account_id from integrations where provider = ${p.provider} and status <> 'disconnected'`;
  return { id: p.id as string, provider: p.provider as 'meta' | 'tiktok', accounts: p.accounts as PendingAccount[], connected: connected.map((c) => c.external_account_id as string) };
}

/**
 * Connect the chosen accounts of a pending connection. `replace` switches accounts: the provider's other
 * connections are disconnected (tokens deleted; their past observations stay tagged to their source account and
 * integration). Only accounts the login actually returned can be chosen.
 */
export async function connectSelectedAccounts(tx: Tx, ctx: TenantContext, pendingId: string, accountIds: string[], opts: { replace?: boolean } = {}) {
  assertCan(ctx, 'integration.manage');
  const [p] = await tx`select id, provider, token_enc, accounts, platform_user_id from pending_connections where id = ${pendingId} and expires_at > now() for update`;
  if (!p) throw new DomainError('CONFLICT', 'That connection expired. Connect again to choose accounts.');
  const offered = p.accounts as PendingAccount[];
  const chosen = offered.filter((a) => accountIds.includes(a.id));
  if (!chosen.length) throw new DomainError('INVALID', 'Choose at least one ad account.');
  if (chosen.length !== new Set(accountIds).size) throw new DomainError('INVALID', 'That account isn’t on this login.');
  const token = decryptToken(p.token_enc as string);
  const provider = p.provider as 'meta' | 'tiktok';
  const ids: string[] = [];
  for (const a of chosen) {
    ids.push(await saveIntegration(tx, ctx, { provider, externalAccountId: a.id, displayName: a.name, token, scopes: ['ads_read'], currency: a.currency, timezone: a.timezone, platformUserId: (p.platform_user_id as string | null) ?? null }));
  }
  let disconnected = 0;
  if (opts.replace) {
    const others = await tx`select id from integrations where provider = ${provider} and status <> 'disconnected' and not (id = any(${ids}::uuid[]))`;
    for (const o of others) {
      await disconnectIntegration(tx, ctx, o.id as string);
      disconnected++;
    }
  }
  await tx`delete from pending_connections where id = ${pendingId}`;
  return { connected: ids.length, disconnected };
}

/** Latest FX rates (USD per unit) by currency (§47: money is converted, never summed raw across currencies). */
export async function fxRates(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx`select distinct on (currency) currency, usd_per_unit from fx_rates where effective_from <= current_date
                        order by currency, version desc, effective_from desc`;
  return new Map(rows.map((r) => [r.currency as string, Number(r.usd_per_unit)]));
}

/** Rate converting `from` into `to` through USD; null when either currency has no rate. */
export function fxRate(rates: Map<string, number>, from: string, to: string): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return 1;
  const a = rates.get(f);
  const b = rates.get(t);
  return a && b ? a / b : null;
}

/** Only timezones Postgres knows are kept (they are used in date arithmetic against confounder windows). */
async function knownTimezones(tx: Tx, names: (string | null | undefined)[]): Promise<Set<string>> {
  const list = [...new Set(names.filter((n): n is string => !!n))];
  if (!list.length) return new Set();
  const rows = await tx`select name from pg_timezone_names where name = any(${list}::text[])`;
  return new Set(rows.map((r) => r.name as string));
}

/**
 * Insert observations with revision history: a changed row for the same key supersedes the old one
 * (late conversions / backfills, §45) without rewriting history. The key includes the placement; a placement
 * breakdown replaces the unbroken-down total for the same ad and day (and vice versa), so the two are never summed.
 * Each row keeps its native currency plus the workspace's reporting-currency amounts (§47) and its source timezone.
 */
export async function ingestObservations(tx: Tx, ctx: TenantContext, integrationId: string | null, rows: NormalizedObservation[], opts: { sourceTimezone?: string | null } = {}) {
  let inserted = 0;
  let revised = 0;
  const [ws] = await tx`select reporting_currency from workspaces where id = ${ctx.workspaceId}`;
  const reporting = ((ws?.reporting_currency as string) ?? 'USD').toUpperCase();
  const rates = await fxRates(tx);
  const [integ] = integrationId ? await tx`select timezone from integrations where id = ${integrationId}` : [];
  const defaultTz = opts.sourceTimezone ?? (integ?.timezone as string | null) ?? null;
  const zones = await knownTimezones(tx, [defaultTz, ...rows.map((r) => r.sourceTimezone)]);
  for (const o of rows) {
    const placement = o.placement?.trim() || 'all';
    const tzName = o.sourceTimezone ?? defaultTz;
    const tz = tzName && zones.has(tzName) ? tzName : null;
    const currency = (o.currency || 'USD').toUpperCase();
    const rate = fxRate(rates, currency, reporting);
    const [prev] = await tx`
      select id, revision, spend_micros, impressions, clicks, purchases, purchase_value_micros, video_75 from performance_observations
      where platform = ${o.platform} and ad_id = ${o.adId} and date = ${o.date} and measurement_context = ${o.measurementContext}
        and attribution_window = ${o.attributionWindow} and placement = ${placement} and superseded_at is null`;
    const same = prev && Number(prev.spend_micros) === o.spendMicros && Number(prev.impressions) === o.impressions && Number(prev.clicks) === o.clicks &&
      Number(prev.purchases) === o.purchases && Number(prev.purchase_value_micros) === o.purchaseValueMicros && Number(prev.video_75 ?? 0) === (o.video75 ?? 0);
    if (same) continue;
    if (prev) {
      await tx`update performance_observations set superseded_at = now() where id = ${prev.id}`;
      revised++;
    }
    // A breakdown and the total it breaks down are the same delivery: the newer shape replaces the other.
    const other = await tx`
      update performance_observations set superseded_at = now()
      where platform = ${o.platform} and ad_id = ${o.adId} and date = ${o.date} and measurement_context = ${o.measurementContext}
        and attribution_window = ${o.attributionWindow} and superseded_at is null
        and (case when ${placement}::text = 'all' then placement <> 'all' else placement = 'all' end)
      returning id`;
    revised += other.length;
    await tx`
      insert into performance_observations (workspace_id, integration_id, platform, account_id, campaign_id, adgroup_id, ad_id, date, currency,
        spend_micros, impressions, reach, frequency, clicks, outbound_clicks, video_starts, video_25, video_50, video_75, video_100, avg_watch_ms,
        add_to_cart, checkout, purchases, purchase_value_micros, attribution_model, attribution_window, optimization_event, campaign_type,
        measurement_context, revision, placement, source_timezone, fx_rate, reporting_currency, spend_reporting_micros, value_reporting_micros)
      values (${ctx.workspaceId}, ${integrationId}, ${o.platform}, ${o.accountId}, ${o.campaignId}, ${o.adgroupId}, ${o.adId}, ${o.date}, ${currency},
        ${o.spendMicros}, ${o.impressions}, ${o.reach}, ${o.frequency}, ${o.clicks}, ${o.outboundClicks}, ${o.videoStarts}, ${o.video25}, ${o.video50},
        ${o.video75}, ${o.video100}, ${o.avgWatchMs == null ? null : Math.round(o.avgWatchMs)}, ${o.addToCart}, ${o.checkout}, ${o.purchases}, ${o.purchaseValueMicros},
        ${o.attributionModel}, ${o.attributionWindow}, ${o.optimizationEvent}, ${o.campaignType}, ${o.measurementContext}, ${prev ? Number(prev.revision) + 1 : 1},
        ${placement}, ${tz}, ${rate}, ${reporting}, ${rate == null ? null : Math.round(o.spendMicros * rate)}, ${rate == null ? null : Math.round(o.purchaseValueMicros * rate)})`;
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
    const [i] = await tx`update integrations set status = ${status}, error = ${tx.json({ kind: e.kind, message: e.message, at: new Date().toISOString() })}
                         where id = ${integrationId} and workspace_id = ${ctx.workspaceId} returning provider`;
    // Rate-limit history per connection (plan 05 §2.2 Integrations): every throttle the platform answered with.
    if (i && e.kind === 'rate_limited') {
      await tx`insert into integration_rate_limits (workspace_id, integration_id, provider, message, retry_after_sec)
               values (${ctx.workspaceId}, ${integrationId}, ${i.provider as string}, ${e.message.slice(0, 500)}, ${e.retryAfterSec ?? null})`;
    }
    if (status !== 'active') {
      await emit(tx, ctx, 'INTEGRATION_DEGRADED', { type: 'integration', id: integrationId }, { kind: e.kind });
      await emit(tx, ctx, 'DATA_FRESHNESS_CHANGED', { type: 'integration', id: integrationId }, { status });
    }
  });
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Where an interrupted sync resumes: its window and the next page to fetch (Meta `after` cursor, TikTok page number). */
export interface SyncCursor {
  lastDate?: string;
  resume?: { since: string; until: string; provider: Provider; page: string | number };
}

/**
 * Sync one integration with checkpointing (§47 "Backoff, checkpoint, resume"): after every ingested page the
 * position is saved with that page's rows, so a rate-limited sync resumes on the page it stopped at — not from the
 * start of its window — and the merchant sees data freshness rather than an error.
 */
export async function syncIntegration(ctx: TenantContext, integrationId: string, opts: { full?: boolean } = {}) {
  const i = await withTenant(ctx.workspaceId, async (tx) => (await tx`select * from integrations where id = ${integrationId}`)[0]);
  if (!i || !i.token_enc || i.status === 'disconnected' || i.status === 'revoked' || i.status === 'paused') return { skipped: true };
  if (env().PROVIDERS_MODE === 'mock' && String(i.external_account_id).startsWith('demo')) return { skipped: true };
  const token = decryptToken(i.token_enc as string);
  const cursor = (i.cursor ?? {}) as SyncCursor;
  const provider = i.provider as Provider;
  const resume = !opts.full && cursor.resume?.provider === provider ? cursor.resume : null;
  // Re-pull a trailing window each sync so late conversions can revise history.
  const since = resume?.since ?? (opts.full || !cursor.lastDate ? ymd(new Date(Date.now() - 90 * 86400_000)) : ymd(new Date(new Date(cursor.lastDate).getTime() - 7 * 86400_000)));
  const until = resume?.until ?? ymd(new Date());
  /** Ingest one page and, in the same transaction, record where the next one starts. */
  const ingestPage = (rows: NormalizedObservation[], next: string | number | null) =>
    withTenant(ctx.workspaceId, async (tx) => {
      await ingestObservations(tx, ctx, integrationId, rows);
      const c: SyncCursor = { ...(cursor.lastDate ? { lastDate: cursor.lastDate } : {}), ...(next != null ? { resume: { since, until, provider, page: next } } : {}) };
      await tx`update integrations set cursor = ${tx.json(c as never)} where id = ${integrationId}`;
    });
  try {
    if (provider === 'meta') {
      let after: string | null = resume ? String(resume.page) : null;
      do {
        const page = await metaFetchInsights(token, i.external_account_id as string, since, until, after);
        after = page.next;
        await ingestPage(page.rows, after);
      } while (after);
    } else if (provider === 'tiktok') {
      let pageNo = resume ? Math.max(1, Number(resume.page) || 1) : 1;
      for (;;) {
        const page = await tiktokFetchReport(token, i.external_account_id as string, since, until, pageNo);
        const rows = page.list.map((r) => normalizeTikTokRow(r, i.external_account_id as string, (i.currency as string) ?? 'USD', r.metrics.campaign_type ?? null));
        await ingestPage(rows, page.hasMore ? pageNo + 1 : null);
        if (!page.hasMore) break;
        pageNo++;
      }
    } else if (provider === 'shopify') {
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
    if (!cursor && (page.currency || page.timezone)) {
      // The shop's own currency and timezone (§47): prices are stored in it, never assumed to be USD.
      await withTenant(ctx.workspaceId, (tx) => tx`update integrations set currency = coalesce(${page.currency}, currency), timezone = coalesce(${page.timezone}, timezone)
                                                    where id = ${integrationId}`);
    }
    for (const p of page.products) {
      if (++seen > 60) break; // ICP is 1–30 SKUs; bound the import
      await withTenant(ctx.workspaceId, (tx) => applyShopifyProduct(tx, ctx, shop, p, page.currency));
    }
    cursor = page.next;
  } while (cursor && seen <= 60);
}

/**
 * One Shopify product into the catalogue: facts (with provenance), variants in the shop's currency, and the
 * operational signals a store change carries (§45, §48): a price or compare-at change opens a confounder window
 * through the facts; the product selling out opens an ongoing stock-out window that closes when it is back.
 */
export async function applyShopifyProduct(tx: Tx, ctx: TenantContext, shop: string, p: ShopifyProduct, currency: string | null) {
  let [sku] = await tx`select id from skus where shopify_product_id = ${p.id}`;
  if (!sku) {
    if (p.status !== 'ACTIVE') return;
    const no = await nextCatalogueNo(tx);
    [sku] = await tx`insert into skus (workspace_id, catalogue_no, name, status, source_kind, shopify_product_id, source_url)
                     values (${ctx.workspaceId}, ${no}, ${p.title}, 'active', 'shopify', ${p.id}, ${`https://${shop}`}) returning id`;
  }
  const skuId = sku!.id as string;
  const [was] = await tx`select bool_or(available) as any_available, count(*)::int as n from sku_variants where sku_id = ${skuId} and source = 'shopify'`;
  const v0 = p.variants[0];
  await recordFacts(tx, ctx, skuId, [
    { key: 'name', valueText: p.title, sourceType: 'shopify', sourceId: p.id, state: 'OBSERVED' },
    { key: 'description', valueText: p.descriptionText.slice(0, 4000) || null, sourceType: 'shopify', sourceId: p.id, state: 'OBSERVED' },
    { key: 'price', valueNumber: v0?.price ?? null, sourceType: 'shopify', sourceId: v0?.id, state: 'OBSERVED' },
    { key: 'compare_at_price', valueNumber: v0?.compareAtPrice ?? null, sourceType: 'shopify', sourceId: v0?.id, state: 'OBSERVED' },
    { key: 'variants', valueJson: p.variants, sourceType: 'shopify', sourceId: p.id, state: 'OBSERVED' },
    { key: 'gtin', valueText: v0?.barcode ?? null, sourceType: 'shopify', sourceId: v0?.id, state: 'OBSERVED' },
  ]);
  // §42: variant-specific price, availability and image.
  await recordVariants(tx, ctx, skuId, 'shopify', p.variants.map((v) => ({
    externalId: v.id,
    title: v.title,
    options: v.options,
    priceMicros: v.price > 0 ? Math.round(v.price * 1_000_000) : undefined,
    compareAtMicros: v.compareAtPrice ? Math.round(v.compareAtPrice * 1_000_000) : undefined,
    sku: v.sku ?? undefined,
    gtin: v.barcode ?? undefined,
    available: v.available ?? undefined,
    imageUrl: v.imageUrl ?? undefined,
  })), currency);
  // Stock-out (§45 "Stockout/site outage: automated signal marks affected date range"). Only a known change counts:
  // the first import, or a store that doesn't report availability, marks nothing.
  const known = p.variants.filter((v) => v.available != null);
  if (Number(was?.n ?? 0) > 0 && known.length) {
    const nowAvailable = known.some((v) => v.available);
    if (was!.any_available === true && !nowAvailable && p.status === 'ACTIVE') {
      await recordAutomaticConfounder(tx, ctx, { skuId, kind: 'stockout', endsAt: null, note: 'Sold out in Shopify', detail: { shopifyProductId: p.id } });
    } else if (nowAvailable) {
      await closeAutomaticConfounders(tx, skuId, 'stockout');
    }
  }
  if (p.status !== 'ACTIVE') await tx`update skus set status = 'archived' where id = ${skuId}`;
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

/** Header columns only one platform's Ads Manager export has, to catch a CSV uploaded under the wrong platform. */
const CSV_FINGERPRINTS: Record<CsvPlatform, RegExp> = {
  meta: /^(reporting starts|reporting ends|amount spent( \(\w+\))?|ad set name|ad set id)$/,
  tiktok: /^(cost|total cost|ad group name|ad group id|clicks \(destination\)|video views at 75%)$/,
};

/**
 * Manual import (CSV from Meta or TikTok Ads Manager). The merchant says which platform the export is from; each
 * platform's rows get their own context (MERCHANT_IMPORTED_META / _TIKTOK) so a variant's Meta and TikTok numbers
 * are never pooled into one result (§48), and never mixed with API-attributed data (§30). A file whose columns
 * are the other platform's is refused.
 */
export function parsePerformanceCsv(csv: string, platform: CsvPlatform, opts: { timezone?: string | null } = {}): NormalizedObservation[] {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines.shift()!.split(',').map((h) => h.trim().toLowerCase());
  const other: CsvPlatform = platform === 'meta' ? 'tiktok' : 'meta';
  const name = (p: CsvPlatform) => (p === 'meta' ? 'Meta' : 'TikTok');
  if (head.some((h) => CSV_FINGERPRINTS[other].test(h)) && !head.some((h) => CSV_FINGERPRINTS[platform].test(h))) {
    throw new DomainError('INVALID', `This looks like a ${name(other)} Ads Manager export. Choose ${name(other)} as the platform, or upload your ${name(platform)} export.`);
  }
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
    const stated = col(r, 'platform').toLowerCase();
    if (stated && (/tiktok/.test(stated) ? 'tiktok' : /meta|facebook|instagram/.test(stated) ? 'meta' : platform) !== platform) {
      throw new DomainError('INVALID', `Row for ${stated} in a ${name(platform)} import. Upload each platform’s export separately.`);
    }
    return {
      platform,
      accountId: col(r, 'account id', 'account') || 'manual',
      campaignId: col(r, 'campaign id') || null,
      adgroupId: null,
      adId: col(r, 'ad id', 'ad') || col(r, 'ad name'),
      adName: col(r, 'ad name') || null,
      date: col(r, 'date', 'day', 'by day', 'reporting starts'),
      currency: col(r, 'currency') || 'USD',
      spendMicros: Math.round(n(col(r, 'spend', 'amount spent (usd)', 'amount spent', 'cost', 'total cost')) * 1e6),
      impressions: n(col(r, 'impressions')),
      reach: null,
      frequency: null,
      clicks: n(col(r, 'clicks', 'link clicks', 'clicks (destination)')),
      outboundClicks: null,
      videoStarts: n(col(r, 'video plays', '3-second video plays', 'video views')) || null,
      video25: null,
      video50: null,
      video75: n(col(r, 'video plays at 75%', 'video views at 75%')) || null,
      video100: null,
      avgWatchMs: null,
      addToCart: null,
      checkout: null,
      purchases: n(col(r, 'purchases', 'results', 'complete payment', 'conversions')),
      purchaseValueMicros: Math.round(n(col(r, 'purchase value', 'purchases conversion value')) * 1e6),
      attributionModel: 'merchant_import',
      attributionWindow: 'merchant_import',
      optimizationEvent: null,
      campaignType: null,
      measurementContext: csvContext(platform),
      // The day column is in the ad account's reporting timezone (§47); the uploader names it.
      sourceTimezone: col(r, 'timezone', 'time zone') || opts.timezone || null,
    };
  });
}
