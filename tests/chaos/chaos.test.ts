import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, globalTx, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, makeSku, truncateAll } from '@arkiv/db/testing';
import {
  analyzeProduct,
  append,
  approveForProduction,
  authorize,
  available,
  generateStoryboard,
  heartbeat,
  ingestBytes,
  liveness,
  outageStatus,
  produceProject,
  selectConcept,
  startPreview,
  sweepExpiredAuthorizations,
} from '@arkiv/core';
import { ctxFor, MockImage, MockLlm, MockTts, MockVideo, productPhoto, setProviders, type VideoProvider } from '@arkiv/core/testing';
import { MockStripe, processStripeEvent, receiveStripeWebhook, setBillingGateway } from '@arkiv/billing';

/**
 * Chaos suite (plan 06 Phase 6 §5): provider outages, crashed workers, webhook storms, duplicate job delivery
 * and concurrent tenants. Invariants: no lost or double-spent entitlement, no stranded reservation, no
 * cross-tenant reads.
 */
beforeEach(async () => {
  await truncateAll();
  setBillingGateway(new MockStripe());
});
afterAll(closeAll);

async function readyForProduction(marker?: string) {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const a = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [a.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
  await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
  if (marker) await ownerPool()`update scenes set visual_plan = visual_plan || ${' ' + marker} where storyboard_id = ${storyboardId} and production_mode = 'GENERATIVE_INTERACTION'`;
  await withTenant(t.workspaceId, async (tx) => {
    await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: `pay:${projectId}` });
    await approveForProduction(tx, ctx, projectId, 'taste');
  });
  return { t, ctx, projectId, storyboardId };
}

