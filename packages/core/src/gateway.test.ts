import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { MockImage, MockLlm, MockTts, MockVideo, providers, setProviders, type LlmJsonRequest, type LlmJsonResult } from '@arkiv/providers';
import { newId } from '@arkiv/shared';
import { armComparison } from './canary';
import { authorize } from './cost-governor';
import { generateVideo, llmJson, reconcileProviderJobs, routedLines, type ProviderQueueState } from './model-gateway';
import { queueDetail } from './production';
import { ctxFor, eventContractProblems } from './testing';

/**
 * Model Gateway: usage-ledger events per provider job (§37), exactly-once closing and reconciliation of jobs a
 * crashed worker left open (§39), approved fallback routes on outage (§44), pinned versions and per-arm
 * metrics (§41, §48).
 */
const TEST_ROUTES = ['qa.fidelity_fallback', 'video.scene_fallback', 'qa.fidelity_elsewhere'];
async function restore() {
  await ownerPool()`update model_routes set canary = null, circuit_open = false, circuit_until = null, pinned_model_version = null,
                      fallback_task = case when task = 'tts.voiceover' then fallback_task else null end`;
  await ownerPool()`delete from model_routes where task = any(${TEST_ROUTES})`;
}
beforeEach(async () => {
  await truncateAll();
  await restore();
});
afterEach(async () => {
  setProviders(undefined);
  await restore();
});
afterAll(closeAll);

/** A mock LLM that records the wire model of every call. */
class RecordingLlm extends MockLlm {
  models: string[] = [];
  override async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
    this.models.push(req.model);
    return super.json(req);
  }
}

async function tokenFor(workspaceId: string, userId: string, task = 'qa.fidelity', kind: 'llm' | 'video' = 'llm') {
  const ctx = ctxFor(workspaceId, userId);
  const lines = await withTenant(workspaceId, (tx) =>
    routedLines(tx, workspaceId, [kind === 'llm' ? { task, kind: 'llm', inputTokens: 40_000, outputTokens: 8_000 } : { task, kind: 'video', seconds: 10, resolution: '720p' }]),
  );
  const a = await withTenant(workspaceId, (tx) => authorize(tx, ctx, { purpose: 'creative_test', lines, idempotencyKey: `gw:${newId()}` }));
  return { ctx, token: a.token, authorizationId: a.authorizationId };
}

const ask = (ctx: ReturnType<typeof ctxFor>, token: string, text = 'Is this the same product?') =>
  llmJson({ ctx, token, task: 'qa.fidelity', subject: { type: 'scene', id: newId() }, system: 'x', content: [{ type: 'text', text }], schema: z.object({ ok: z.boolean() }), mock: () => ({ ok: true }), maxTokens: 400 });

describe('provider job events (standard §37 usage ledger; arch-05)', () => {
  it('opens and closes every call with an event carrying its job, authorization and subject', async () => {
    const t = await makeTenant();
    const { ctx, token, authorizationId } = await tokenFor(t.workspaceId, t.userId);
    const ok = await ask(ctx, token);
    await expect(ask(ctx, token, 'Check this [[fail:invalid]]')).rejects.toMatchObject({ kind: 'invalid' });
    const jobs = await ownerPool()`select id, status, provider_request_id, raw_meta, actual_micros from provider_jobs where workspace_id = ${t.workspaceId} order by created_at`;
    expect(jobs.map((j) => j.status)).toEqual(['succeeded', 'failed']);
    // §39: the provider's request id and raw response metadata are kept, with the planned line and the wire model.
    expect(jobs[0]!.provider_request_id).toBe(ok.providerRequestId);
    expect(jobs[0]!.raw_meta).toMatchObject({ planned: { kind: 'llm' }, wireModel: expect.any(String), mock: true });
    const events = await ownerPool()`select type, subject_id, payload, refs from events where workspace_id = ${t.workspaceId} and type like 'PROVIDER_JOB_%' order by seq`;
    expect(events.map((e) => e.type)).toEqual(['PROVIDER_JOB_CREATED', 'PROVIDER_JOB_SUCCEEDED', 'PROVIDER_JOB_CREATED', 'PROVIDER_JOB_FAILED']);
    expect(events[0]!.subject_id).toBe(jobs[0]!.id);
    expect(events[0]!.payload).toMatchObject({ task: 'qa.fidelity', provider: 'anthropic', arm: 'stable' });
    expect(events[0]!.refs).toMatchObject({ providerJobId: jobs[0]!.id, authorizationId, sceneId: expect.any(String) });
    expect(events[1]!.payload).toMatchObject({ task: 'qa.fidelity', actualMicros: Number(jobs[0]!.actual_micros), providerRequestId: ok.providerRequestId });
    expect(events[3]!.payload).toMatchObject({ task: 'qa.fidelity', errorKind: 'invalid', actualMicros: 0 });
    expect(await eventContractProblems(t.workspaceId)).toEqual([]);
  });
});

