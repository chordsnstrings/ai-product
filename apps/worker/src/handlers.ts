import { withSystem, withTenant } from '@arkiv/db';
import { DomainError, type PlanCode } from '@arkiv/shared';
import { STRIPE_CLAIM_STALE_MINUTES, cancelSubscriptionsForPurge, refundProjectPurchase } from '@arkiv/billing';
import {
  analyzeProduct,
  buildExport,
  clusterThemes,
  computeResults,
  draftRecoveryConcept,
  extractGenome,
  generateConceptBatch,
  generateRecommendations,
  generateStoryboard,
  processUpload,
  produceHookVariants,
  produceProject,
  purgeWorkspace,
  refreshMaturity,
  regenerateFrame,
  Queues,
  recomposeProject,
  syncIntegration,
  syncShopifyProduct,
  transferSku,
  weekOf,
  WEEKLY_RECOMMENDATION_SKUS,
  enqueue,
  failAnalysis,
  holdDecision,
  holdJob,
  exportSatisfied,
  LEASE_BUSY,
  releaseJobLease,
  tryJobLease,
  withJobLease,
  planQuota,
  priorityFor,
  type TenantContext,
} from '@arkiv/core';
import { jobContext } from './context';
import { sendQueuedEmail } from './emails';
import { QUEUE_CONFIG } from './queues';
import { logger, payloadBindings, withLogContext } from '@arkiv/shared/log';

export type Handler = (ctx: TenantContext, data: Record<string, unknown>, jobId: string) => Promise<unknown>;

/** Domain errors that end a job for good (no retry): the request itself cannot succeed. */
export const FINAL_DOMAIN_CODES: readonly string[] = ['INVALID', 'NOT_FOUND', 'FORBIDDEN', 'GATE_BLOCKED', 'PAYMENT_REQUIRED', 'CONFLICT'];

/**
 * Product analysis (plan 03 P3). An analysis that ends for good — a final domain error here, or its last retry
 * failing (onFinalFailure) — leaves the SKU waiting for the merchant with what was found, never "analyzing".
 */
const analyze: Handler = async (ctx, d) => {
  try {
    return await analyzeProduct(ctx, d.skuId as string, d.projectId as string);
  } catch (e) {
    if (e instanceof DomainError && FINAL_DOMAIN_CODES.includes(e.code) && e.code !== 'NOT_FOUND') {
      await failAnalysis(ctx, d.skuId as string, d.projectId as string, `${e.code}: ${e.message}`);
    }
    throw e;
  }
};

/** Per-workspace render concurrency (plan 02 §3 layer 5): lease or re-queue with a truthful delay. */
async function withRenderLease<T>(ctx: TenantContext, jobId: string, fn: () => Promise<T>): Promise<T | 'requeued'> {
  const acquired = await withTenant(ctx.workspaceId, async (tx) => {
    const limit = (await planQuota(tx, (ctx.planCode as PlanCode | null) ?? null)).renderConcurrency;
    await tx`delete from workspace_leases where resource = 'render' and expires_at < now()`;
    await tx`select pg_advisory_xact_lock(hashtext(${'lease:' + ctx.workspaceId}))`;
    const [n] = await tx`select count(*)::int as n from workspace_leases where resource = 'render'`;
    if (n!.n >= limit) return false;
    await tx`insert into workspace_leases (workspace_id, resource, holder, expires_at) values (${ctx.workspaceId}, 'render', ${jobId}, now() + interval '30 minutes')
             on conflict do nothing`;
    return true;
  });
  if (!acquired) return 'requeued';
  try {
    return await fn();
  } finally {
    await withTenant(ctx.workspaceId, (tx) => tx`delete from workspace_leases where resource = 'render' and holder = ${jobId}`);
  }
}