describe('provider outage (§44: queue/pause, preserve reservation, clear status; never degrade to avoid cost)', () => {
  it('a video-model outage pauses the order with its credit held, then resumes and charges once', async () => {
    const { t, ctx, projectId, storyboardId } = await readyForProduction('[[fail:render]]');
    expect(await produceProject(ctx, projectId)).toBe('paused');
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state, outage, failure_reason, failure_code, qa_report from projects where id = ${projectId}`;
      expect(p!.state).toBe('NEEDS_USER_ACTION');
      expect((p!.outage as { task: string }).task).toBe('video.scene');
      // Plan 03 P9: the customer sees a queued status naming the partner, never the provider's error.
      expect(p!.failure_reason).toBe('Queued: our video partner is busy. Your place is held.');
      expect(p!.failure_code).toBe('provider_outage');
      const q = await outageStatus(tx, t.workspaceId, projectId);
      expect(q).toMatchObject({ message: 'Queued: our video partner is busy. Your place is held.', etaKind: 'retry' });
      expect(new Date(q!.etaAt!).getTime()).toBeGreaterThan(Date.now());
      const steps = await tx`select detail from progress_steps where subject_id = ${projectId} and status = 'active'`;
      expect(steps.map((x) => x.detail)).toEqual(['Queued: our video partner is busy. Your place is held.']);
      expect(JSON.stringify(p!.qa_report)).not.toMatch(/switched to exact product composite/); // no degraded output
      expect(await available(tx, 'taste')).toBe(0); // reservation held, not released
      const [a] = await tx`select status, expires_at > now() + interval '5 hours' as held from cost_authorizations where project_id = ${projectId} and idempotency_key like 'produce:%'`;
      expect(a).toMatchObject({ status: 'active', held: true });
      expect((await tx`select count(*)::int as n from assets where kind = 'final_export'`)[0]!.n).toBe(0);
    });
    // Provider recovers → the paused production resumes on the same reservation and is charged exactly once.
    await ownerPool()`update scenes set visual_plan = replace(visual_plan, ' [[fail:render]]', '') where storyboard_id = ${storyboardId}`;
    expect(await produceProject(ctx, projectId)).toBe('complete');
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state, outage, qa_report from projects where id = ${projectId}`;
      expect(p).toMatchObject({ state: 'COMPLETE', outage: null });
      expect(JSON.stringify(p!.qa_report)).not.toMatch(/switched to exact product composite/);
      expect(await available(tx, 'taste')).toBe(0);
      const [n] = await tx`select count(*) filter (where type = 'CREDIT_RESERVED')::int as reserved, count(*) filter (where type = 'CREDIT_CONSUMED')::int as consumed from ledger_entries`;
      expect(n).toMatchObject({ reserved: 1, consumed: 1 });
    });
  }, 240_000);

  it('a voice outage on primary and fallback pauses after rendering, then resumes reusing the accepted scenes', async () => {
    const { t, ctx, projectId, storyboardId } = await readyForProduction();
    await ownerPool()`update scenes set spoken_line = coalesce(spoken_line, 'Soft skin.') || ' [[fail:server]]' where storyboard_id = ${storyboardId} and position = 0`;
    expect(await produceProject(ctx, projectId)).toBe('paused');
    const rendersBefore = (await ownerPool()`select count(*)::int as n from scene_versions where kind = 'render' and workspace_id = ${t.workspaceId}`)[0]!.n;
    const renderJobs = async () => (await ownerPool()`select count(*)::int as n from provider_jobs where task = 'video.scene' and workspace_id = ${t.workspaceId}`)[0]!.n as number;
    const renderJobsBefore = await renderJobs();
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state, outage from projects where id = ${projectId}`;
      expect(p!.state).toBe('NEEDS_USER_ACTION');
      expect((p!.outage as { task: string }).task).toBe('tts.voiceover');
      expect(await available(tx, 'taste')).toBe(0);
      const [consumed] = await tx`select count(*)::int as n from ledger_entries where type = 'CREDIT_CONSUMED'`;
      expect(consumed!.n).toBe(0);
    });
    await ownerPool()`update scenes set spoken_line = replace(spoken_line, ' [[fail:server]]', '') where storyboard_id = ${storyboardId}`;
    expect(await produceProject(ctx, projectId)).toBe('complete');
    await withTenant(t.workspaceId, async (tx) => {
      expect(await available(tx, 'taste')).toBe(0);
      const [n] = await tx`select count(*) filter (where type = 'CREDIT_RESERVED')::int as reserved, count(*) filter (where type = 'CREDIT_CONSUMED')::int as consumed from ledger_entries`;
      expect(n).toMatchObject({ reserved: 1, consumed: 1 });
      // Accepted renders from before the pause were reused, not paid for again.
      const [r] = await tx`select count(*)::int as n from scene_versions where kind = 'render'`;
      expect(r!.n).toBe(rendersBefore);
    });
    expect(await renderJobs()).toBe(renderJobsBefore); // no render was sent to the provider again (prod-08)
  }, 240_000);
});

describe('open circuit (§44 "optional approved fallback provider"; plan 05 §10)', () => {
  const restoreRoutes = () =>
    ownerPool()`update model_routes set circuit_open = false, circuit_until = null, fallback_task = case when task = 'tts.voiceover' then fallback_task else null end`.then(() =>
      ownerPool()`delete from model_routes where task = 'video.scene_fallback'`,
    );

  it('fails renders over to the approved route; with none, the order queues with the announced ETA', async () => {
    try {
      await ownerPool()`insert into model_routes (task, provider, model, prompt_version)
                        select 'video.scene_fallback', provider, model, prompt_version from model_routes where task = 'video.scene'`;
      await ownerPool()`update model_routes set fallback_task = 'video.scene_fallback' where task = 'video.scene'`;
      await ownerPool()`update model_routes set circuit_open = true, circuit_until = now() + interval '40 minutes' where task = 'video.scene'`;
      const a = await readyForProduction();
      expect(await produceProject(a.ctx, a.projectId)).toBe('complete');
      const jobs = await ownerPool()`select distinct task from provider_jobs where workspace_id = ${a.t.workspaceId} and task like 'video.%'`;
      expect(jobs.map((j) => j.task)).toEqual(['video.scene_fallback']);

      // Without an approved fallback the order waits, its credit held, telling the customer when it's expected back.
      await ownerPool()`update model_routes set fallback_task = null where task = 'video.scene'`;
      const b = await readyForProduction();
      expect(await produceProject(b.ctx, b.projectId)).toBe('paused');
      await withTenant(b.t.workspaceId, async (tx) => {
        const q = await outageStatus(tx, b.t.workspaceId, b.projectId);
        expect(q).toMatchObject({ message: 'Queued: our video partner is busy. Your place is held.', etaKind: 'reopen' });
        const [r] = await tx`select circuit_until from model_routes where task = 'video.scene'`;
        expect(q!.etaAt).toBe(new Date(r!.circuit_until as string).toISOString());
        expect(await available(tx, 'taste')).toBe(0); // held, not released
      });
      // Nothing was dispatched on the open route.
      expect((await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${b.t.workspaceId} and task like 'video.%'`)[0]!.n).toBe(0);
    } finally {
      await restoreRoutes();
    }
  }, 240_000);
});

describe('duplicate job delivery', () => {
  it('two workers picking up the same production job produce and charge once', async () => {
    const { t, ctx, projectId } = await readyForProduction();
    const results = await Promise.all([produceProject(ctx, projectId), produceProject(ctx, projectId)]);
    expect(results.sort()).toEqual(['complete', 'skipped']);
    await withTenant(t.workspaceId, async (tx) => {
      const [consumed] = await tx`select count(*)::int as n from ledger_entries where type = 'CREDIT_CONSUMED'`;
      expect(consumed!.n).toBe(1);
      const [cr] = await tx`select count(*)::int as n from creatives where project_id = ${projectId}`;
      expect(cr!.n).toBe(1);
    });
  }, 180_000);
});