describe('partial provider billing (plan 06 Phase 3 tests; standard §37 all spend accounted)', () => {
  it('a failed call the provider still billed books its cost on the job and in the ledger', async () => {
    const t = await makeTenant();
    const { ctx, token, authorizationId } = await tokenFor(t.workspaceId, t.userId);
    await expect(ask(ctx, token, 'Check this [[fail:partial]]')).rejects.toMatchObject({ kind: 'server', billed: { tokens: { output: 400 } } });
    const [job] = await ownerPool()`select id, status, actual_micros, raw_meta from provider_jobs where workspace_id = ${t.workspaceId}`;
    expect(job).toMatchObject({ status: 'failed' });
    expect(Number(job!.actual_micros)).toBeGreaterThan(0);
    expect(job!.raw_meta).toMatchObject({ errorKind: 'server', billedOnFailure: [{ kind: 'llm', outputTokens: 400 }] });
    const [cost] = await ownerPool()`select amount from ledger_entries where workspace_id = ${t.workspaceId} and type = 'PROVIDER_COST_RECORDED' and authorization_id = ${authorizationId}`;
    expect(Number(cost!.amount)).toBe(Number(job!.actual_micros));
    const [ev] = await ownerPool()`select payload from events where workspace_id = ${t.workspaceId} and type = 'PROVIDER_JOB_FAILED'`;
    expect(ev!.payload).toMatchObject({ actualMicros: Number(job!.actual_micros) });
    // A plain failure is still booked at zero.
    await expect(ask(ctx, token, 'Check this [[fail:invalid]]')).rejects.toMatchObject({ kind: 'invalid' });
    const [plain] = await ownerPool()`select actual_micros from provider_jobs where workspace_id = ${t.workspaceId} and error like '%injected invalid%'`;
    expect(Number(plain!.actual_micros)).toBe(0);
  });

  it('a render that failed after generating is booked at the seconds it rendered', async () => {
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId, 'video.scene', 'video');
    const e = await generateVideo({ ctx, token, task: 'video.scene', subject: null, prompt: 'hands [[fail:partial]]', references: [], seconds: 5, resolution: '720p', ratio: '9:16' }).catch((x) => x);
    expect(e).toMatchObject({ billed: { seconds: 5 } });
    const [job] = await ownerPool()`select status, actual_micros, estimate_micros from provider_jobs where workspace_id = ${t.workspaceId}`;
    expect(job!.status).toBe('failed');
    // Five generated seconds are what a successful five-second render costs.
    expect(Number(job!.actual_micros)).toBe(Number(job!.estimate_micros));
  });
});

