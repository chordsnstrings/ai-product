import type { Tx } from '@arkiv/db';
import type { WorkspaceState } from '@arkiv/shared';

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
} as const;
export type QueueName = (typeof Queues)[keyof typeof Queues];

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
 * A singleton key allows one undispatched job per (queue, key); the unique index `outbox_singleton_pending`
 * makes that atomic, so concurrent requests (a double click, two tabs) cannot both enqueue. Returns whether a
 * job was added. Jobs that must not overlap once running also hold a lease in their handler (leases.ts).
 */
export async function enqueue(
  tx: Tx,
  workspaceId: string,
  queue: QueueName,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<boolean> {
  const r = await tx`
    insert into outbox (workspace_id, queue, payload, singleton_key, run_after, priority)
    values (${workspaceId}, ${queue}, ${tx.json({ ...payload, workspaceId } as never)}, ${opts.singletonKey ?? null},
            ${opts.runAfter ?? new Date()}, ${opts.priority ?? 0})
    on conflict (queue, singleton_key) where singleton_key is not null and dispatched_at is null do nothing
    returning id`;
  return r.length > 0;
}