describe('crashed worker', () => {
  it('the sweeper releases a reservation stranded by a crash', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 3, idempotencyKey: 'grant', periodKey: '2026-09-01' });
      await authorize(tx, ctx, { purpose: 'creative_test', projectId: null, lines: [{ kind: 'media', outputs: 1 }], idempotencyKey: 'crash-1', entitlement: { unit: 'creative_test', amount: 1, periodKey: '2026-09-01' } } as never);
      expect(await available(tx, 'creative_test')).toBe(2);
    });
    // Worker dies; the authorization outlives its TTL.
    await ownerPool()`update cost_authorizations set expires_at = now() - interval '1 minute'`;
    expect(await withSystem((tx) => sweepExpiredAuthorizations(tx))).toBe(1);
    await withTenant(t.workspaceId, async (tx) => {
      expect(await available(tx, 'creative_test')).toBe(3);
      const [a] = await tx`select status from cost_authorizations`;
      expect(a!.status).toBe('released');
    });
    // Idempotent: a second sweep does nothing.
    expect(await withSystem((tx) => sweepExpiredAuthorizations(tx))).toBe(0);
  });

  it('a production interrupted mid-render resumes from durable state: one reservation, one creative, one charge', async () => {
    const { t, ctx, projectId } = await readyForProduction();
    // The first worker's render never returns (the process "dies" while waiting on the provider).
    const mock = new MockVideo();
    let hungTask: string | null = null;
    const hanging: VideoProvider = {
      name: 'byteplus',
      submit: async (req) => {
        const r = await mock.submit(req);
        hungTask ??= r.providerRequestId;
        return r;
      },
      poll: (id) => (id === hungTask ? new Promise(() => {}) : mock.poll(id)),
      cancel: (id) => mock.cancel(id),
    };
    setProviders({ llm: new MockLlm(), image: new MockImage(), video: hanging, tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    void produceProject(ctx, projectId);
    for (let i = 0; i < 200 && !hungTask; i++) await new Promise((r) => setTimeout(r, 50));
    expect(hungTask).not.toBeNull();
    // While the first run holds its lease, a redelivered job is a duplicate and stands down.
    expect(await produceProject(ctx, projectId)).toBe('skipped');

    // Crash: the lease lapses. A redelivery (or the stuck-production sweep) resumes the same order.
    await ownerPool()`update workspace_leases set expires_at = now() - interval '1 second' where resource = ${`produce:${projectId}`}`;
    setProviders(undefined);
    expect(await produceProject(ctx, projectId)).toBe('complete');
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state from projects where id = ${projectId}`;
      expect(p!.state).toBe('COMPLETE');
      const [n] = await tx`select count(*) filter (where type = 'CREDIT_RESERVED')::int as reserved, count(*) filter (where type = 'CREDIT_CONSUMED')::int as consumed from ledger_entries`;
      expect(n).toMatchObject({ reserved: 1, consumed: 1 });
      const [auths] = await tx`select count(*)::int as n from cost_authorizations where project_id = ${projectId} and idempotency_key like 'produce:%'`;
      expect(auths!.n).toBe(1); // the live reservation was taken over, not re-reserved
      const [cr] = await tx`select count(*)::int as n from creatives where project_id = ${projectId}`;
      expect(cr!.n).toBe(1);
      expect(await available(tx, 'taste')).toBe(0);
    });
  }, 240_000);
});

describe('long-running production (§39 heartbeat)', () => {
  it('a run that outlives its reservation TTL keeps the reservation: the sweeper sees the heartbeat, the customer is charged once', async () => {
    const { t, ctx, projectId } = await readyForProduction();
    const mock = new MockVideo();
    let swept: number | null = null;
    // While the first render is in the provider queue, the reservation "expires" and the sweeper runs.
    const slow: VideoProvider = {
      name: 'byteplus',
      submit: (req) => mock.submit(req),
      poll: async (id) => {
        if (swept === null) {
          await ownerPool()`update cost_authorizations set expires_at = now() - interval '1 minute' where project_id = ${projectId}`;
          swept = await withSystem((tx) => sweepExpiredAuthorizations(tx));
          // The run's next heartbeat (every minute while polling) extends the reservation it still holds.
          const [a] = await ownerPool()`select id from cost_authorizations where project_id = ${projectId} and status = 'active'`;
          await withTenant(t.workspaceId, (tx) => heartbeat(tx, t.workspaceId, projectId, a!.id as string));
        }
        return mock.poll(id);
      },
      cancel: (id) => mock.cancel(id),
    };
    setProviders({ llm: new MockLlm(), image: new MockImage(), video: slow, tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    try {
      expect(await produceProject(ctx, projectId)).toBe('complete');
    } finally {
      setProviders(undefined);
    }
    expect(swept).toBe(0); // the live run's reservation was not released under it
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state, heartbeat_at > now() - interval '1 minute' as fresh from projects where id = ${projectId}`;
      expect(p).toMatchObject({ state: 'COMPLETE', fresh: true });
      const [a] = await tx`select status from cost_authorizations where project_id = ${projectId} and idempotency_key like 'produce:%'`;
      expect(a!.status).toBe('settled');
      const [n] = await tx`select count(*) filter (where type = 'CREDIT_RELEASED')::int as released, count(*) filter (where type = 'CREDIT_CONSUMED')::int as consumed from ledger_entries`;
      expect(n).toMatchObject({ released: 0, consumed: 1 });
    });
  }, 240_000);

  it('a heartbeat extends the reservation; without one a stale reservation is released', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    const [p] = await ownerPool()`insert into projects (workspace_id, sku_id, kind, state, created_by) values (${t.workspaceId}, ${skuId}, 'creative_test', 'RENDERING', 'x') returning id`;
    const auth = await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 1, idempotencyKey: 'hb-grant' });
      return authorize(tx, ctx, { purpose: 'creative_test', projectId: p!.id as string, lines: [{ kind: 'media', outputs: 1 }], idempotencyKey: 'hb-1', entitlement: { unit: 'creative_test', amount: 1 }, ttlMinutes: 0 });
    });
    await withTenant(t.workspaceId, (tx) => heartbeat(tx, t.workspaceId, p!.id as string, auth.authorizationId));
    const [a] = await ownerPool()`select expires_at > now() + interval '29 minutes' as extended from cost_authorizations where id = ${auth.authorizationId}`;
    expect(a!.extended).toBe(true);
    // The run dies: no heartbeat for longer than the stale window, and the reservation's TTL passes.
    await ownerPool()`update projects set heartbeat_at = now() - interval '6 minutes' where id = ${p!.id}`;
    await ownerPool()`update cost_authorizations set expires_at = now() - interval '1 minute' where id = ${auth.authorizationId}`;
    expect(await withSystem((tx) => sweepExpiredAuthorizations(tx))).toBe(1);
    expect(liveness(true, new Date(Date.now() - 6 * 60_000)).state).toBe('stalled');
    expect(liveness(true, new Date(Date.now() - 20_000)).state).toBe('working');
    expect(liveness(false, null).state).toBe('idle');
  });
});

