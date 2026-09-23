import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { sweeps } from './sweeps';

/**
 * Production recovery sweeps (standard §39 "crashed workers cannot strand entitlement", §25 idempotent resume,
 * §44 outage pause). Rows are crafted directly so the sweeps' selection logic is tested in isolation; the
 * resume itself is exercised end to end in tests/chaos.
 */
beforeEach(truncateAll);
afterEach(async () => {
  await ownerPool()`update model_routes set circuit_open = false where task = 'video.scene'`;
});
afterAll(closeAll);

async function project(opts: { state: string; minutesAgo?: number; authMinutesAgo?: number; outage?: Record<string, unknown>; paid?: boolean }) {
  const t = await makeTenant({ state: 'ACTIVE_FREE' });
  const skuId = await makeSku(t.workspaceId);
  const id = newId();
  const updated = new Date(Date.now() - (opts.minutesAgo ?? 10) * 60_000);
  await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit, updated_at, outage)
                    values (${id}, ${t.workspaceId}, ${skuId}, 'taste', ${opts.state}, 'test', 'taste', ${updated}, ${opts.outage ? ownerPool().json(opts.outage as never) : null})`;
  if (opts.authMinutesAgo !== undefined) {
    const created = new Date(Date.now() - opts.authMinutesAgo * 60_000);
    const [a] = await ownerPool()`insert into cost_authorizations (workspace_id, project_id, purpose, token_hash, idempotency_key, rate_table_versions, estimate,
                                    max_cost_micros, expires_at, created_at)
                                  values (${t.workspaceId}, ${id}, 'taste', ${'h-' + id}, ${'produce:' + id}, '{}', '{}', 1000, now() + interval '1 hour', ${created})
                                  returning id`;
    await ownerPool()`update projects set authorization_id = ${a!.id} where id = ${id}`;
    // The touch trigger moved updated_at; put it back.
    await ownerPool()`alter table projects disable trigger projects_touch`;
    await ownerPool()`update projects set updated_at = ${updated} where id = ${id}`;
    await ownerPool()`alter table projects enable trigger projects_touch`;
  }
  if (opts.paid) {
    await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, stripe_payment_intent_id, status, created_by)
                      values (${t.workspaceId}, 'taste', ${id}, 19000000, 'pi_x', 'paid', 'test')`;
  }
  return { t, id };
}

const produceJobs = (id: string) => ownerPool()`select priority from outbox where queue = 'produce-project' and payload->>'projectId' = ${id}`;

describe('sweep-stuck-productions (prod-07)', () => {
  it('re-enqueues a production that lost its worker, at production priority', async () => {
    const { id } = await project({ state: 'RENDERING', minutesAgo: 10, authMinutesAgo: 12 });
    await sweeps['sweep-stuck-productions']!.run();
    const jobs = await produceJobs(id);
    expect(jobs).toHaveLength(1);
    expect(Number(jobs[0]!.priority)).toBe(20);
    // Already queued: the next minute's sweep does not pile up duplicates.
    await sweeps['sweep-stuck-productions']!.run();
    expect(await produceJobs(id)).toHaveLength(1);
  });

  it('leaves a production with a live run alone', async () => {
    const { t, id } = await project({ state: 'RENDERING', minutesAgo: 10, authMinutesAgo: 12 });
    await ownerPool()`insert into workspace_leases (workspace_id, resource, holder, expires_at) values (${t.workspaceId}, ${'produce:' + id}, 'run-1', now() + interval '5 minutes')`;
    await sweeps['sweep-stuck-productions']!.run();
    expect(await produceJobs(id)).toHaveLength(0);
  });

  it('fails and refunds a production stuck past the deadline, before its reservation would lapse', async () => {
    const { t, id } = await project({ state: 'COMPOSING', minutesAgo: 30, authMinutesAgo: 160, paid: true });
    await sweeps['sweep-stuck-productions']!.run();
    const [p] = await ownerPool()`select state from projects where id = ${id}`;
    expect(p!.state).toBe('PROVIDER_FAILED');
    const [a] = await ownerPool()`select status from cost_authorizations where project_id = ${id}`;
    expect(a!.status).toBe('refunded');
    expect(await ownerPool()`select 1 from outbox where workspace_id = ${t.workspaceId} and queue = 'refund-purchase'`).toHaveLength(1);
  });
});