describe('promotional packages (standard §6: recorded as savings)', () => {
  it('realized cost is the discounted amount, the list-price difference is kept as savings, estimates stay at list', async () => {
    const t = await makeTenant();
    try {
      await ownerPool()`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, status)
                        select provider, model, 2, unit, rates || '{"promo_paid_ppm": 555556}'::jsonb, now() - interval '1 minute', 'published'
                        from provider_rate_tables where provider = 'byteplus' and model = 'dreamina-seedance-2-5' and version = 1`;
      const { ctx, token, authorizationId } = await tokenFor(t.workspaceId, t.userId, 'video.scene', 'video');
      await generateVideo({ ctx, token, task: 'video.scene', subject: null, prompt: 'hands', references: [], seconds: 5, resolution: '720p', ratio: '9:16' });
      const [job] = await ownerPool()`select actual_micros, savings_micros from provider_jobs where workspace_id = ${t.workspaceId}`;
      const list = 5 * 231333;
      expect(Number(job!.actual_micros)).toBe(Math.ceil((list * 555556) / 1_000_000));
      expect(Number(job!.savings_micros)).toBe(list - Number(job!.actual_micros));
      const [cost] = await ownerPool()`select amount from ledger_entries where workspace_id = ${t.workspaceId} and type = 'PROVIDER_COST_RECORDED' and authorization_id = ${authorizationId}`;
      expect(Number(cost!.amount)).toBe(Number(job!.actual_micros));
      // The authorization was planned at list price (a promotion is never needed for retail viability).
      const [a] = await ownerPool()`select max_cost_micros from cost_authorizations where id = ${authorizationId}`;
      expect(Number(a!.max_cost_micros)).toBe(Math.ceil(10 * 231333 * 1.25));
    } finally {
      await ownerPool()`delete from provider_rate_tables where provider = 'byteplus' and model = 'dreamina-seedance-2-5' and version = 2`;
    }
  });
});

describe('pinned provider versions (standard §48; arch-35)', () => {
  it('sends the pinned version on the stable arm, and never pins a canary on another model', async () => {
    const llm = new RecordingLlm();
    setProviders({ llm, image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => `wire:${m}` });
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    const [r] = await ownerPool()`select model from model_routes where task = 'qa.fidelity'`;
    await ask(ctx, token);
    await ownerPool()`update model_routes set pinned_model_version = 'pinned-2026-09-01' where task = 'qa.fidelity'`;
    await ask(ctx, token);
    // A prompt-only canary keeps the stable model, so the pin still applies…
    await ownerPool()`update model_routes set canary = ${ownerPool().json({ promptVersion: 'fidelity@9.9.9', pct: 100 })} where task = 'qa.fidelity'`;
    await ask(ctx, token);
    // …a canary on another model is sent as that model is configured, never with this model's pin.
    await ownerPool()`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, status)
                      select provider, 'canary-model', 1, unit, rates, effective_from, 'published' from provider_rate_tables
                      where provider = 'anthropic' and model = ${r!.model as string} and status = 'published' limit 1`;
    try {
      await ownerPool()`update model_routes set canary = ${ownerPool().json({ model: 'canary-model', pct: 100 })} where task = 'qa.fidelity'`;
      const again = await tokenFor(t.workspaceId, t.userId);
      await ask(ctx, again.token);
    } finally {
      await ownerPool()`delete from provider_rate_tables where model = 'canary-model'`;
    }
    expect(llm.models).toEqual([`wire:${r!.model as string}`, 'pinned-2026-09-01', 'pinned-2026-09-01', 'wire:canary-model']);
    const jobs = await ownerPool()`select raw_meta->>'wireModel' as wire, arm from provider_jobs where workspace_id = ${t.workspaceId} order by created_at`;
    expect(jobs.map((j) => j.wire)).toEqual(llm.models);
    expect(jobs.map((j) => j.arm)).toEqual(['stable', 'stable', 'canary', 'canary']);
  });

  it('compares canary and stable per route: calls, error rate, latency and cost', async () => {
    const t = await makeTenant();
    const job = (arm: string, status: string, latency: number, cost: number) =>
      ownerPool()`insert into provider_jobs (workspace_id, provider, task, model, request_hash, status, arm, latency_ms, actual_micros)
                  values (${t.workspaceId}, 'anthropic', 'qa.fidelity', 'm', 'h', ${status}, ${arm}, ${latency}, ${cost})`;
    await job('stable', 'succeeded', 100, 1000);
    await job('stable', 'succeeded', 300, 3000);
    await job('stable', 'failed', 900, 0);
    await job('canary', 'succeeded', 200, 500);
    const rows = await withAdmin((tx) => armComparison(tx, 7));
    const stable = rows.find((r) => r.task === 'qa.fidelity' && r.arm === 'stable')!;
    const canary = rows.find((r) => r.task === 'qa.fidelity' && r.arm === 'canary')!;
    expect(stable).toMatchObject({ calls: 3, failed: 1, p50LatencyMs: 300, avgCostMicros: 2000, qaFirst: 0, projects: 0 });
    expect(stable.errorRate).toBeCloseTo(1 / 3);
    expect(canary).toMatchObject({ calls: 1, failed: 0, errorRate: 0, p50LatencyMs: 200, avgCostMicros: 500 });
  });
});

