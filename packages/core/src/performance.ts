import { createHash } from 'node:crypto';
import { globalTx, withSystem, withTenant, type Tx } from '@arkiv/db';
import { csvContext, DomainError, env, FREE_EXPLORATION, newId, type CsvPlatform } from '@arkiv/shared';
import { logger } from '@arkiv/shared/log';
import {
  ConnectorError,
  decryptToken,
  encryptToken,
  metaFetchAdStatuses,
  metaFetchInsights,
  normalizeTikTokGmvMaxRow,
  shopifyFetchProduct,
  shopifyFetchProducts,
  shopifyGid,
  shopifyMetafieldFacts,
  tiktokFetchAdgroupWindows,
  tiktokFetchAdStatuses,
  tiktokFetchCampaignTypes,
  tiktokFetchGmvMaxReport,
  tiktokFetchGmvMaxStores,
  tiktokFetchReport,
  normalizeTikTokRow,
  type NormalizedObservation,
  type ShopifyProduct,
} from '@arkiv/integrations';
import { closeAutomaticConfounders, recordAutomaticConfounder } from './experiment-state';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { detectDecimal, parseCsv, parseLocaleNumber } from './csv';
import { emit } from './events';
import { autoLinkByCode } from './experiments';
import { recordFunnel, workspaceVisitor } from './funnel';
import { enqueue, isFreeTier, priorityFor, queueFor, Queues } from './outbox';
import { recordFacts, type FactInput } from './product-truth';
import { planSteps } from './progress';
import { nextCatalogueNo } from './workspaces';
import { recordVariants } from './sku-variants';

const log = logger('performance');

/**
 * PerformanceIngestionService (§33) + data freshness (§31) + integration edge cases (§47).
 * Observations store raw counts with attribution context; derived metrics are always computed by us.
 */

export type Provider = 'shopify' | 'meta' | 'tiktok';
export const FRESHNESS_DAYS = 7;
export const PROVIDER_LABEL: Record<Provider, string> = { shopify: 'Shopify', meta: 'Meta', tiktok: 'TikTok' };

export async function saveIntegration(
  tx: Tx,
  ctx: TenantContext,
  input: {
    provider: Provider;
    externalAccountId: string;
    displayName?: string | null;
    token: string;
    refreshToken?: string | null;
    scopes: string[];
    timezone?: string | null;
    currency?: string | null;
    platformUserId?: string | null;
    /** When the token stops working (Meta long-lived tokens); null when it doesn't expire. */
    tokenExpiresAt?: Date | null;
  },
) {
  assertCan(ctx, 'integration.manage');
  if (input.provider === 'shopify') await assertShopRoutable(tx, input.externalAccountId);
  const [row] = await tx`
    insert into integrations (workspace_id, provider, external_account_id, display_name, scopes, status, token_enc, refresh_token_enc, timezone, currency, platform_user_id, token_expires_at)
    values (${ctx.workspaceId}, ${input.provider}, ${input.externalAccountId}, ${input.displayName ?? null}, ${input.scopes}, 'active',
            ${encryptToken(input.token)}, ${input.refreshToken ? encryptToken(input.refreshToken) : null}, ${input.timezone ?? null}, ${input.currency ?? null}, ${input.platformUserId ?? null},
            ${input.tokenExpiresAt ?? null})
    on conflict (workspace_id, provider, external_account_id) do update set token_enc = excluded.token_enc,
      platform_user_id = coalesce(excluded.platform_user_id, integrations.platform_user_id),
      refresh_token_enc = coalesce(excluded.refresh_token_enc, integrations.refresh_token_enc), scopes = excluded.scopes, status = 'active', error = null,
      timezone = coalesce(excluded.timezone, integrations.timezone), currency = coalesce(excluded.currency, integrations.currency),
      display_name = coalesce(excluded.display_name, integrations.display_name),
      token_expires_at = excluded.token_expires_at, expiry_warned_at = null, stale_notified_at = null
    returning id`;
  if (input.provider === 'shopify') {
    const claimed = await tx`insert into shopify_shops (shop_domain, workspace_id, integration_id) values (${input.externalAccountId}, ${ctx.workspaceId}, ${row!.id})
                             on conflict (shop_domain) do nothing returning shop_domain`;
    // Nothing inserted: the shop is routed already — to this workspace (a reconnect), or to another one that
    // connected it concurrently, which must fail like the check above (one active workspace per shop).
    if (!claimed.length) await assertShopRoutable(tx, input.externalAccountId);
  }
  await emit(tx, ctx, 'INTEGRATION_CONNECTED', { type: 'integration', id: row!.id as string }, { provider: input.provider, scopes: input.scopes });
  // Standard §7 "Ad account connected — Meta/TikTok connection rate".
  if (input.provider === 'meta' || input.provider === 'tiktok') {
    await recordFunnel('AD_ACCOUNT_CONNECTED', { workspaceId: ctx.workspaceId, visitorId: await workspaceVisitor(tx, ctx.workspaceId), props: { provider: input.provider } }, tx);
  }
  await enqueue(tx, ctx.workspaceId, Queues.syncIntegration, { integrationId: row!.id, full: true }, { singletonKey: `sync:${row!.id}` });
  return row!.id as string;
}

/**
 * One active workspace per shop — webhook routing must be unambiguous (plan 02 §3 layer 8). shopify_shops is
 * tenant-scoped; the cross-tenant "connected elsewhere" check and the masked owner are narrow definer functions.
 */
