import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { ingestBytes, Queues, startPreview } from '@arkiv/core';
import { ctxFor, productPhoto } from '@arkiv/core/testing';
import { onFinalFailure, runJob } from './handlers';
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

describe('a failed analysis never stays "analyzing" (plan 03 P3)', () => {
  async function preview() {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    const [job] = await ownerPool()`select id, queue, payload from outbox where workspace_id = ${t.workspaceId} and queue like 'analyze-product%'`;
    return { t, skuId, projectId, job: job! };
  }
  const skuStatus = async (id: string) => (await ownerPool()`select status from skus where id = ${id}`)[0]!.status;

  it('a final error ends the analysis at once, and so does its last failed retry', async () => {
    const a = await preview();
    await ownerPool()`update platform_settings set value = '1' where key = 'free_preview.cogs_cap_micros'`;
    let r: unknown;
    try {
      r = await runJob(a.job.queue as string, a.job.payload as Record<string, unknown>, a.job.id as string);
    } finally {
      await ownerPool()`update platform_settings set value = '200000' where key = 'free_preview.cogs_cap_micros'`;
    }
    expect(r).toMatchObject({ failed: 'GATE_BLOCKED' });
    expect(await skuStatus(a.skuId)).toBe('needs_input');

    const b = await preview();
    await onFinalFailure(b.job.queue as string, b.job.payload as Record<string, unknown>, b.job.id as string, new Error('provider down'));
    expect(await skuStatus(b.skuId)).toBe('needs_input');
    const [p] = await ownerPool()`select state from projects where id = ${b.projectId}`;
    expect(p!.state).toBe('NEEDS_USER_ACTION');
  }, 60_000);

  it('the sweep fails an analysis with no progress for 10 minutes, and leaves live or queued ones alone', async () => {
    const t = await makeTenant();
    const mk = async (no: number, opts: { stepAgo: string; queued?: boolean }) => {
      const [s] = await ownerPool()`insert into skus (workspace_id, catalogue_no, name, status, created_at) values (${t.workspaceId}, ${no}, 'Stuck', 'analyzing', now() - interval '30 minutes') returning id`;
      const [p] = await ownerPool()`insert into projects (workspace_id, sku_id, kind, state, created_by, updated_at) values (${t.workspaceId}, ${s!.id}, 'preview', 'PRODUCT_UPLOADED', 'x', now() - interval '30 minutes') returning id`;
      await ownerPool()`insert into progress_steps (workspace_id, subject_id, step_key, label, status, started_at, position)
                        values (${t.workspaceId}, ${s!.id}, 'identify', 'Identifying the product', 'active', now() - ${opts.stepAgo}::interval, 0)`;
      if (opts.queued) await ownerPool()`insert into outbox (workspace_id, queue, payload) values (${t.workspaceId}, 'analyze-product-free', ${ownerPool().json({ skuId: s!.id, projectId: p!.id, workspaceId: t.workspaceId })})`;
      return s!.id as string;
    };
    const stuck = await mk(1, { stepAgo: '20 minutes' });
    const live = await mk(2, { stepAgo: '1 minute' });
    const queued = await mk(3, { stepAgo: '20 minutes', queued: true });
    expect(await sweeps['sweep-stuck-analysis']!.run()).toBe(1);
    expect([await skuStatus(stuck), await skuStatus(live), await skuStatus(queued)]).toEqual(['needs_input', 'analyzing', 'analyzing']);
    expect(await sweeps['sweep-stuck-analysis']!.run()).toBe(0);
  });
});