describe('approved fallback routes on outage (standard §44; arch-24)', () => {
  async function fallbackRoute(task: string, of: string, provider?: string) {
    await ownerPool()`insert into model_routes (task, provider, model, prompt_version)
                      select ${task}, coalesce(${provider ?? null}::text, provider), model, prompt_version || '-fallback' from model_routes where task = ${of}`;
    await ownerPool()`update model_routes set fallback_task = ${task} where task = ${of}`;
  }

  it('an open circuit fails over to the approved route: its own job, route and prompt version', async () => {
    await fallbackRoute('qa.fidelity_fallback', 'qa.fidelity');
    await ownerPool()`update model_routes set circuit_open = true where task = 'qa.fidelity'`;
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    const r = await ask(ctx, token);
    expect(r.task).toBe('qa.fidelity_fallback');
    expect(r.promptVersion).toMatch(/-fallback$/);
    const jobs = await ownerPool()`select task, status from provider_jobs where workspace_id = ${t.workspaceId}`;
    expect(jobs).toEqual([{ task: 'qa.fidelity_fallback', status: 'succeeded' }]); // the refused primary never opened a job
  });

  it('a render outage fails over to the approved video route', async () => {
    await fallbackRoute('video.scene_fallback', 'video.scene');
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId, 'video.scene', 'video');
    const v = await generateVideo({ ctx, token, task: 'video.scene', subject: null, prompt: 'hands [[fail:render]]', references: [], seconds: 5, resolution: '720p', ratio: '9:16' }).catch((e) => e);
    // The mock fails every render of this prompt, so the fallback fails too — and its own error is the answer.
    expect(v).toMatchObject({ kind: 'server' });
    const jobs = await ownerPool()`select task, status from provider_jobs where workspace_id = ${t.workspaceId} order by created_at`;
    expect(jobs).toEqual([{ task: 'video.scene', status: 'failed' }, { task: 'video.scene_fallback', status: 'failed' }]);
    await ownerPool()`update model_routes set circuit_open = true where task = 'video.scene'`;
    const ok = await generateVideo({ ctx, token, task: 'video.scene', subject: null, prompt: 'hands', references: [], seconds: 5, resolution: '720p', ratio: '9:16' });
    expect(ok.task).toBe('video.scene_fallback');
  });

  it('fails over to another provider when an adapter is registered for it, priced at that provider’s rates (§53)', async () => {
    const backup = { llm: new MockLlm('mock-backup'), image: new MockImage('mock-backup'), video: new MockVideo(10, 'mock-backup') };
    setProviders({ llm: new MockLlm(), image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), named: { llm: { 'mock-backup': backup.llm }, video: { 'mock-backup': backup.video } }, wireModel: (m) => m });
    const [primary] = await ownerPool()`select model from model_routes where task = 'video.scene'`;
    // The backup provider publishes its own (dearer) rate for the same model.
    await ownerPool()`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, status)
                      values ('mock-backup', ${primary!.model as string}, 1, 'per_second', ${ownerPool().json({ per_second_720p: 300_000, per_second_1080p: 600_000 })}, now() - interval '1 hour', 'published')`;
    try {
      await fallbackRoute('video.scene_fallback', 'video.scene', 'mock-backup');
      await ownerPool()`update model_routes set circuit_open = true where task = 'video.scene'`;
      const t = await makeTenant();
      const { ctx, token } = await tokenFor(t.workspaceId, t.userId, 'video.scene', 'video');
      const v = await generateVideo({ ctx, token, task: 'video.scene', subject: null, prompt: 'hands', references: [], seconds: 5, resolution: '720p', ratio: '9:16' });
      expect(v.task).toBe('video.scene_fallback');
      expect(backup.video.requests).toHaveLength(1);
      const jobs = await ownerPool()`select task, provider, status, actual_micros from provider_jobs where workspace_id = ${t.workspaceId}`;
      expect(jobs).toEqual([{ task: 'video.scene_fallback', provider: 'mock-backup', status: 'succeeded', actual_micros: 5 * 300_000 }]);
      // An LLM route on a provider with no adapter still can't fail over (the next test), one with an adapter can.
      await fallbackRoute('qa.fidelity_elsewhere', 'qa.fidelity', 'mock-backup');
      await ownerPool()`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, status)
                        select 'mock-backup', model, 1, unit, rates, effective_from, status from provider_rate_tables
                        where provider = 'anthropic' and model = (select model from model_routes where task = 'qa.fidelity') and status = 'published' order by version desc limit 1`;
      await ownerPool()`update model_routes set circuit_open = true where task = 'qa.fidelity'`;
      const { token: t2 } = await tokenFor(t.workspaceId, t.userId);
      expect((await ask(ctx, t2)).task).toBe('qa.fidelity_elsewhere');
    } finally {
      await ownerPool()`delete from provider_rate_tables where provider = 'mock-backup'`;
    }
  });

  it('never fails over for content problems, to a provider no adapter serves, or to a route that is down too', async () => {
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    await fallbackRoute('qa.fidelity_fallback', 'qa.fidelity');
    await expect(ask(ctx, token, 'x [[fail:invalid]]')).rejects.toMatchObject({ kind: 'invalid' });
    expect((await ownerPool()`select count(*)::int as n from provider_jobs where task = 'qa.fidelity_fallback'`)[0]!.n).toBe(0);
    await ownerPool()`update model_routes set circuit_open = true where task in ('qa.fidelity', 'qa.fidelity_fallback')`;
    await expect(ask(ctx, token)).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { circuitOpen: 'qa.fidelity' } });
    await restore();
    await fallbackRoute('qa.fidelity_elsewhere', 'qa.fidelity', 'another-llm-vendor');
    await ownerPool()`update model_routes set circuit_open = true where task = 'qa.fidelity'`;
    await expect(ask(ctx, token)).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { circuitOpen: 'qa.fidelity' } });
  });
});

