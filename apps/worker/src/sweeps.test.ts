import { describe, expect, it } from 'vitest';
import { Queues } from '@arkiv/core';
import { sweepQueue, sweeps } from './sweeps';

describe('schedules', () => {
  it('never share a pg-boss queue with job handlers', () => {
    // Regression: the "weekly-recommendations" schedule shared its queue with the per-workspace job, so the
    // schedule's worker sometimes consumed a workspace's job and ran the fan-out instead.
    const jobQueues = new Set<string>(Object.values(Queues).flatMap((q) => [q, `${q}-dlq`]));
    for (const key of Object.keys(sweeps)) expect(jobQueues.has(sweepQueue(key)), sweepQueue(key)).toBe(false);
  });
});
