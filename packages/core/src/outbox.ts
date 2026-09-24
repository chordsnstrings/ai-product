import type { Tx } from '@arkiv/db';
import type { WorkspaceState } from '@arkiv/shared';
import { currentRequestId } from '@arkiv/shared/log';

/**
 * Queue names. Free and provisional AI work runs on its own `-free` queues with their own (smaller) worker
 * pools, so paying tenants are never delayed by preview traffic (plan 02 §3 layer 5; plan 06 Phase 6 "paid never
 * waits on free").
 */
export const Queues = {
  analyzeProduct: 'analyze-product',
  analyzeProductFree: 'analyze-product-free',
  generateConcepts: 'generate-concepts',
  generateConceptsFree: 'generate-concepts-free',
  generateStoryboard: 'generate-storyboard',
  generateStoryboardFree: 'generate-storyboard-free',
  regenerateFrame: 'regenerate-frame',
  regenerateFrameFree: 'regenerate-frame-free',
  recoveryConcept: 'recovery-concept',
  refundPurchase: 'refund-purchase',
  produceProject: 'produce-project',
  hookVariants: 'hook-variants',
  processUpload: 'process-upload',
  stripeEvent: 'stripe-event',
  sendEmail: 'send-email',
  syncIntegration: 'sync-integration',
  computeResults: 'compute-results',
  weeklyRecommendations: 'weekly-recommendations',
  exportWorkspace: 'export-workspace',
  purgeWorkspace: 'purge-workspace',
  extractGenome: 'extract-genome',
  customerThemes: 'customer-themes',
  transferSku: 'transfer-sku',
} as const;
export type QueueName = (typeof Queues)[keyof typeof Queues];

/**
 * What a staff retry of each queue's jobs may do (plan 05 §12 "retry only if the handler is idempotent and no new
 * spend, or with a fresh Cost Governor authorization shown to the operator"). `idempotent`: a re-run can't double
 * any effect (keyed authorizations, leases, idempotent ledger/Stripe writes). `spends`: the handler calls billable
 * providers through the gateway.
 */
export const QUEUE_POLICY: Record<QueueName, { idempotent: boolean; spends: boolean }> = {
  [Queues.analyzeProduct]: { idempotent: true, spends: true },
  [Queues.analyzeProductFree]: { idempotent: true, spends: true },
  [Queues.generateConcepts]: { idempotent: true, spends: true },
  [Queues.generateConceptsFree]: { idempotent: true, spends: true },
  [Queues.generateStoryboard]: { idempotent: true, spends: true },
  [Queues.generateStoryboardFree]: { idempotent: true, spends: true },
  [Queues.regenerateFrame]: { idempotent: true, spends: true },
  [Queues.regenerateFrameFree]: { idempotent: true, spends: true },
  [Queues.recoveryConcept]: { idempotent: true, spends: true },
  [Queues.refundPurchase]: { idempotent: true, spends: false },
  [Queues.produceProject]: { idempotent: true, spends: true },
  [Queues.hookVariants]: { idempotent: true, spends: true },
  [Queues.processUpload]: { idempotent: true, spends: false },
  [Queues.stripeEvent]: { idempotent: true, spends: false },
  [Queues.sendEmail]: { idempotent: true, spends: false },
  [Queues.syncIntegration]: { idempotent: true, spends: false },
  [Queues.computeResults]: { idempotent: true, spends: false },
  [Queues.weeklyRecommendations]: { idempotent: true, spends: true },
  [Queues.exportWorkspace]: { idempotent: true, spends: false },
  // A purge deletes everything; re-running one is a staff decision on the tenant, not a queue retry.
  [Queues.purgeWorkspace]: { idempotent: false, spends: false },
  [Queues.extractGenome]: { idempotent: true, spends: true },
  [Queues.customerThemes]: { idempotent: true, spends: true },
  [Queues.transferSku]: { idempotent: true, spends: false },
};

export const queuePolicy = (queue: string) => (QUEUE_POLICY as Record<string, { idempotent: boolean; spends: boolean } | undefined>)[queue] ?? null;

/**
 * A failed job's error class for bulk retry (plan 05 §12 "bulk retry by error class"): its error code, else its
 * message with ids, numbers and quoted values replaced, so "timeout after 180000ms for job 1f2e…" groups together.
 */
export function jobErrorClass(output: unknown): string {
  const o = (output ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof o.code === 'string' && o.code) return o.code;
  const msg = typeof o.message === 'string' ? o.message : typeof output === 'string' ? output : JSON.stringify(output ?? '');
  const shape = msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/[“"'][^“”"']{1,80}[”"']/g, '<value>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return shape || (typeof o.name === 'string' ? o.name : 'unknown');
}

/** Tenants currently paying for a plan; everyone else (provisional, free, lapsed) is free-tier traffic. */
const PAYING: ReadonlySet<WorkspaceState> = new Set(['ACTIVE_PAID', 'PAST_DUE']);
export const isFreeTier = (ctx: { workspaceState: WorkspaceState }) => !PAYING.has(ctx.workspaceState);

/** Interactive AI queues that have a separate free-tier pool. */
const FREE_POOL = {
  [Queues.analyzeProduct]: Queues.analyzeProductFree,
  [Queues.generateConcepts]: Queues.generateConceptsFree,
  [Queues.generateStoryboard]: Queues.generateStoryboardFree,
  [Queues.regenerateFrame]: Queues.regenerateFrameFree,
} as const;
export type PooledQueue = keyof typeof FREE_POOL;

/** Route interactive AI work: free-tier tenants to the `-free` pool, paying tenants to the main one. */
export function queueFor(queue: PooledQueue, ctx: { workspaceState: WorkspaceState }): QueueName {
  return isFreeTier(ctx) ? FREE_POOL[queue] : queue;
}

/** Job priority within a queue (higher runs first): paid production > paid interactive > free-tier. */
export function priorityFor(ctx: { workspaceState: WorkspaceState }, kind: 'interactive' | 'production' = 'interactive'): number {
  if (kind === 'production') return 20;
  return isFreeTier(ctx) ? 0 : 10;
}

export interface EnqueueOptions {
  singletonKey?: string;
  runAfter?: Date;
  priority?: number;
}

/**
 * Transactional enqueue: the job exists iff the surrounding transaction commits. The dispatcher moves rows
 * into pg-boss. Payloads always carry the workspaceId so workers re-enter the tenant context.
 * A singleton key allows one undispatched job per (workspace, queue, key); the unique index `outbox_singleton_pending`
 * makes that atomic, so concurrent requests (a double click, two tabs) cannot both enqueue. Returns whether a
 * job was added. Jobs that must not overlap once running also hold a lease in their handler (leases.ts).
 * The current request id travels in the payload, so the job's logs join the request that created it (§34).
 */
export async function enqueue(
  tx: Tx,
  workspaceId: string,
  queue: QueueName,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<boolean> {
  const requestId = (payload.requestId as string | undefined) ?? currentRequestId();
  const r = await tx`
    insert into outbox (workspace_id, queue, payload, singleton_key, run_after, priority)
    values (${workspaceId}, ${queue}, ${tx.json({ ...payload, workspaceId, ...(requestId ? { requestId } : {}) } as never)}, ${opts.singletonKey ?? null},
            ${opts.runAfter ?? new Date()}, ${opts.priority ?? 0})
    on conflict (workspace_id, queue, singleton_key) where singleton_key is not null and dispatched_at is null do nothing
    returning id`;
  return r.length > 0;
}