describe('reconciling provider jobs a crashed worker left open (standard §39; arch-17)', () => {
  it('collects a finished render into our storage at its real cost, closes abandoned calls, and closes each job once', async () => {
    const t = await makeTenant();
    const { authorizationId } = await tokenFor(t.workspaceId, t.userId, 'video.scene', 'video');
    const p = await providers();
    const { providerRequestId } = await p.video.submit({ model: 'm', prompt: 'hands', references: [], seconds: 5, resolution: '720p', ratio: '9:16' });
    const sceneId = newId();
    const planned = { kind: 'video', provider: 'byteplus', model: (await ownerPool()`select model from model_routes where task = 'video.scene'`)[0]!.model, seconds: 5, resolution: '720p', retryReserve: false };
    const open = (task: string, requestId: string | null, subject: string | null, estimate: number) =>
      ownerPool()`insert into provider_jobs (workspace_id, provider, task, model, request_hash, status, authorization_id, estimate_micros, provider_request_id,
                    subject_type, subject_id, input_refs, raw_meta, created_at)
                  values (${t.workspaceId}, 'byteplus', ${task}, 'm', 'h', 'dispatched', ${authorizationId}, ${estimate}, ${requestId},
                    ${subject ? 'scene' : null}, ${subject}, ${ownerPool().json({ inputHash: 'abc' })}, ${ownerPool().json({ planned })}, now() - interval '45 minutes')
                  returning id`;
    const [render] = await open('video.scene', providerRequestId, sceneId, 900_000);
    const [lost] = await open('video.scene', null, null, 900_000);
    const [call] = await open('qa.fidelity', null, null, 12_345);
    const [recent] = await ownerPool()`insert into provider_jobs (workspace_id, provider, task, model, request_hash, status, authorization_id, estimate_micros)
                                       values (${t.workspaceId}, 'anthropic', 'qa.fidelity', 'm', 'h', 'dispatched', ${authorizationId}, 1) returning id`;
    // The mock finishes the render once it's polled after its latency.
    await new Promise((r) => setTimeout(r, 80));
    expect(await reconcileProviderJobs()).toEqual({ succeeded: 1, failed: 2, pending: 0 });
    const jobs = await ownerPool()`select id, status, actual_micros, output_asset_id, error from provider_jobs where workspace_id = ${t.workspaceId}`;
    const byId = new Map(jobs.map((j) => [j.id as string, j]));
    const r = byId.get(render!.id as string)!;
    expect(r.status).toBe('succeeded');
    expect(Number(r.actual_micros)).toBeGreaterThan(0);
    const [asset] = await ownerPool()`select kind, lineage from assets where id = ${r.output_asset_id}`;
    expect(asset).toMatchObject({ kind: 'scene_render', lineage: { sceneId, providerJobId: render!.id, inputHash: 'abc', reconciled: true } });
    expect(byId.get(lost!.id as string)!.status).toBe('failed');
    expect(Number(byId.get(lost!.id as string)!.actual_micros)).toBe(0);
    // An abandoned synchronous call can't be polled: booked at its estimate, never under-counted.
    expect(byId.get(call!.id as string)!.status).toBe('failed');
    expect(Number(byId.get(call!.id as string)!.actual_micros)).toBe(12_345);
    expect(byId.get(recent!.id as string)!.status).toBe('dispatched'); // too recent to be abandoned
    const cost = await ownerPool()`select provider_job_id, amount from ledger_entries where workspace_id = ${t.workspaceId} and type = 'PROVIDER_COST_RECORDED'`;
    expect(cost.map((c) => c.provider_job_id).sort()).toEqual([render!.id, call!.id].sort());
    // A second pass (or a late finish from a worker that was only slow) changes nothing.
    expect(await reconcileProviderJobs()).toEqual({ succeeded: 0, failed: 0, pending: 0 });
    expect((await ownerPool()`select count(*)::int as n from ledger_entries where workspace_id = ${t.workspaceId} and type = 'PROVIDER_COST_RECORDED'`)[0]!.n).toBe(2);
    const events = await ownerPool()`select type from events where workspace_id = ${t.workspaceId} and type like 'PROVIDER_JOB_%'`;
    expect(events.map((e) => e.type).sort()).toEqual(['PROVIDER_JOB_FAILED', 'PROVIDER_JOB_FAILED', 'PROVIDER_JOB_SUCCEEDED']);
  });
});