async function assertShopRoutable(tx: Tx, shop: string) {
  const [owner] = await tx`select shop_connected_elsewhere(${shop}) as elsewhere, shop_owner_hint(${shop}) as hint`;
  if (owner?.elsewhere) {
    const hint = (owner.hint as string | null) ?? null;
    throw new DomainError('CONFLICT', `This store is connected to another workspace${hint ? ` (owner ${hint})` : ''}. Request a transfer?`, { transfer: true, shop, ownerHint: hint });
  }
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
 * (with the permissions it was granted and when it expires) and the row expires after 30 minutes.
 */
export async function stashPendingConnection(
  tx: Tx,
  ctx: TenantContext,
  provider: 'meta' | 'tiktok',
  token: string,
  accounts: PendingAccount[],
  platformUserId: string | null = null,
  grant: { scopes?: string[]; expiresAt?: Date | null } = {},
) {
  assertCan(ctx, 'integration.manage');
  await tx`delete from pending_connections where expires_at < now()`;
  const [r] = await tx`insert into pending_connections (workspace_id, provider, token_enc, accounts, created_by, platform_user_id, scopes, token_expires_at)
                       values (${ctx.workspaceId}, ${provider}, ${encryptToken(token)}, ${tx.json(accounts as never)}, ${ctx.actor.kind === 'user' ? ctx.actor.id : null}, ${platformUserId},
                               ${grant.scopes ?? []}, ${grant.expiresAt ?? null})
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
  const [p] = await tx`select id, provider, token_enc, accounts, platform_user_id, scopes, token_expires_at from pending_connections where id = ${pendingId} and expires_at > now() for update`;
  if (!p) throw new DomainError('CONFLICT', 'That connection expired. Connect again to choose accounts.');
  const offered = p.accounts as PendingAccount[];
  const chosen = offered.filter((a) => accountIds.includes(a.id));
  if (!chosen.length) throw new DomainError('INVALID', 'Choose at least one ad account.');
  if (chosen.length !== new Set(accountIds).size) throw new DomainError('INVALID', 'That account isn’t on this login.');
  const token = decryptToken(p.token_enc as string);
  const provider = p.provider as 'meta' | 'tiktok';
  const granted = (p.scopes as string[] | null) ?? [];
  const ids: string[] = [];
  for (const a of chosen) {
    ids.push(
      await saveIntegration(tx, ctx, {
        provider,
        externalAccountId: a.id,
        displayName: a.name,
        token,
        scopes: granted.length ? granted : ['ads_read'],
        currency: a.currency,
        timezone: a.timezone,
        platformUserId: (p.platform_user_id as string | null) ?? null,
        tokenExpiresAt: (p.token_expires_at as Date | null) ?? null,
      }),
    );
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
 * Every reported value of an observation (§45 "late conversions": a re-pulled row that changed any of them is a
 * revision). Column → the normalized field it stores.
 */
const OBSERVED_VALUES: [string, (o: NormalizedObservation) => number | string | null][] = [
  ['spend_micros', (o) => o.spendMicros],
  ['impressions', (o) => o.impressions],
  ['reach', (o) => o.reach],
  ['frequency', (o) => o.frequency],
  ['clicks', (o) => o.clicks],
  ['outbound_clicks', (o) => o.outboundClicks],
  ['video_starts', (o) => o.videoStarts],
  ['video_25', (o) => o.video25],
  ['video_50', (o) => o.video50],
  ['video_75', (o) => o.video75],
  ['video_100', (o) => o.video100],
  ['avg_watch_ms', (o) => (o.avgWatchMs == null ? null : Math.round(o.avgWatchMs))],
  ['add_to_cart', (o) => o.addToCart],
  ['checkout', (o) => o.checkout],
  ['purchases', (o) => o.purchases],
  ['purchase_value_micros', (o) => o.purchaseValueMicros],
  ['currency', (o) => (o.currency || 'USD').toUpperCase()],
  ['campaign_type', (o) => o.campaignType],
  ['optimization_event', (o) => o.optimizationEvent],
];

/** Did the platform report anything different from the stored revision? */
export function observationChanged(prev: Record<string, unknown>, o: NormalizedObservation): boolean {
  return OBSERVED_VALUES.some(([col, get]) => {
    const a = prev[col] ?? null;
    const b = get(o) ?? null;
    if (a == null || b == null) return (a == null) !== (b == null);
    if (typeof b === 'number') return Math.abs(Number(a) - b) > (col === 'frequency' ? 1e-6 : 0);
    return String(a) !== String(b);
  });
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
    // Two writers of the same ad/day/context/window (a sync and a CSV import, or a retried page) serialise here,
    // so each reads the other's revision instead of both inserting revision N+1 (x-races-16).
    await tx`select pg_advisory_xact_lock(hashtext(${`obs:${ctx.workspaceId}:${o.platform}:${o.adId}:${o.date}:${o.measurementContext}:${o.attributionWindow}`}))`;
    const [prev] = await tx`
      select * from performance_observations
      where platform = ${o.platform} and ad_id = ${o.adId} and date = ${o.date} and measurement_context = ${o.measurementContext}
        and attribution_window = ${o.attributionWindow} and placement = ${placement} and superseded_at is null`;
    if (prev && !observationChanged(prev, { ...o, currency })) continue;
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
    // Revision numbers run over the whole key (placements included), matching the table's unique key.
    const [rev] = await tx`select coalesce(max(revision), 0) + 1 as next from performance_observations
                           where platform = ${o.platform} and ad_id = ${o.adId} and date = ${o.date} and measurement_context = ${o.measurementContext}
                             and attribution_window = ${o.attributionWindow}`;
    await tx`
      insert into performance_observations (workspace_id, integration_id, platform, account_id, campaign_id, adgroup_id, ad_id, date, currency,
        spend_micros, impressions, reach, frequency, clicks, outbound_clicks, video_starts, video_25, video_50, video_75, video_100, avg_watch_ms,
        add_to_cart, checkout, purchases, purchase_value_micros, attribution_model, attribution_window, optimization_event, campaign_type,
        measurement_context, revision, placement, source_timezone, fx_rate, reporting_currency, spend_reporting_micros, value_reporting_micros, adapter_version)
      values (${ctx.workspaceId}, ${integrationId}, ${o.platform}, ${o.accountId}, ${o.campaignId}, ${o.adgroupId}, ${o.adId}, ${o.date}, ${currency},
        ${o.spendMicros}, ${o.impressions}, ${o.reach}, ${o.frequency}, ${o.clicks}, ${o.outboundClicks}, ${o.videoStarts}, ${o.video25}, ${o.video50},
        ${o.video75}, ${o.video100}, ${o.avgWatchMs == null ? null : Math.round(o.avgWatchMs)}, ${o.addToCart}, ${o.checkout}, ${o.purchases}, ${o.purchaseValueMicros},
        ${o.attributionModel}, ${o.attributionWindow}, ${o.optimizationEvent}, ${o.campaignType}, ${o.measurementContext}, ${Number(rev!.next)},
        ${placement}, ${tz}, ${rate}, ${reporting}, ${rate == null ? null : Math.round(o.spendMicros * rate)}, ${rate == null ? null : Math.round(o.purchaseValueMicros * rate)},
        ${o.adapterVersion ?? null})`;
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

/** Consecutive transient failures (outages, dropped connections) before a connection is shown as degraded. */
export const TRANSIENT_FAILURES_BEFORE_DEGRADED = 5;
/** Longest wait between automatic retries of a failing connection. */
const MAX_BACKOFF_MINUTES = 6 * 60;
/** Minutes until the next automatic retry after the n-th consecutive failure: 5, 10, 20, 40 … capped at 6 hours. */
export const syncBackoffMinutes = (failures: number) => Math.min(MAX_BACKOFF_MINUTES, 5 * 2 ** Math.max(0, failures - 1));

/** The error a failed sync leaves on the connection, with its retry schedule. */
export interface SyncError {
  kind: ConnectorError['kind'];
  message: string;
  at: string;
  /** Consecutive failed syncs (reset by a successful one). */
  failures: number;
  /** When the scheduled sweep may retry; absent for errors that need the merchant (revoked, partial scopes) or an adapter fix. */
  nextRetryAt?: string;
}

/**
 * A failed sync (§47). Revoked access marks the connection revoked at once (and emails the owners); a rate limit
 * keeps it active (the retry resumes from the checkpoint); a transient outage keeps it active with an
 * exponential-backoff retry until it has failed TRANSIENT_FAILURES_BEFORE_DEGRADED times in a row; a request,
 * permission or schema error degrades it. Every status change is announced (INTEGRATION_DEGRADED,
 * DATA_FRESHNESS_CHANGED) once, not on every failed retry.
 */
export async function markError(ctx: TenantContext, integrationId: string, e: ConnectorError): Promise<{ status: string; nextRetryAt: Date | null }> {
  return withTenant(ctx.workspaceId, async (tx) => {
    const [cur] = await tx`select status, error, provider from integrations where id = ${integrationId} and workspace_id = ${ctx.workspaceId} for update`;
    if (!cur) return { status: 'missing', nextRetryAt: null };
    const prevStatus = cur.status as string;
    const failures = e.kind === 'rate_limited' ? Number((cur.error as SyncError | null)?.failures ?? 0) : Number((cur.error as SyncError | null)?.failures ?? 0) + 1;
    const status =
      e.kind === 'auth_revoked' ? 'revoked'
      : e.kind === 'rate_limited' ? (prevStatus === 'degraded' ? 'degraded' : 'active')
      : e.kind === 'network' ? (failures >= TRANSIENT_FAILURES_BEFORE_DEGRADED || prevStatus === 'degraded' ? 'degraded' : 'active')
      : 'degraded';
    const retryable = e.kind === 'network' || e.kind === 'invalid';
    const nextRetryAt = e.kind === 'rate_limited' ? new Date(Date.now() + (e.retryAfterSec ?? 60) * 1000) : retryable ? new Date(Date.now() + syncBackoffMinutes(failures) * 60_000) : null;
    const error: SyncError = { kind: e.kind, message: e.message.slice(0, 500), at: new Date().toISOString(), failures, ...(nextRetryAt ? { nextRetryAt: nextRetryAt.toISOString() } : {}) };
    await tx`update integrations set status = ${status}, error = ${tx.json(error as never)} where id = ${integrationId} and workspace_id = ${ctx.workspaceId}`;
    // Rate-limit history per connection (plan 05 §2.2 Integrations): every throttle the platform answered with.
    if (e.kind === 'rate_limited') {
      await tx`insert into integration_rate_limits (workspace_id, integration_id, provider, message, retry_after_sec)
               values (${ctx.workspaceId}, ${integrationId}, ${cur.provider as string}, ${e.message.slice(0, 500)}, ${e.retryAfterSec ?? null})`;
    }
    if (status !== prevStatus) {
      if (status !== 'active') await emit(tx, ctx, 'INTEGRATION_DEGRADED', { type: 'integration', id: integrationId }, { kind: e.kind });
      await emit(tx, ctx, 'DATA_FRESHNESS_CHANGED', { type: 'integration', id: integrationId }, { status, from: prevStatus });
    }
    // §47 "OAuth revoked": stop claiming fresh insight and tell the owners to reconnect (plan 03 A10).
    if (status === 'revoked' && prevStatus !== 'revoked') {
      await enqueue(tx, ctx.workspaceId, Queues.sendEmail, { template: 'integration_disconnected', provider: PROVIDER_LABEL[cur.provider as Provider] ?? cur.provider }, { singletonKey: `integration-revoked:${integrationId}` });
    }
    // Transient outages and request errors retry on their own with backoff (the sweep retries a degraded one too).
    if (nextRetryAt && status !== 'revoked') {
      await enqueue(tx, ctx.workspaceId, Queues.syncIntegration, { integrationId }, { runAfter: nextRetryAt, singletonKey: `sync:${integrationId}:retry` });
    }
    return { status, nextRetryAt };
  });
}

/** Calendar date (YYYY-MM-DD) of an instant in a timezone; UTC for an unknown zone. */
export function dateInZone(at: Date, timezone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Where an interrupted sync resumes: its window and the next page to fetch (Meta `after` cursor, TikTok page number). */
export interface SyncCursor {
  lastDate?: string;
  resume?: { since: string; until: string; provider: Provider; page: string | number };
  /** TikTok Shop stores the advertiser runs GMV Max for (discovered once, §30). */
  stores?: string[];
}

/** TikTok resume pages: the regular report's page number, or `gmv:<n>` once the GMV Max report is being read. */
const gmvPage = (p: string | number | undefined) => (typeof p === 'string' && p.startsWith('gmv:') ? Math.max(1, Number(p.slice(4)) || 1) : null);

/**
 * Sync one integration with checkpointing (§47 "Backoff, checkpoint, resume"): after every ingested page the
 * position is saved with that page's rows, so a rate-limited sync resumes on the page it stopped at — not from the
 * start of its window — and the merchant sees data freshness rather than an error. One run per integration at a
 * time is enforced by the job lease (worker handlers).
 */
export async function syncIntegration(ctx: TenantContext, integrationId: string, opts: { full?: boolean } = {}) {
  const i = await withTenant(ctx.workspaceId, async (tx) => (await tx`select * from integrations where id = ${integrationId}`)[0]);
  if (!i || !i.token_enc || i.status === 'disconnected' || i.status === 'revoked' || i.status === 'paused') return { skipped: true };
  if (env().PROVIDERS_MODE === 'mock' && String(i.external_account_id).startsWith('demo')) return { skipped: true };
  const token = decryptToken(i.token_enc as string);
  const cursor = (i.cursor ?? {}) as SyncCursor;
  const provider = i.provider as Provider;
  const accountId = i.external_account_id as string;
  const tz = (i.timezone as string | null) ?? null;
  const resume = !opts.full && cursor.resume?.provider === provider ? cursor.resume : null;
  // Dates are the account's reporting days (§47 timezone): today there is still filling in.
  const today = dateInZone(new Date(), tz);
  // Re-pull a trailing window each sync so late conversions can revise history.
  const since = resume?.since ?? (opts.full || !cursor.lastDate ? addDays(today, -90) : addDays(cursor.lastDate, -7));
  const until = resume?.until ?? today;
  let stores = cursor.stores;
  const keep = () => ({ ...(cursor.lastDate ? { lastDate: cursor.lastDate } : {}), ...(stores ? { stores } : {}) });
  /** Ingest one page and, in the same transaction, record where the next one starts. */
  const ingestPage = (rows: NormalizedObservation[], next: string | number | null) =>
    withTenant(ctx.workspaceId, async (tx) => {
      await ingestObservations(tx, ctx, integrationId, rows);
      const c: SyncCursor = { ...keep(), ...(next != null ? { resume: { since, until, provider, page: next } } : {}) };
      await tx`update integrations set cursor = ${tx.json(c as never)} where id = ${integrationId}`;
    });
  try {
    if (provider === 'meta') {
      let after: string | null = resume ? String(resume.page) : null;
      do {
        const page = await metaFetchInsights(token, accountId, since, until, after);
        after = page.next;
        await ingestPage(page.rows, after);
      } while (after);
    } else if (provider === 'tiktok') {
      const currency = (i.currency as string) ?? 'USD';
      // Campaign types and ad-group attribution windows, read once per sync for the campaigns seen (§30, §45).
      const types = new Map<string, string | null>();
      const windows = new Map<string, string>();
      const startGmv = gmvPage(resume?.page);
      /**
       * Campaign and ad-group lookups the app may lack permission for: without them the report is still read (GMV Max
       * arrives through its own report and context either way); the gap is logged, the sync does not fail on it.
       */
      const lookup = <V>(p: Promise<Map<string, V>>, what: string) =>
        p.catch((e: unknown) => {
          if (e instanceof ConnectorError && (e.kind === 'invalid' || e.kind === 'partial_scopes')) {
            log.warn(`tiktok ${what} unavailable`, { integrationId, kind: e.kind });
            return new Map<string, V>();
          }
          throw e;
        });
      if (startGmv == null) {
        let pageNo = resume ? Math.max(1, Number(resume.page) || 1) : 1;
        for (;;) {
          const page = await tiktokFetchReport(token, accountId, since, until, pageNo);
          const campaigns = [...new Set(page.list.map((r) => r.metrics.campaign_id).filter((c): c is string => !!c && !types.has(c)))];
          if (campaigns.length) for (const [id, t] of await lookup(tiktokFetchCampaignTypes(token, accountId, campaigns), 'campaign types')) types.set(id, t);
          const groups = [...new Set(page.list.map((r) => r.metrics.adgroup_id).filter((g): g is string => !!g && !windows.has(g)))];
          if (groups.length) for (const [id, w] of await lookup(tiktokFetchAdgroupWindows(token, accountId, groups), 'attribution windows')) windows.set(id, w);
          const rows = page.list.map((r) => {
            const o = normalizeTikTokRow(r, accountId, currency, (r.metrics.campaign_id && types.get(r.metrics.campaign_id)) ?? r.metrics.campaign_type ?? null);
            const w = o.measurementContext === 'TIKTOK_PAID_ATTRIBUTED' && o.adgroupId ? windows.get(o.adgroupId) : undefined;
            return w ? { ...o, attributionWindow: w } : o;
          });
          await ingestPage(rows, page.hasMore ? pageNo + 1 : 'gmv:1');
          if (!page.hasMore) break;
          pageNo++;
        }
      }
      // GMV Max (organic + affiliate + paid, §30): its own report per TikTok Shop, ingested as TIKTOK_GMV_MAX_TOTAL.
      if (!stores) {
        stores = await tiktokFetchGmvMaxStores(token, accountId).catch((e) => {
          // No TikTok Shop, or the app lacks the GMV Max permission: regular reporting carries on without it.
          if (e instanceof ConnectorError && (e.kind === 'invalid' || e.kind === 'partial_scopes')) return [];
          throw e;
        });
      }
      if (stores.length) {
        let pageNo = startGmv ?? 1;
        for (;;) {
          const page = await tiktokFetchGmvMaxReport(token, accountId, stores, since, until, pageNo);
          const campaigns = [...new Set(page.list.map((r) => r.dimensions.campaign_id).filter((c): c is string => !!c && !types.has(c)))];
          if (campaigns.length) for (const [id, t] of await lookup(tiktokFetchCampaignTypes(token, accountId, campaigns), 'campaign types')) types.set(id, t);
          const rows = page.list.map((r) => normalizeTikTokGmvMaxRow(r, accountId, currency, types.get(r.dimensions.campaign_id ?? '') ?? 'PRODUCT_GMV_MAX'));
          await ingestPage(rows, page.hasMore ? `gmv:${pageNo + 1}` : null);
          if (!page.hasMore) break;
          pageNo++;
        }
      }
    } else if (provider === 'shopify') {
      await syncShopifyProducts(ctx, integrationId, accountId, token);
    }
    if (provider === 'meta' || provider === 'tiktok') await markPlatformDeletedCreatives(ctx, integrationId, provider, token, accountId);
    await withTenant(ctx.workspaceId, async (tx) => {
      const [prev] = await tx`select status, stale_notified_at from integrations where id = ${integrationId} for update`;
      // The last day whose data is complete is yesterday in the account's timezone (today is still arriving).
      await tx`update integrations set status = 'active', error = null, last_success_at = now(), last_complete_date = ${addDays(until, -1)},
                 stale_notified_at = null, cursor = ${tx.json({ lastDate: until, ...(stores ? { stores } : {}) } as never)} where id = ${integrationId}`;
      // A recovery is announced as a freshness change too (Appendix B), not only degradation.
      if (prev && (prev.status !== 'active' || prev.stale_notified_at)) {
        await emit(tx, ctx, 'DATA_FRESHNESS_CHANGED', { type: 'integration', id: integrationId }, { status: 'active', from: prev.status !== 'active' ? prev.status : 'stale' });
      }
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof ConnectorError) {
      await markError(ctx, integrationId, e);
      return { ok: false, error: e.kind };
    }
    throw e;
  }
}

/**
 * Historical creatives whose ads were deleted on the platform (§48): the creative's source is marked deleted —
 * its lineage and observations stay; nothing is synthesised for the missing days. An ad the platform didn't
 * answer for is unknown and changes nothing. Best effort: a failed status lookup doesn't fail the sync.
 */
async function markPlatformDeletedCreatives(ctx: TenantContext, integrationId: string, provider: 'meta' | 'tiktok', token: string, accountId: string) {
  const key = `${provider}_ad_ids`;
  const creatives = await withTenant(ctx.workspaceId, (tx) => tx`
    select c.id, c.source_deleted_at, array(
      select distinct a from jsonb_array_elements_text(c.platform_refs->${key}) a
      where exists (select 1 from performance_observations o where o.integration_id = ${integrationId} and o.platform = ${provider} and o.ad_id = a)) as ad_ids
    from creatives c where jsonb_typeof(c.platform_refs->${key}) = 'array' limit 500`);
  const linked = creatives.filter((c) => (c.ad_ids as string[]).length);
  if (!linked.length) return;
  const adIds = [...new Set(linked.flatMap((c) => c.ad_ids as string[]))].slice(0, 1000);
  let statuses: Map<string, { status: string; deleted: boolean }>;
  try {
    statuses = provider === 'meta' ? await metaFetchAdStatuses(token, adIds) : await tiktokFetchAdStatuses(token, accountId, adIds);
  } catch (e) {
    if (e instanceof ConnectorError && e.kind !== 'auth_revoked') {
      log.warn('ad status lookup failed', { integrationId, provider, kind: e.kind });
      return;
    }
    throw e;
  }
  await withTenant(ctx.workspaceId, async (tx) => {
    for (const c of linked) {
      const ids = c.ad_ids as string[];
      const known = ids.map((id) => statuses.get(id)).filter((s): s is { status: string; deleted: boolean } => !!s);
      if (known.length !== ids.length) continue;
      const deleted = known.every((s) => s.deleted);
      if (deleted && !c.source_deleted_at) await tx`update creatives set source_deleted_at = now() where id = ${c.id}`;
      else if (!deleted && c.source_deleted_at) await tx`update creatives set source_deleted_at = null where id = ${c.id}`;
    }
  });
}

/** Shopify is the canonical commerce source (§28): capture IDs and keep raw snapshots via facts provenance. */
async function syncShopifyProducts(ctx: TenantContext, integrationId: string, shop: string, token: string) {
  // An unsaved preview workspace (a visitor who connected their store from the upload step, plan 03 P2) imports
  // only the product the visitor picks (pickShopifyProduct), within the preview's product cap — never the catalogue.
  const [ws] = await withTenant(ctx.workspaceId, (tx) => tx`select state from workspaces where id = ${ctx.workspaceId}`);
  if (ws?.state === 'PROVISIONAL') return;
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
      await withTenant(ctx.workspaceId, (tx) => applyShopifyProduct(tx, ctx, shop, p, page.currency, { integrationId }));
    }
    cursor = page.next;
  } while (cursor && seen <= 60);
}

/**
 * One product changed in the store (products/create or products/update webhook, §28 "re-sync on webhook"): fetch
 * it and apply it like the scheduled sync would. A product the store no longer has is archived.
 */
export async function syncShopifyProduct(ctx: TenantContext, integrationId: string, productId: string) {
  const i = await withTenant(ctx.workspaceId, async (tx) => (await tx`select * from integrations where id = ${integrationId} and provider = 'shopify'`)[0]);
  if (!i || !i.token_enc || !['active', 'degraded'].includes(i.status as string)) return { skipped: true };
  if (env().PROVIDERS_MODE === 'mock' && String(i.external_account_id).startsWith('demo')) return { skipped: true };
  try {
    const r = await shopifyFetchProduct(i.external_account_id as string, decryptToken(i.token_enc as string), productId);
    return await withTenant(ctx.workspaceId, async (tx) => {
      if (!r.product) return { archived: await archiveShopifyProduct(tx, ctx, productId) };
      return { applied: await applyShopifyProduct(tx, ctx, i.external_account_id as string, r.product, r.currency ?? (i.currency as string | null), { integrationId }) };
    });
  } catch (e) {
    if (e instanceof ConnectorError) {
      await markError(ctx, integrationId, e);
      return { ok: false, error: e.kind };
    }
    throw e;
  }
}

/** products/delete: the SKU made from the product is archived (its history and lineage stay). */
export async function archiveShopifyProduct(tx: Tx, ctx: TenantContext, productId: string): Promise<boolean> {
  const gid = shopifyGid('Product', productId);
  const [s] = await tx`update skus set status = 'archived' where shopify_product_id = ${gid} and status <> 'archived' returning id`;
  if (!s) return false;
  await recordFacts(tx, ctx, s.id as string, [{ key: 'shopify_status', valueText: 'DELETED', sourceType: 'shopify', sourceId: gid, state: 'OBSERVED' }]);
  return true;
}

/** Raw product snapshot hash (§28 "preserve the raw payload snapshot/hash"): changes whenever the store's product does. */
export const shopifySnapshotHash = (p: ShopifyProduct) => createHash('sha256').update(JSON.stringify(p)).digest('hex');

/**
 * One Shopify product into the catalogue: facts (with provenance), variants in the shop's currency, and the
 * operational signals a store change carries (§45, §48): a price or compare-at change opens a confounder window
 * through the facts; the product selling out opens an ongoing stock-out window that closes when it is back.
 * A product seen for the first time becomes a SKU that goes through the Product Brain pipeline (fingerprint,
 * claims, scope checks) like any imported product.
 */
export async function applyShopifyProduct(tx: Tx, ctx: TenantContext, shop: string, p: ShopifyProduct, currency: string | null, opts: { integrationId?: string } = {}): Promise<'created' | 'updated' | 'skipped'> {
  const productId = shopifyGid('Product', p.id);
  let [sku] = await tx`select id from skus where shopify_product_id = ${productId}`;
  let created = false;
  if (!sku) {
    if (p.status !== 'ACTIVE') return 'skipped';
    if (!(await withinShopifyImportAllowance(tx, ctx))) return 'skipped';
    const no = await nextCatalogueNo(tx);
    const url = p.onlineStoreUrl || (p.handle ? `https://${shop}/products/${p.handle}` : `https://${shop}`);
    const [brand] = await tx`select id from brands order by created_at limit 1`;
    // The (workspace, product) unique index makes a concurrent import of the same product a no-op here.
    [sku] = await tx`insert into skus (workspace_id, brand_id, catalogue_no, name, status, source_kind, shopify_product_id, source_url)
                     values (${ctx.workspaceId}, ${brand?.id ?? null}, ${no}, ${p.title}, 'analyzing', 'shopify', ${productId}, ${url})
                     on conflict (workspace_id, shopify_product_id) where shopify_product_id is not null do nothing returning id`;
    if (sku) created = true;
    else [sku] = await tx`select id from skus where shopify_product_id = ${productId}`;
    if (!sku) return 'skipped';
  }
  const skuId = sku!.id as string;
  const [was] = await tx`select bool_or(available) as any_available, count(*)::int as n from sku_variants where sku_id = ${skuId} and source = 'shopify'`;
  const v0 = p.variants[0];
  const src = (key: string, v: Omit<FactInput, 'key' | 'sourceType' | 'state'>, sourceId: string | undefined = productId): FactInput => ({ key, sourceType: 'shopify', sourceId, state: 'OBSERVED', ...v });
  const money = currency ? { currency } : undefined;
  await recordFacts(tx, ctx, skuId, [
    src('name', { valueText: p.title }),
    src('description', { valueText: p.descriptionText.slice(0, 4000) || null }),
    src('brand', { valueText: p.vendor ?? null }),
    src('product_type', { valueText: p.productType ?? null }),
    src('price', { valueNumber: v0?.price ?? null, valueJson: money }, v0?.id),
    src('compare_at_price', { valueNumber: v0?.compareAtPrice ?? null, valueJson: v0?.compareAtPrice ? money : undefined }, v0?.id),
    src('variants', { valueJson: p.variants }),
    src('options', { valueJson: p.options?.length ? p.options : null }),
    src('sku_code', { valueText: v0?.sku ?? null }, v0?.id),
    src('gtin', { valueText: v0?.barcode ?? null }, v0?.id),
    src('images', { valueJson: p.images.length ? p.images.slice(0, 6) : null }),
    // Metafields that state product truth (ingredients, size, shade), with the metafield named as the source record.
    ...shopifyMetafieldFacts(p.metafields ?? []).map((m) => src(m.key, { valueText: m.value, sourceUrl: `shopify-metafield:${m.source}` })),
    src('source_snapshot', { valueJson: { sha256: shopifySnapshotHash(p), updatedAt: p.updatedAt || null } }),
  ]);
  // §42: variant-specific price, availability and image.
  await recordVariants(tx, ctx, skuId, 'shopify', p.variants.map((v) => ({
    externalId: shopifyGid('ProductVariant', v.id),
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
      await recordAutomaticConfounder(tx, ctx, { skuId, kind: 'stockout', endsAt: null, note: 'Sold out in Shopify', detail: { shopifyProductId: productId } });
    } else if (nowAvailable) {
      await closeAutomaticConfounders(tx, skuId, 'stockout');
    }
  }
  if (created) {
    await emit(tx, ctx, 'PRODUCT_IMPORTED', { type: 'sku', id: skuId }, { source: 'shopify', shopifyProductId: productId, integrationId: opts.integrationId ?? null });
    await startShopifyAnalysis(tx, ctx, skuId);
  }
  if (p.status !== 'ACTIVE') await tx`update skus set status = 'archived' where id = ${skuId}`;
  return created ? 'created' : 'updated';
}

/**
 * Free workspaces get the same daily allowance of new products from their store as from links (standard §5
 * bounded free-preview COGS); the rest are picked up by a later sync. Paying workspaces import the catalogue.
 */
async function withinShopifyImportAllowance(tx: Tx, ctx: TenantContext): Promise<boolean> {
  if (!isFreeTier(ctx)) return true;
  const [n] = await tx`select count(*)::int as n from skus where created_at > now() - interval '24 hours'`;
  return n!.n < FREE_EXPLORATION.SKUS_PER_DAY;
}

/**
 * "Connect Shopify" from the upload step (standard §13 "Shopify connection must be first-class"; plan 03 P2): the
 * visitor's store products, to pick the one to preview. Reads the connected store's live catalogue (first page).
 */
export async function listShopifyProductsForPick(ctx: TenantContext): Promise<{ shop: string; products: { id: string; title: string; image: string | null; priceMicros: number | null; currency: string | null }[] } | null> {
  const [i] = await withTenant(ctx.workspaceId, (tx) => tx`select external_account_id, token_enc from integrations where provider = 'shopify' and status = 'active' and workspace_id = ${ctx.workspaceId} order by created_at desc limit 1`);
  if (!i) return null;
  const page = await shopifyFetchProducts(i.external_account_id as string, decryptToken(i.token_enc as string), null);
  return {
    shop: i.external_account_id as string,
    products: page.products
      .filter((p) => p.status === 'ACTIVE')
      .slice(0, 60)
      .map((p) => ({ id: p.id, title: p.title, image: p.images[0] ?? null, priceMicros: p.variants[0]?.price ? Math.round(p.variants[0].price * 1_000_000) : null, currency: page.currency })),
  };
}

/**
 * The visitor picked a product from their connected store: it becomes a SKU with its store facts (OBSERVED,
 * source shopify) and a preview project, analysed like a link import. Within the same product caps as any
 * preview (provisional: PROVISIONAL.MAX_SKUS; free accounts: products a day). A product already imported
 * opens its latest project.
 */
export async function pickShopifyProduct(ctx: TenantContext, productId: string, opts: { ip?: string | null; visitorId?: string | null } = {}): Promise<{ skuId: string; projectId: string }> {
  assertCan(ctx, 'sku.create');
  const [i] = await withTenant(ctx.workspaceId, (tx) => tx`select id, external_account_id, token_enc, currency from integrations where provider = 'shopify' and status = 'active' and workspace_id = ${ctx.workspaceId} order by created_at desc limit 1`);
  if (!i) throw new DomainError('NOT_FOUND', 'Connect your Shopify store first.');
  const r = await shopifyFetchProduct(i.external_account_id as string, decryptToken(i.token_enc as string), productId);
  if (!r.product || r.product.status !== 'ACTIVE') throw new DomainError('NOT_FOUND', 'That product isn’t available in your store.');
  const product = r.product;
  return withTenant(ctx.workspaceId, async (tx) => {
    const gid = shopifyGid('Product', product.id);
    const [existing] = await tx`select s.id, (select p.id from projects p where p.sku_id = s.id order by p.created_at desc limit 1) as project_id from skus s where s.shopify_product_id = ${gid}`;
    if (existing?.project_id) return { skuId: existing.id as string, projectId: existing.project_id as string };
    const { assertCanAddSku } = await import('./analysis');
    await assertCanAddSku(tx, ctx, opts.ip ?? null);
    const outcome = await applyShopifyProduct(tx, ctx, i.external_account_id as string, product, r.currency ?? (i.currency as string | null), { integrationId: i.id as string });
    const [created] = await tx`select s.id, (select p.id from projects p where p.sku_id = s.id order by p.created_at desc limit 1) as project_id from skus s where s.shopify_product_id = ${gid}`;
    if (outcome === 'skipped' || !created?.project_id) throw new DomainError('PAYMENT_REQUIRED', 'You’ve added all the products you can for now. Save your work to add more.', { needsAccount: ctx.workspaceState === 'PROVISIONAL' });
    // Funnel attribution like any preview (the visitor who started it; an upload completed by store pick).
    await tx`update skus set origin_visitor_id = coalesce(origin_visitor_id, ${opts.visitorId ?? null}) where id = ${created.id}`;
    await recordFunnel('UPLOAD_COMPLETED', { visitorId: opts.visitorId ?? null, workspaceId: ctx.workspaceId, props: { method: 'shopify' } }, tx);
    return { skuId: created.id as string, projectId: created.project_id as string };
  });
}

/**
 * The Product Brain pipeline for a SKU created from the store (standard §9 Day 0–1, plan 06 Phase 1): the same
 * analysis project and steps as a link import, reading the Shopify facts instead of the product page. Spend goes
 * through the Cost Governor in analyzeProduct, under the same per-product cap as any preview.
 */
async function startShopifyAnalysis(tx: Tx, ctx: TenantContext, skuId: string) {
  const { ANALYSIS_STEPS } = await import('./analysis');
  const projectId = newId();
  await tx`insert into projects (id, workspace_id, sku_id, kind, state, created_by)
           values (${projectId}, ${ctx.workspaceId}, ${skuId}, 'preview', 'PRODUCT_UPLOADED', ${ctx.actor.kind + ':' + ctx.actor.id})`;
  await planSteps(tx, ctx.workspaceId, skuId, ANALYSIS_STEPS.filter((s) => s.key !== 'read_page'));
  await enqueue(tx, ctx.workspaceId, queueFor(Queues.analyzeProduct, ctx), { skuId, projectId }, { priority: priorityFor(ctx) });
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

/** Meta's "Attribution setting" ("7-day click or 1-day view", "1-day click") as our window key ("7d_click_1d_view"). */
export function csvAttributionWindow(v: string): string | null {
  const t = v.toLowerCase();
  const click = /(\d+)[- ]?day(?:s)? click/.exec(t)?.[1];
  const view = /(\d+)[- ]?day(?:s)? (?:view|engaged)/.exec(t)?.[1];
  if (!click && !view) return null;
  return [click ? `${click}d_click` : null, view ? `${view}d_view` : null].filter(Boolean).join('_');
}

/**
 * Manual import (CSV from Meta or TikTok Ads Manager). The merchant says which platform the export is from; each
 * platform's rows get their own context (MERCHANT_IMPORTED_META / _TIKTOK) so a variant's Meta and TikTok numbers
 * are never pooled into one result (§48), and never mixed with API-attributed data (§30). A file whose columns
 * are the other platform's is refused. Quoted fields (ad names with commas), `;`/tab-delimited European exports
 * and locale number formats are read as written; the currency comes from the file ("Amount spent (EUR)", a
 * Currency column) or the uploader, never assumed (§47). Purchases are read only from a purchases column: Ads
 * Manager's "Results" counts whatever the campaign optimises for.
 */
export function parsePerformanceCsv(csv: string, platform: CsvPlatform, opts: { timezone?: string | null; currency?: string | null } = {}): NormalizedObservation[] {
  const table = parseCsv(csv.trim());
  const head = (table.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const other: CsvPlatform = platform === 'meta' ? 'tiktok' : 'meta';
  const name = (p: CsvPlatform) => (p === 'meta' ? 'Meta' : 'TikTok');
  if (head.some((h) => CSV_FINGERPRINTS[other].test(h)) && !head.some((h) => CSV_FINGERPRINTS[platform].test(h))) {
    throw new DomainError('INVALID', `This looks like a ${name(other)} Ads Manager export. Choose ${name(other)} as the platform, or upload your ${name(platform)} export.`);
  }
  const idx = (...names: string[]) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  // Spend: "Amount spent (EUR)" names its currency; plain "Spend"/"Cost" columns rely on a Currency column or the uploader.
  const spendIdx = head.findIndex((h) => /^amount spent( \([a-z]{3}\))?$/.test(h) || ['spend', 'cost', 'total cost'].includes(h));
  const headerCurrency = spendIdx >= 0 ? /\(([a-z]{3})\)$/.exec(head[spendIdx]!)?.[1]?.toUpperCase() : undefined;
  const valueIdx = head.findIndex((h) => /^(website )?purchases conversion value|^purchase value|^total complete payment|^complete payment value|^gross revenue/.test(h));
  const purchasesIdx = idx('purchases', 'website purchases', 'purchases (all)', 'complete payment', 'total complete payment count', 'orders');
  if (purchasesIdx < 0 && head.some((h) => h === 'results' || h === 'conversions')) {
    throw new DomainError('INVALID', 'This export has “Results”/“Conversions” but no Purchases column. Results count whatever each campaign optimises for, so add the Purchases (or Complete payment) column to the export and upload it again.');
  }
  const col = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
  const get = (row: string[], ...names: string[]) => col(row, idx(...names));
  // One decimal separator per file, read from its money columns (a European export writes 12.000 for twelve
  // thousand); a semicolon-delimited file without a telling value is taken as decimal-comma.
  const decimal = detectDecimal(table.flatMap((r) => [col(r, spendIdx), col(r, valueIdx)]).filter(Boolean)) ?? ((csv.split(/\r?\n/, 1)[0] ?? '').includes(';') ? ',' : null);
  const num = (row: string[], i: number, label: string) => {
    const v = col(row, i);
    const n = parseLocaleNumber(v, decimal ?? undefined);
    if (Number.isNaN(n)) throw new DomainError('INVALID', `Couldn’t read “${v}” as a number in the ${label} column.`);
    return n;
  };
  const optNum = (row: string[], i: number, label: string) => (i >= 0 && col(row, i) !== '' ? num(row, i, label) || null : null);
  return table.map((r) => {
    const stated = get(r, 'platform').toLowerCase();
    if (stated && (/tiktok/.test(stated) ? 'tiktok' : /meta|facebook|instagram/.test(stated) ? 'meta' : platform) !== platform) {
      throw new DomainError('INVALID', `Row for ${stated} in a ${name(platform)} import. Upload each platform’s export separately.`);
    }
    const currency = (get(r, 'currency') || headerCurrency || opts.currency || 'USD').toUpperCase();
    const window = csvAttributionWindow(get(r, 'attribution setting', 'attribution window'));
    return {
      platform,
      accountId: get(r, 'account id', 'account') || 'manual',
      campaignId: get(r, 'campaign id') || null,
      adgroupId: get(r, 'ad set id', 'ad group id') || null,
      adId: get(r, 'ad id', 'ad') || get(r, 'ad name'),
      adName: get(r, 'ad name') || null,
      date: get(r, 'date', 'day', 'by day', 'reporting starts'),
      currency,
      spendMicros: Math.round(num(r, spendIdx, 'spend') * 1e6),
      impressions: num(r, idx('impressions'), 'impressions'),
      reach: optNum(r, idx('reach'), 'reach'),
      frequency: optNum(r, idx('frequency'), 'frequency'),
      clicks: num(r, idx('clicks', 'link clicks', 'clicks (destination)', 'clicks (all)'), 'clicks'),
      outboundClicks: optNum(r, idx('outbound clicks'), 'outbound clicks'),
      videoStarts: optNum(r, idx('video plays', '3-second video plays', 'video views'), 'video plays'),
      video25: optNum(r, idx('video plays at 25%', 'video views at 25%'), 'video 25%'),
      video50: optNum(r, idx('video plays at 50%', 'video views at 50%'), 'video 50%'),
      video75: optNum(r, idx('video plays at 75%', 'video views at 75%'), 'video 75%'),
      video100: optNum(r, idx('video plays at 100%', 'video views at 100%'), 'video 100%'),
      avgWatchMs: null,
      addToCart: optNum(r, idx('adds to cart', 'add to cart', 'website adds to cart'), 'adds to cart'),
      checkout: optNum(r, idx('checkouts initiated', 'initiate checkout', 'website checkouts initiated'), 'checkouts'),
      purchases: purchasesIdx >= 0 ? num(r, purchasesIdx, 'purchases') : 0,
      purchaseValueMicros: valueIdx >= 0 ? Math.round(num(r, valueIdx, 'purchase value') * 1e6) : 0,
      attributionModel: 'merchant_import',
      attributionWindow: window ?? 'merchant_import',
      optimizationEvent: get(r, 'result type', 'optimization event') || null,
      campaignType: null,
      measurementContext: csvContext(platform),
      // The day column is in the ad account's reporting timezone (§47); the uploader names it.
      sourceTimezone: get(r, 'timezone', 'time zone') || opts.timezone || null,
      adapterVersion: 'merchant-csv@2',
    };
  });
}

// ───────────── Scheduled freshness and token-expiry checks (§31, Appendix B; plan 05 §16) ─────────────

/** Days before a token's expiry that the owners are asked to reconnect. */
export const TOKEN_EXPIRY_WARNING_DAYS = 7;

/**
 * A connection whose last successful sync is older than FRESHNESS_DAYS is announced stale once
 * (DATA_FRESHNESS_CHANGED {status: 'stale'}); a successful sync clears the mark and announces the recovery.
 * System role: every row is tied to its own workspace explicitly, and the event is written in that tenant.
 */
export async function sweepStaleIntegrations(): Promise<number> {
  const rows = await withSystem((tx) => tx`
    select id, workspace_id, status from integrations
    where status in ('active', 'degraded') and stale_notified_at is null
      and coalesce(last_success_at, created_at) < now() - make_interval(days => ${FRESHNESS_DAYS})
    limit 500`);
  let n = 0;
  for (const r of rows) {
    const ws = r.workspace_id as string;
    const marked = await withTenant(ws, async (tx) => {
      const [m] = await tx`update integrations set stale_notified_at = now() where id = ${r.id as string} and workspace_id = ${ws} and stale_notified_at is null returning id`;
      if (!m) return false;
      await emit(tx, { workspaceId: ws, actor: { kind: 'system', id: 'freshness-sweep' } }, 'DATA_FRESHNESS_CHANGED', { type: 'integration', id: r.id as string }, { status: 'stale', from: r.status, days: FRESHNESS_DAYS });
      return true;
    });
    if (marked) n++;
  }
  return n;
}

/**
 * Access tokens that expire (Meta long-lived user tokens, ~60 days): TOKEN_EXPIRY_WARNING_DAYS before, the owners
 * are asked once to reconnect; at expiry the connection is marked revoked (tokens dropped, INTEGRATION_DISCONNECTED,
 * the disconnected email) instead of failing syncs until someone notices.
 */
export async function sweepExpiringTokens(): Promise<{ warned: number; expired: number }> {
  const rows = await withSystem((tx) => tx`
    select id, workspace_id, provider, token_expires_at, token_expires_at <= now() as expired from integrations
    where status in ('active', 'degraded') and token_expires_at is not null
      and (token_expires_at <= now() or (expiry_warned_at is null and token_expires_at <= now() + make_interval(days => ${TOKEN_EXPIRY_WARNING_DAYS})))
    limit 500`);
  let warned = 0;
  let expired = 0;
  for (const r of rows) {
    const ws = r.workspace_id as string;
    const id = r.id as string;
    const ctx = { workspaceId: ws, actor: { kind: 'system' as const, id: 'token-expiry' } };
    const provider = PROVIDER_LABEL[r.provider as Provider] ?? String(r.provider);
    await withTenant(ws, async (tx) => {
      if (r.expired) {
        const [i] = await tx`update integrations set status = 'revoked', token_enc = null, refresh_token_enc = null,
                               error = ${tx.json({ kind: 'auth_revoked', message: 'Access token expired', at: new Date().toISOString(), failures: 0 } as never)}
                             where id = ${id} and workspace_id = ${ws} and status in ('active', 'degraded') returning status`;
        if (!i) return;
        await emit(tx, ctx, 'INTEGRATION_DISCONNECTED', { type: 'integration', id }, { provider: r.provider, reason: 'token_expired' });
        await emit(tx, ctx, 'DATA_FRESHNESS_CHANGED', { type: 'integration', id }, { status: 'revoked', from: 'active' });
        await enqueue(tx, ws, Queues.sendEmail, { template: 'integration_disconnected', provider }, { singletonKey: `integration-revoked:${id}` });
        expired++;
        return;
      }
      const [w] = await tx`update integrations set expiry_warned_at = now() where id = ${id} and workspace_id = ${ws} and expiry_warned_at is null returning token_expires_at`;
      if (!w) return;
      await emit(tx, ctx, 'INTEGRATION_DEGRADED', { type: 'integration', id }, { kind: 'token_expiring', expiresAt: new Date(w.token_expires_at as string).toISOString() });
      await enqueue(tx, ws, Queues.sendEmail, { template: 'integration_expiring', provider, expiresAt: new Date(w.token_expires_at as string).toISOString() }, { singletonKey: `integration-expiring:${id}` });
      warned++;
    });
  }
  return { warned, expired };
}