export const handlers: Record<string, Handler> = {
  [Queues.analyzeProduct]: analyze,
  [Queues.analyzeProductFree]: analyze,
  [Queues.generateStoryboard]: (ctx, d) => generateStoryboard(ctx, d.projectId as string, d.storyboardId as string, d.conceptId as string),
  [Queues.generateStoryboardFree]: (ctx, d) => generateStoryboard(ctx, d.projectId as string, d.storyboardId as string, d.conceptId as string),
  [Queues.generateConcepts]: (ctx, d) => generateConceptBatch(ctx, d.projectId as string, Number(d.batch)),
  [Queues.generateConceptsFree]: (ctx, d) => generateConceptBatch(ctx, d.projectId as string, Number(d.batch)),
  [Queues.regenerateFrame]: (ctx, d) => regenerateFrame(ctx, d.sceneId as string, String(d.instruction ?? ''), Number(d.version)),
  [Queues.regenerateFrameFree]: (ctx, d) => regenerateFrame(ctx, d.sceneId as string, String(d.instruction ?? ''), Number(d.version)),
  [Queues.produceProject]: async (ctx, d, jobId) => {
    const r = await withRenderLease(ctx, jobId, () => produceProject(ctx, d.projectId as string));
    if (r === 'requeued') {
      // Truthful queued state: the job waits its turn instead of competing (plan 03 P9).
      await withTenant(ctx.workspaceId, (tx) => enqueue(tx, ctx.workspaceId, Queues.produceProject, d, { runAfter: new Date(Date.now() + 20_000), singletonKey: `produce:${d.projectId}:wait:${Date.now()}`, priority: priorityFor(ctx, 'production') }));
    }
    return r;
  },
  [Queues.hookVariants]: (ctx, d) => produceHookVariants(ctx, d.projectId as string),
  [Queues.recomposeProject]: (ctx, d) => recomposeProject(ctx, d.projectId as string),
  [Queues.recoveryConcept]: (ctx, d) => draftRecoveryConcept(ctx, d.projectId as string),
  // Core can't import billing, so the guarantee refund (queued by failProduction) runs here.
  [Queues.refundPurchase]: (ctx, d) => refundProjectPurchase(ctx, d.purchaseId as string, String(d.reason ?? 'guarantee')),
  [Queues.processUpload]: (ctx, d) => withTenant(ctx.workspaceId, (tx) => processUpload(tx, ctx, d.uploadId as string, (d.skuId as string) ?? null)),
  [Queues.sendEmail]: (ctx, d, jobId) => sendQueuedEmail(ctx, d, jobId),
  // One sync per integration at a time: a request arriving mid-run waits for it (one queued follow-up).
  [Queues.syncIntegration]: (ctx, d, jobId) =>
    exclusive(ctx, Queues.syncIntegration, `sync:${d.integrationId as string}`, jobId, d, () => syncIntegration(ctx, d.integrationId as string, { full: !!d.full })),
  [Queues.syncShopifyProduct]: (ctx, d) => syncShopifyProduct(ctx, d.integrationId as string, d.productId as string),
  [Queues.computeResults]: async (ctx, d) => {
    // Serialized per experiment: a second run waits for the first to commit, then recomputes on fresh data.
    const r = await withTenant(ctx.workspaceId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'results:' + (d.experimentId as string)}))`;
      return computeResults(tx, ctx, d.experimentId as string);
    });
    const [e] = await withTenant(ctx.workspaceId, (tx) => tx`select sku_id from experiments where id = ${d.experimentId as string}`);
    if (e) await withTenant(ctx.workspaceId, (tx) => refreshMaturity(tx, e.sku_id as string));
    return r;
  },
  [Queues.weeklyRecommendations]: async (ctx, d) => {
    const week = (d.week as string) ?? weekOf();
    // One SKU (just analysed for a subscriber) or the whole catalogue (the weekly run, a new subscription).
    const skus = d.skuId
      ? await withTenant(ctx.workspaceId, (tx) => tx`select id from skus where id = ${d.skuId as string} and status = 'active'`)
      : await withTenant(ctx.workspaceId, (tx) => tx`select id from skus where status = 'active' order by catalogue_no limit ${WEEKLY_RECOMMENDATION_SKUS}`);
    let n = 0;
    for (const s of skus) n += await generateRecommendations(ctx, s.id as string, week).catch((e) => (e instanceof DomainError ? 0 : Promise.reject(e)));
    if (n) await withTenant(ctx.workspaceId, (tx) => enqueue(tx, ctx.workspaceId, Queues.sendEmail, { template: 'weekly_brief', week }, { singletonKey: `brief:${ctx.workspaceId}:${week}` }));
    return n;
  },
  [Queues.exportWorkspace]: async (ctx, d, jobId) => {
    // Runs even while the workspace is held (staff export on legal request), but a suspended tenant's link is
    // parked with the other deliveries; a fresh signed URL is minted from the asset when it is released.
    // One export per workspace at a time; a request an export has already answered stands down.
    const lease = await tryJobLease(ctx.workspaceId, 'export', jobId, QUEUE_CONFIG[Queues.exportWorkspace]!.expireInSeconds);
    if (!lease) return { skipped: 'an export is already running' };
    try {
      if (await withTenant(ctx.workspaceId, (tx) => exportSatisfied(tx, ctx.workspaceId, d.requestedAt as string | undefined))) return { skipped: 'already exported since this request' };
      return await deliverExport(ctx, jobId);
    } finally {
      await releaseJobLease(ctx.workspaceId, 'export', jobId);
    }
  },
  // Stripe first (core can't import billing): a purged workspace must never be billed again.
  [Queues.purgeWorkspace]: async (_ctx, d) => purgeWorkspace(d.workspaceId as string, { stripeSubscriptionsCancelled: await cancelSubscriptionsForPurge(d.workspaceId as string) }),
  [Queues.extractGenome]: (ctx, d) => extractGenome(ctx, d.creativeId as string),
  [Queues.customerThemes]: (ctx, d, jobId) => exclusive(ctx, Queues.customerThemes, `themes:${d.skuId as string}`, jobId, d, () => clusterThemes(ctx, d.skuId as string)),
  [Queues.transferSku]: (_ctx, d) => transferSku(d.transferId as string),
};

async function deliverExport(ctx: TenantContext, jobId: string) {
  const r = await buildExport(ctx);
  const email = { template: 'export_ready', assetId: r.assetId, actor: ctx.actor };
  if (holdDecision(ctx.workspaceState, Queues.sendEmail, email) === 'hold') {
    await withTenant(ctx.workspaceId, (tx) => holdJob(tx, ctx.workspaceId, Queues.sendEmail, email, `export-email:${jobId}`, `workspace ${ctx.workspaceState}`));
    return { assetId: r.assetId, delivery: 'held' };
  }
  await sendQueuedEmail(ctx, { template: 'export_ready', url: r.url }, `export:${r.assetId}`);
  return r.assetId;
}

/**
 * Run a job that must not overlap with another run for the same subject (x-races-14). When a live run holds
 * the lease, the job is re-queued once behind it (a pending follow-up per subject), so the request is honoured
 * with fresh data instead of racing the running one.
 */
async function exclusive(ctx: TenantContext, queue: typeof Queues.syncIntegration | typeof Queues.customerThemes, resource: string, jobId: string, data: Record<string, unknown>, fn: () => Promise<unknown>) {
  const r = await withJobLease(ctx.workspaceId, resource, jobId, QUEUE_CONFIG[queue]!.expireInSeconds, fn);
  if (r !== LEASE_BUSY) return r;
  await withTenant(ctx.workspaceId, (tx) => enqueue(tx, ctx.workspaceId, queue, data, { runAfter: new Date(Date.now() + 60_000), singletonKey: `${resource}:after-running` }));
  return { requeued: `${resource} is already running` };
}

const jobLog = logger('jobs');

/**
 * Run one job with tenant context. Domain errors are final (no retry); others bubble up for pg-boss retry.
 * Every log line of the job (and of the provider calls it makes) carries its queue, job id, the domain ids in
 * its payload and the request id of the request that enqueued it (§34).
 */
export async function runJob(queue: string, data: Record<string, unknown>, jobId: string): Promise<unknown> {
  return withLogContext({ ...payloadBindings(data), jobId, queue }, async () => {
    const t0 = Date.now();
    try {
      const r = await runJobInContext(queue, data, jobId);
      const outcome = r && typeof r === 'object' ? Object.keys(r as object).find((k) => ['skipped', 'held', 'failed', 'requeued'].includes(k)) ?? 'ok' : 'ok';
      jobLog.info('job finished', { outcome, durationMs: Date.now() - t0, result: JSON.stringify(r ?? null).slice(0, 200) });
      return r;
    } catch (e) {
      jobLog.error('job failed', { durationMs: Date.now() - t0, err: e });
      throw e;
    }
  });
}

async function runJobInContext(queue: string, data: Record<string, unknown>, jobId: string): Promise<unknown> {
  const h = handlers[queue];
  if (!h) throw new Error(`no handler for ${queue}`);
  if (queue === Queues.purgeWorkspace) return h({} as TenantContext, data, jobId);
  let ctx: TenantContext;
  try {
    ctx = await jobContext(data as never, jobId);
  } catch (e) {
    if (e instanceof DomainError) return { skipped: e.message };
    throw e;
  }
  // Held workspaces pause jobs instead of dropping them (plan 05 §2.3): the job is parked and re-enqueued when
  // the hold ends. Deliveries of finished work wait the same way; purged workspaces drop everything.
  const decision = holdDecision(ctx.workspaceState, queue, data);
  if (decision === 'skip') return { skipped: `workspace ${ctx.workspaceState}` };
  if (decision === 'hold') {
    const parked = await withTenant(ctx.workspaceId, (tx) => holdJob(tx, ctx.workspaceId, queue, data, jobId, `workspace ${ctx.workspaceState}`));
    return { held: `workspace ${ctx.workspaceState}`, parked };
  }
  try {
    return await h(ctx, data, jobId);
  } catch (e) {
    if (e instanceof DomainError && FINAL_DOMAIN_CODES.includes(e.code)) {
      return { failed: e.code, message: e.message };
    }
    throw e;
  }
}

/**
 * A job failed for the last time (its retries are spent; pg-boss moves it to the dead-letter queue, which stays
 * visible to staff). Jobs whose subject would otherwise be stuck record an honest final state here.
 */
export async function onFinalFailure(queue: string, data: Record<string, unknown>, jobId: string, err: unknown): Promise<void> {
  if (queue !== Queues.analyzeProduct && queue !== Queues.analyzeProductFree) return;
  let ctx: TenantContext;
  try {
    ctx = await jobContext(data as never, jobId);
  } catch {
    return; // workspace gone
  }
  await failAnalysis(ctx, data.skuId as string, data.projectId as string, `analysis failed after retries: ${(err as Error)?.message ?? String(err)}`);
}

/**
 * System jobs (not tenant-scoped). Drains stored Stripe events: new ones, a retry (webhook before our row
 * committed) at most every 10 seconds, briefly the unmatched ones, and claims abandoned by a crashed process.
 * processStripeEvent claims each row atomically, so running this next to the webhook route and admin replay
 * never applies an event twice.
 */
export async function processPendingStripeEvents(process: (id: string) => Promise<unknown>) {
  const rows = await withSystem((tx) => tx`
    select id from stripe_events
    where (status = 'received' and (claimed_at is null or claimed_at < now() - interval '10 seconds'))
       or (status = 'unmatched' and attempts < 3 and received_at > now() - interval '10 minutes')
       or (status = 'processing' and claimed_at < now() - make_interval(mins => ${STRIPE_CLAIM_STALE_MINUTES}))
    order by received_at limit 50`);
  for (const r of rows) await process(r.id as string).catch((e) => jobLog.error('stripe event failed', { stripeEventId: r.id, err: e }));
  return rows.length;
}