describe('provider queue state (§48 very long provider queue)', () => {
  it('records the provider’s queued/running state and ETA and tells the caller, without resubmitting', async () => {
    const video = new MockVideo(60, 'byteplus', 150);
    setProviders({ llm: new MockLlm(), image: new MockImage(), video, tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId, 'video.scene', 'video');
    const seen: ProviderQueueState[] = [];
    const jobs: unknown[] = [];
    await generateVideo({
      ctx, token, task: 'video.scene', subject: null, prompt: 'hands', references: [], seconds: 5, resolution: '720p', ratio: '9:16', pollMs: 10,
      onQueue: async (q) => {
        seen.push(q);
        jobs.push((await ownerPool()`select poll_status, queue_position from provider_jobs where workspace_id = ${t.workspaceId}`)[0]);
      },
    });
    expect(video.requests).toHaveLength(1); // waited, never resubmitted
    expect(seen[0]).toMatchObject({ status: 'queued', position: 3 });
    expect(seen[0]!.etaAt).toBeInstanceOf(Date);
    expect(seen.some((q) => q.status === 'running')).toBe(true);
    expect(jobs[0]).toEqual({ poll_status: 'queued', queue_position: 3 });
    const [job] = await ownerPool()`select status, poll_status from provider_jobs where workspace_id = ${t.workspaceId}`;
    expect(job).toMatchObject({ status: 'succeeded', poll_status: 'running' });
  });

  it('shows the wait on the production progress', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(queueDetail({ status: 'queued', position: 4, etaAt: new Date(now + 7.5 * 60_000) }, 2, now)).toBe('Waiting in the video queue (position 4) · ~8 min');
    expect(queueDetail({ status: 'queued', position: null, etaAt: null }, 2, now)).toBe('Waiting in the video queue');
    expect(queueDetail({ status: 'running', position: null, etaAt: new Date(now + 30_000) }, 3, now)).toBe('Rendering scene 3 · ~1 min');
  });
});