describe('held workspaces (plan 05 §2.3)', () => {
  it('a suspended or purge-pending workspace’s productions are paused, not stalled: no resume, no fail', async () => {
    for (const state of ['SUSPENDED', 'PURGE_SCHEDULED']) {
      const stuck = await project({ state: 'COMPOSING', minutesAgo: 30, authMinutesAgo: 160, paid: true });
      const paused = await project({
        state: 'NEEDS_USER_ACTION',
        outage: { task: 'video.scene', since: new Date(Date.now() - 7 * 3600_000).toISOString(), lastAt: new Date(Date.now() - 30 * 60_000).toISOString(), attempts: 9 },
        authMinutesAgo: 7 * 60,
        paid: true,
      });
      await ownerPool()`update workspaces set state = ${state} where id in ${ownerPool()([stuck.t.workspaceId, paused.t.workspaceId])}`;
      await sweeps['sweep-stuck-productions']!.run();
      await sweeps['resume-paused-productions']!.run();
      const rows = await ownerPool()`select state from projects where id in ${ownerPool()([stuck.id, paused.id])} order by state`;
      expect(rows.map((r) => r.state), state).toEqual(['COMPOSING', 'NEEDS_USER_ACTION']);
      expect(await produceJobs(stuck.id)).toHaveLength(0);
      expect(await ownerPool()`select 1 from outbox where queue = 'refund-purchase' and workspace_id in ${ownerPool()([stuck.t.workspaceId, paused.t.workspaceId])}`).toHaveLength(0);
    }
  });
});

describe('resume-paused-productions (edge-44-05)', () => {
  const outage = (minutesSince: number, lastMinutesAgo: number, attempts = 1) => ({
    task: 'video.scene',
    since: new Date(Date.now() - minutesSince * 60_000).toISOString(),
    lastAt: new Date(Date.now() - lastMinutesAgo * 60_000).toISOString(),
    attempts,
  });

  it('waits while the provider circuit is open, then resumes with backoff', async () => {
    const { id } = await project({ state: 'NEEDS_USER_ACTION', outage: outage(20, 5, 2) });
    await ownerPool()`update model_routes set circuit_open = true where task = 'video.scene'`;
    await sweeps['resume-paused-productions']!.run();
    expect(await produceJobs(id)).toHaveLength(0);
    await ownerPool()`update model_routes set circuit_open = false where task = 'video.scene'`;
    await sweeps['resume-paused-productions']!.run();
    const jobs = await produceJobs(id);
    expect(jobs).toHaveLength(1);
    expect(Number(jobs[0]!.priority)).toBe(20);
  });

  it('does not retry before the backoff has elapsed', async () => {
    const { id } = await project({ state: 'NEEDS_USER_ACTION', outage: outage(60, 1, 4) }); // 4th attempt waits 8 minutes
    await sweeps['resume-paused-productions']!.run();
    expect(await produceJobs(id)).toHaveLength(0);
  });

  it('gives up after the maximum outage and refunds a paid order', async () => {
    const { t, id } = await project({ state: 'NEEDS_USER_ACTION', outage: outage(7 * 60, 30, 9), authMinutesAgo: 7 * 60, paid: true });
    await sweeps['resume-paused-productions']!.run();
    const [p] = await ownerPool()`select state, outage from projects where id = ${id}`;
    expect(p).toMatchObject({ state: 'PROVIDER_FAILED', outage: null });
    expect(await ownerPool()`select 1 from outbox where workspace_id = ${t.workspaceId} and queue = 'refund-purchase'`).toHaveLength(1);
  });
});
