import { Queues } from '@arkiv/core';

/**
 * Worker pool per queue: concurrency, lease (expireInSeconds) and bounded retries before the dead letter (§39).
 * Every queue in `Queues` must have an entry here and a handler (see queues.test.ts).
 */
export const QUEUE_CONFIG: Record<string, { concurrency: number; expireInSeconds: number; retryLimit: number }> = {
  [Queues.analyzeProduct]: { concurrency: 4, expireInSeconds: 300, retryLimit: 2 },
  [Queues.analyzeProductFree]: { concurrency: 2, expireInSeconds: 300, retryLimit: 2 },
  [Queues.generateStoryboard]: { concurrency: 4, expireInSeconds: 300, retryLimit: 2 },
  [Queues.generateStoryboardFree]: { concurrency: 2, expireInSeconds: 300, retryLimit: 2 },
  [Queues.generateConcepts]: { concurrency: 2, expireInSeconds: 300, retryLimit: 2 },
  [Queues.generateConceptsFree]: { concurrency: 1, expireInSeconds: 300, retryLimit: 2 },
  [Queues.regenerateFrame]: { concurrency: 2, expireInSeconds: 180, retryLimit: 2 },
  [Queues.regenerateFrameFree]: { concurrency: 1, expireInSeconds: 180, retryLimit: 2 },
  [Queues.produceProject]: { concurrency: 6, expireInSeconds: 3600, retryLimit: 1 },
  [Queues.hookVariants]: { concurrency: 2, expireInSeconds: 900, retryLimit: 2 },
  // A price/size change recomposes delivered ads (media only, §42).
  [Queues.recomposeProject]: { concurrency: 2, expireInSeconds: 600, retryLimit: 2 },
  // Marketing recovery (plan 04 L20): lowest urgency, one at a time.
  [Queues.recoveryConcept]: { concurrency: 1, expireInSeconds: 300, retryLimit: 1 },
  // Money back for undeliverable paid orders: retried generously (every step is idempotent).
  [Queues.refundPurchase]: { concurrency: 2, expireInSeconds: 120, retryLimit: 8 },
  [Queues.processUpload]: { concurrency: 4, expireInSeconds: 120, retryLimit: 2 },
  [Queues.sendEmail]: { concurrency: 4, expireInSeconds: 60, retryLimit: 5 },
  [Queues.syncIntegration]: { concurrency: 2, expireInSeconds: 1800, retryLimit: 3 },
  [Queues.computeResults]: { concurrency: 2, expireInSeconds: 300, retryLimit: 3 },
  [Queues.weeklyRecommendations]: { concurrency: 2, expireInSeconds: 1800, retryLimit: 2 },
  [Queues.exportWorkspace]: { concurrency: 1, expireInSeconds: 1800, retryLimit: 2 },
  [Queues.purgeWorkspace]: { concurrency: 1, expireInSeconds: 1800, retryLimit: 3 },
  [Queues.extractGenome]: { concurrency: 2, expireInSeconds: 300, retryLimit: 2 },
  [Queues.customerThemes]: { concurrency: 1, expireInSeconds: 600, retryLimit: 2 },
  // Staff SKU transfer (plan 05 §2.3): one at a time; copies stored objects, so a generous lease.
  [Queues.transferSku]: { concurrency: 1, expireInSeconds: 900, retryLimit: 2 },
};