describe('webhook storm', () => {
  it('ten concurrent deliveries of the same Stripe event grant once', async () => {
    const t = await makeTenant();
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_storm', ${t.workspaceId})`;
    const evt = { id: 'evt_storm_1', type: 'invoice.payment_failed', created: Math.floor(Date.now() / 1000), data: { object: { id: 'in_1', customer: 'cus_storm', subscription: 'sub_x' } } };
    const received = await Promise.all(Array.from({ length: 10 }, () => receiveStripeWebhook(JSON.stringify(evt), null)));
    expect(received.filter((r) => !r.duplicate)).toHaveLength(1);
    await Promise.all(Array.from({ length: 5 }, () => processStripeEvent('evt_storm_1')));
    const [row] = await ownerPool()`select status from stripe_events where id = 'evt_storm_1'`;
    expect(['processed', 'unmatched', 'ignored']).toContain(row!.status);
    const emails = await ownerPool()`select count(*)::int as n from email_log where template = 'payment_failed'`;
    expect(emails[0]!.n).toBeLessThanOrEqual(1);
  });
});

describe('tenant isolation under concurrency', () => {
  it('interleaved tenant transactions on a shared pool never see each other, and context never leaks', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await makeSku(a.workspaceId);
    await makeSku(a.workspaceId);
    await makeSku(b.workspaceId);
    const runs = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const ws = i % 2 ? a.workspaceId : b.workspaceId;
        return withTenant(ws, async (tx) => {
          const rows = await tx`select workspace_id from skus`;
          return { ws, seen: [...new Set(rows.map((r) => r.workspace_id as string))], n: rows.length };
        });
      }),
    );
    for (const r of runs) {
      expect(r.seen).toEqual([r.ws]);
      expect(r.n).toBe(r.ws === a.workspaceId ? 2 : 1);
    }
    // After all those transactions, a context-free query on the same pool still fails closed.
    await expect(globalTx((tx) => tx`select count(*) from skus`)).rejects.toThrow(/tenant context not set/);
  });
});
