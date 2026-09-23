import { withSystem, withTenant } from '@arkiv/db';
import { DomainError, PLANS, type PlanCode } from '@arkiv/shared';
import { refundProjectPurchase } from '@arkiv/billing';
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
  syncIntegration,
  weekOf,
  enqueue,
  priorityFor,
  type TenantContext,
} from '@arkiv/core';
import { jobContext, paused } from './context';
import { sendQueuedEmail } from './emails';

export type Handler = (ctx: TenantContext, data: Record<string, unknown>, jobId: string) => Promise<unknown>;

/** Per-workspace render concurrency (plan 02 §3 layer 5): lease or re-queue with a truthful delay. */
async function withRenderLease<T>(ctx: TenantContext, jobId: string, fn: () => Promise<T>): Promise<T | 'requeued'> {
  const limit = ctx.planCode ? PLANS[ctx.planCode as PlanCode].renderConcurrency : 1;
  const acquired = await withTenant(ctx.workspaceId, async (tx) => {
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
  [Queues.analyzeProduct]: (ctx, d) => analyzeProduct(ctx, d.skuId as string, d.projectId as string),
  [Queues.analyzeProductFree]: (ctx, d) => analyzeProduct(ctx, d.skuId as string, d.projectId as string),
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
  [Queues.recoveryConcept]: (ctx, d) => draftRecoveryConcept(ctx, d.projectId as string),
  // Core can't import billing, so the guarantee refund (queued by failProduction) runs here.
  [Queues.refundPurchase]: (ctx, d) => refundProjectPurchase(ctx, d.purchaseId as string, String(d.reason ?? 'guarantee')),
  [Queues.processUpload]: (ctx, d) => withTenant(ctx.workspaceId, (tx) => processUpload(tx, ctx, d.uploadId as string, (d.skuId as string) ?? null)),
  [Queues.sendEmail]: (ctx, d, jobId) => sendQueuedEmail(ctx, d, jobId),
  [Queues.syncIntegration]: (ctx, d) => syncIntegration(ctx, d.integrationId as string, { full: !!d.full }),
  [Queues.computeResults]: async (ctx, d) => {
    const r = await withTenant(ctx.workspaceId, (tx) => computeResults(tx, ctx, d.experimentId as string));
    const [e] = await withTenant(ctx.workspaceId, (tx) => tx`select sku_id from experiments where id = ${d.experimentId as string}`);
    if (e) await withTenant(ctx.workspaceId, (tx) => refreshMaturity(tx, e.sku_id as string));
    return r;
  },
  [Queues.weeklyRecommendations]: async (ctx, d) => {
    const week = (d.week as string) ?? weekOf();
    const skus = await withTenant(ctx.workspaceId, (tx) => tx`select id from skus where status = 'active' order by catalogue_no limit 30`);
    let n = 0;
    for (const s of skus) n += await generateRecommendations(ctx, s.id as string, week).catch((e) => (e instanceof DomainError ? 0 : Promise.reject(e)));
    if (n) await withTenant(ctx.workspaceId, (tx) => enqueue(tx, ctx.workspaceId, Queues.sendEmail, { template: 'weekly_brief', week }, { singletonKey: `brief:${week}` }));
    return n;
  },
  [Queues.exportWorkspace]: async (ctx) => {
    const r = await buildExport(ctx);
    await sendQueuedEmail(ctx, { template: 'export_ready', url: r.url }, `export:${r.assetId}`);
    return r.assetId;
  },
  [Queues.purgeWorkspace]: (_ctx, d) => purgeWorkspace(d.workspaceId as string),
  [Queues.extractGenome]: (ctx, d) => extractGenome(ctx, d.creativeId as string),
  [Queues.customerThemes]: (ctx, d) => clusterThemes(ctx, d.skuId as string),
};

/** Run one job with tenant context. Domain errors are final (no retry); others bubble up for pg-boss retry. */
export async function runJob(queue: string, data: Record<string, unknown>, jobId: string): Promise<unknown> {
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
  if (paused(ctx) && queue !== Queues.sendEmail) return { skipped: `workspace ${ctx.workspaceState}` };
  try {
    return await h(ctx, data, jobId);
  } catch (e) {
    if (e instanceof DomainError && ['INVALID', 'NOT_FOUND', 'FORBIDDEN', 'GATE_BLOCKED', 'PAYMENT_REQUIRED', 'CONFLICT'].includes(e.code)) {
      return { failed: e.code, message: e.message };
    }
    throw e;
  }
}

/** System jobs (not tenant-scoped). */
export async function processPendingStripeEvents(process: (id: string) => Promise<unknown>) {
  const rows = await withSystem((tx) => tx`select id from stripe_events where status in ('received') or (status = 'unmatched' and attempts < 3 and received_at > now() - interval '10 minutes') order by received_at limit 50`);
  for (const r of rows) await process(r.id as string).catch((e) => console.error('[stripe]', r.id, e));
  return rows.length;
}
