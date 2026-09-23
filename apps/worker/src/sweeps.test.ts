import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
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

describe('risk-flags sweep (plan 02 §3: system_rw is not tenant-scoped)', () => {
  beforeEach(truncateAll);
  afterAll(closeAll);

  it('computes and resolves flags per workspace, never across tenants', async () => {
    const a = await makeTenant({ state: 'ACTIVE_FREE' });
    const b = await makeTenant({ state: 'ACTIVE_FREE' });
    const bSku = await makeSku(b.workspaceId, 'B cream');
    await ownerPool()`update skus set status = 'out_of_stock' where id = ${bSku}`;
    // B already has an open flag for that; A has a stale flag that should resolve.
    await ownerPool()`insert into risk_flags (workspace_id, indicator) values (${b.workspaceId}, 'product_out_of_stock'), (${a.workspaceId}, 'ad_account_disconnected')`;

    await sweeps['risk-flags']!.run();

    const open = await ownerPool()`select workspace_id, indicator from risk_flags where resolved_at is null order by indicator`;
    // Before: A inherited B's stockout (unscoped count) and A's refresh resolved B's open flag.
    expect(open.map((r) => [r.workspace_id === a.workspaceId ? 'A' : 'B', r.indicator])).toEqual([['B', 'product_out_of_stock']]);
    const [resolvedA] = await ownerPool()`select resolved_at from risk_flags where workspace_id = ${a.workspaceId} and indicator = 'ad_account_disconnected'`;
    expect(resolvedA!.resolved_at).not.toBeNull();
  });
});
