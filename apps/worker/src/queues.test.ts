import { describe, expect, it } from 'vitest';
import { Queues } from '@arkiv/core';
import { handlers } from './handlers';
import { QUEUE_CONFIG } from './queues';

describe('queues', () => {
  it('every job queue has a handler and a worker pool', () => {
    // Regression: generate-concepts was defined (and enqueued) with no handler, so nothing ever ran it.
    // stripe-event is not a job queue: stored Stripe events are drained by the dispatcher loop (processPendingStripeEvents).
    for (const q of Object.values(Queues).filter((x) => x !== Queues.stripeEvent)) {
      expect(handlers[q], `handler for ${q}`).toBeTypeOf('function');
      expect(QUEUE_CONFIG[q], `QUEUE_CONFIG for ${q}`).toBeDefined();
    }
  });

  it('free-tier pools never outnumber the paid pools they shadow', () => {
    for (const [paid, free] of [
      [Queues.analyzeProduct, Queues.analyzeProductFree],
      [Queues.generateStoryboard, Queues.generateStoryboardFree],
      [Queues.generateConcepts, Queues.generateConceptsFree],
      [Queues.regenerateFrame, Queues.regenerateFrameFree],
    ] as const) {
      expect(QUEUE_CONFIG[free]!.concurrency).toBeLessThanOrEqual(QUEUE_CONFIG[paid]!.concurrency);
    }
  });
});
