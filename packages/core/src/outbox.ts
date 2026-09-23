import type { Tx } from '@arkiv/db';

/** Queue names. Free-preview work runs on separate low-priority queues (plan 02 §3 layer 5). */
export const Queues = {
  analyzeProduct: 'analyze-product',
  generateConcepts: 'generate-concepts',
  generateStoryboard: 'generate-storyboard',
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

export interface EnqueueOptions {
  singletonKey?: string;
  runAfter?: Date;
  priority?: number;
}

/**
 * Transactional enqueue: the job exists iff the surrounding transaction commits. The dispatcher moves rows
 * into pg-boss. Payloads always carry the workspaceId so workers re-enter the tenant context.
 */
export async function enqueue(
  tx: Tx,
  workspaceId: string,
  queue: QueueName,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<void> {
  if (opts.singletonKey) {
    const existing = await tx`select 1 from outbox where queue = ${queue} and singleton_key = ${opts.singletonKey}
                              and dispatched_at is null limit 1`;
    if (existing.length) return;
  }
  await tx`
    insert into outbox (workspace_id, queue, payload, singleton_key, run_after, priority)
    values (${workspaceId}, ${queue}, ${tx.json({ ...payload, workspaceId } as never)}, ${opts.singletonKey ?? null},
            ${opts.runAfter ?? new Date()}, ${opts.priority ?? 0})`;
}
