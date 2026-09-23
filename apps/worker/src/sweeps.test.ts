import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { Queues } from '@arkiv/core';
import { sweepQueue, sweeps } from './sweeps';

beforeEach(truncateAll);
afterAll(closeAll);

describe('schedules', () => {
  it('never share a pg-boss queue with job handlers', () => {
    // Regression: the "weekly-recommendations" schedule shared its queue with the per-workspace job, so the
    // schedule's worker sometimes consumed a workspace's job and ran the fan-out instead.
    const jobQueues = new Set<string>(Object.values(Queues).flatMap((q) => [q, `${q}-dlq`]));
    for (const key of Object.keys(sweeps)) expect(jobQueues.has(sweepQueue(key)), sweepQueue(key)).toBe(false);
  });
});

describe('flag-expiry sweep (plan 05 §20)', () => {
  it('emails the owner of an expired flag once a day', async () => {
    await ownerPool()`insert into feature_flags (key, description, owner, kind, expires_at) values ('test.expired', 'x', 'owner@arkiv.test', 'boolean', now() - interval '1 day')`;
    try {
      expect(await sweeps['flag-expiry']!.run()).toBe(1);
      expect(await sweeps['flag-expiry']!.run()).toBe(0);
      const mails = await ownerPool()`select to_email, template from email_log where template = 'flag_expired'`;
      expect(mails).toEqual([{ to_email: 'owner@arkiv.test', template: 'flag_expired' }]);
    } finally {
      await ownerPool()`delete from feature_flags where key = 'test.expired'`;
    }
  });
});

describe('risk-flags sweep (plan 05 §17)', () => {
  it('flags each workspace only on its own evidence', async () => {
    // Regression: the sweep runs as the system role (policies see every tenant) and the indicator queries had
    // no workspace filter, so one tenant's stockout or QA failures flagged every tenant.
    const a = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const b = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const sku = await makeSku(a.workspaceId);
    await ownerPool()`update skus set status = 'out_of_stock' where id = ${sku}`;
    for (let i = 0; i < 3; i++) {
      await ownerPool()`insert into events (workspace_id, type, actor, payload) values (${a.workspaceId}, 'QA_FAILED', 'system:test', '{}')`;
    }
    await ownerPool()`insert into events (workspace_id, type, actor, payload, at) values (${a.workspaceId}, 'SKU_VALIDATED', ${'user:' + a.userId}, '{}', now() - interval '10 days')`;
    await ownerPool()`insert into events (workspace_id, type, actor, payload) values (${b.workspaceId}, 'SKU_VALIDATED', ${'user:' + b.userId}, '{}')`;

    expect(await sweeps['risk-flags']!.run()).toBe(2);
    const flags = await ownerPool()`select workspace_id, indicator from risk_flags where resolved_at is null order by indicator`;
    expect(flags.filter((f) => f.workspace_id === a.workspaceId).map((f) => f.indicator)).toEqual(['idle_7d', 'repeated_qa_rejects', 'stockout']);
    expect(flags.filter((f) => f.workspace_id === b.workspaceId)).toEqual([]);

    // Resolution is per workspace too: B's (empty) refresh must not resolve A's flags.
    await sweeps['risk-flags']!.run();
    expect(await ownerPool()`select 1 from risk_flags where workspace_id = ${a.workspaceId} and resolved_at is null`).toHaveLength(3);
    await ownerPool()`update skus set status = 'active' where id = ${sku}`;
    await sweeps['risk-flags']!.run();
    const open = await ownerPool()`select indicator from risk_flags where workspace_id = ${a.workspaceId} and resolved_at is null order by indicator`;
    expect(open.map((f) => f.indicator)).toEqual(['idle_7d', 'repeated_qa_rejects']);
  });
});

describe('risk-flags sweep resolution (plan 02 §3: system_rw is not tenant-scoped)', () => {
  it('computes and resolves flags per workspace, never across tenants', async () => {
    const a = await makeTenant({ state: 'ACTIVE_FREE' });
    const b = await makeTenant({ state: 'ACTIVE_FREE' });
    const bSku = await makeSku(b.workspaceId, 'B cream');
    await ownerPool()`update skus set status = 'out_of_stock' where id = ${bSku}`;
    // B already has an open flag for that; A has a stale flag that should resolve.
    await ownerPool()`insert into risk_flags (workspace_id, indicator) values (${b.workspaceId}, 'stockout'), (${a.workspaceId}, 'ad_account_disconnected')`;

    await sweeps['risk-flags']!.run();

    const open = await ownerPool()`select workspace_id, indicator from risk_flags where resolved_at is null order by indicator`;
    // Before: A inherited B's stockout (unscoped count) and A's refresh resolved B's open flag.
    expect(open.map((r) => [r.workspace_id === a.workspaceId ? 'A' : 'B', r.indicator])).toEqual([['B', 'stockout']]);
    const [resolvedA] = await ownerPool()`select resolved_at from risk_flags where workspace_id = ${a.workspaceId} and indicator = 'ad_account_disconnected'`;
    expect(resolvedA!.resolved_at).not.toBeNull();
  });
});
