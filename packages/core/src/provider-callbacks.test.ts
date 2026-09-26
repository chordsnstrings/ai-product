import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { MockImage, MockLlm, MockTts, MockVideo, setProviders } from '@arkiv/providers';
import { newId, resetEnvCache } from '@arkiv/shared';
import { authorize } from './cost-governor';
import { collectOpenRender, generateVideo, reconcileProviderJobs, routedLines } from './model-gateway';
import { providerCallbackUrl, publicAppUrl, receiveProviderCallback, verifyProviderCallback } from './provider-callbacks';
import { ctxFor } from './testing';
import { processPendingWebhooks } from './webhooks';

/**
 * Provider render callbacks (standard §39 "provider callback + polling with idempotent state machine"; §35 "a
 * duplicate provider callback cannot double-settle credits"). The mock provider plays the callbacks late, twice and
 * out of order.
 */
let video: MockVideo;
beforeEach(async () => {
  await truncateAll();
  process.env.PROVIDER_CALLBACK_SECRET = 'callback-secret-for-tests-0001';
  process.env.APP_URL = 'https://app.arkiv.test';
  resetEnvCache();
  video = new MockVideo(30);
  setProviders({ llm: new MockLlm(), image: new MockImage(), video, tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
});
afterEach(() => {
  delete process.env.PROVIDER_CALLBACK_SECRET;
  delete process.env.APP_URL;
  resetEnvCache();
  setProviders(undefined);
});
afterAll(closeAll);

const deps = { resendEvent: async () => {} };

async function videoToken(workspaceId: string, userId: string) {
  const ctx = ctxFor(workspaceId, userId);
  const lines = await withTenant(workspaceId, (tx) => routedLines(tx, workspaceId, [{ task: 'video.scene', kind: 'video', seconds: 5, resolution: '720p' }]));
  const a = await withTenant(workspaceId, (tx) => authorize(tx, ctx, { purpose: 'creative_test', lines, idempotencyKey: `cb:${newId()}` }));
  return { ctx, token: a.token, authorizationId: a.authorizationId };
}

/** A render submitted by a worker that then died: dispatched, with a provider task, last polled `polledAgo` ago. */
async function orphanedRender(t: Awaited<ReturnType<typeof makeTenant>>, polledAgo = '10 minutes', sceneId = newId()) {
  const { authorizationId } = await videoToken(t.workspaceId, t.userId);
  const jobId = newId();
  const { providerRequestId } = await video.submit({ model: 'm', prompt: 'hands', references: [], seconds: 5, resolution: '720p', ratio: '9:16', callbackUrl: providerCallbackUrl('byteplus', jobId)! });
  const planned = { kind: 'video', provider: 'byteplus', model: (await ownerPool()`select model from model_routes where task = 'video.scene'`)[0]!.model, seconds: 5, resolution: '720p', retryReserve: false };
  await ownerPool()`insert into provider_jobs (id, workspace_id, provider, task, model, request_hash, status, authorization_id, estimate_micros, provider_request_id,
                      subject_type, subject_id, input_refs, raw_meta, last_polled_at)
                    values (${jobId}, ${t.workspaceId}, 'byteplus', 'video.scene', 'm', 'h', 'dispatched', ${authorizationId}, 900000, ${providerRequestId},
                      'scene', ${sceneId}, ${ownerPool().json({ sceneId, inputHash: 'abc' })}, ${ownerPool().json({ planned })}, now() - ${polledAgo}::interval)`;
  await new Promise((r) => setTimeout(r, 60)); // the mock finishes after its latency
  return { jobId, providerRequestId };
}

describe('callback URL', () => {
  it('is signed per job and only offered when the app is publicly reachable', () => {
    const jobId = newId();
    const url = new URL(providerCallbackUrl('byteplus', jobId)!);
    expect(url.origin + url.pathname).toBe('https://app.arkiv.test/api/webhooks/provider/byteplus');
    expect(url.searchParams.get('job')).toBe(jobId);
    expect(verifyProviderCallback('byteplus', jobId, url.searchParams.get('sig'))).toBe(true);
    expect(verifyProviderCallback('byteplus', newId(), url.searchParams.get('sig'))).toBe(false); // another job
    expect(verifyProviderCallback('byteplus', jobId, `${url.searchParams.get('sig')!.slice(0, -1)}A`)).toBe(false);
    expect(verifyProviderCallback('byteplus', jobId, null)).toBe(false);
    expect(providerCallbackUrl('minimax', jobId)).toBeNull(); // not a video provider that calls back
    for (const local of ['http://localhost:3000', 'https://localhost', 'https://192.168.1.4', 'http://app.arkiv.test']) expect(publicAppUrl(local), local).toBe(false);
    delete process.env.PROVIDER_CALLBACK_SECRET;
    resetEnvCache();
    expect(providerCallbackUrl('byteplus', jobId)).toBeNull();
  });

  it('is handed to the provider on submit; a live worker records that it is polling', async () => {
    const t = await makeTenant();
    const { ctx, token } = await videoToken(t.workspaceId, t.userId);
    const r = await generateVideo({ ctx, token, task: 'video.scene', subject: null, prompt: 'hands', references: [], seconds: 5, resolution: '720p', ratio: '9:16', pollMs: 5 });
    expect(video.requests.at(-1)!.callbackUrl).toContain(`job=${r.jobId}`);
    const [job] = await ownerPool()`select status, last_polled_at from provider_jobs where id = ${r.jobId}`;
    expect(job!.status).toBe('succeeded');
    expect(job!.last_polled_at).not.toBeNull();
  });
});

describe('settling from a callback', () => {
  it('settles a render whose worker died, once, however many times and in whatever order the callback arrives', async () => {
    const t = await makeTenant();
    const { jobId, providerRequestId } = await orphanedRender(t);
    const done = video.callbackFor(providerRequestId, 'succeeded');
    expect(await receiveProviderCallback('byteplus', jobId, done.body)).toBe(true);
    expect(await receiveProviderCallback('byteplus', jobId, done.body)).toBe(false); // the provider's retry
    // A stale 'running' callback delivered after the final one.
    expect(await receiveProviderCallback('byteplus', jobId, video.callbackFor(providerRequestId, 'running').body)).toBe(true);
    await processPendingWebhooks(deps);
    const [job] = await ownerPool()`select status, output_asset_id, callback_at, settling_at from provider_jobs where id = ${jobId}`;
    expect(job).toMatchObject({ status: 'succeeded' });
    expect(job!.callback_at).not.toBeNull();
    expect(await ownerPool()`select 1 from assets where workspace_id = ${t.workspaceId} and kind = 'scene_render'`).toHaveLength(1);
    expect(await ownerPool()`select 1 from ledger_entries where provider_job_id = ${jobId} and type = 'PROVIDER_COST_RECORDED'`).toHaveLength(1);
    expect(await ownerPool()`select 1 from events where subject_id = ${jobId} and type = 'PROVIDER_JOB_SUCCEEDED'`).toHaveLength(1);
    // A late duplicate (a new delivery id) and the reconciler's sweep change nothing.
    await ownerPool()`delete from webhook_receipts`;
    await receiveProviderCallback('byteplus', jobId, done.body);
    await processPendingWebhooks(deps);
    expect(await reconcileProviderJobs()).toEqual({ succeeded: 0, failed: 0, pending: 0 });
    expect(await ownerPool()`select 1 from assets where workspace_id = ${t.workspaceId} and kind = 'scene_render'`).toHaveLength(1);
    expect(await ownerPool()`select 1 from ledger_entries where provider_job_id = ${jobId} and type = 'PROVIDER_COST_RECORDED'`).toHaveLength(1);
  });

  it('leaves a render to the worker that is still polling it, and the reconciler does too', async () => {
    const t = await makeTenant();
    const { jobId, providerRequestId } = await orphanedRender(t, '5 seconds');
    await ownerPool()`update provider_jobs set created_at = now() - interval '45 minutes' where id = ${jobId}`;
    await receiveProviderCallback('byteplus', jobId, video.callbackFor(providerRequestId, 'succeeded').body);
    await processPendingWebhooks(deps);
    expect((await ownerPool()`select status from webhook_receipts`)[0]!.status).toBe('ignored');
    expect(await reconcileProviderJobs()).toEqual({ succeeded: 0, failed: 0, pending: 0 });
    const [job] = await ownerPool()`select status, callback_at from provider_jobs where id = ${jobId}`;
    expect(job!.status).toBe('dispatched');
    expect(job!.callback_at).not.toBeNull();
    expect(await ownerPool()`select 1 from assets where workspace_id = ${t.workspaceId}`).toHaveLength(0);
  });

  it('ignores a callback naming another task, and never lets two settlers copy the same output', async () => {
    const t = await makeTenant();
    const { jobId, providerRequestId } = await orphanedRender(t);
    await receiveProviderCallback('byteplus', jobId, { id: 'someone-elses-task', status: 'succeeded' });
    await processPendingWebhooks(deps);
    expect((await ownerPool()`select status from provider_jobs where id = ${jobId}`)[0]!.status).toBe('dispatched');
    // Another process holds the settlement claim: this callback leaves the job alone (and retries later).
    await ownerPool()`update provider_jobs set settling_at = now() where id = ${jobId}`;
    await receiveProviderCallback('byteplus', jobId, video.callbackFor(providerRequestId, 'succeeded').body);
    await processPendingWebhooks(deps);
    expect((await ownerPool()`select status from provider_jobs where id = ${jobId}`)[0]!.status).toBe('dispatched');
    expect((await ownerPool()`select status, attempts from webhook_receipts where delivery_id = ${`${jobId}:${providerRequestId}:succeeded`}`)[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await ownerPool()`select 1 from assets where workspace_id = ${t.workspaceId}`).toHaveLength(0);
    // The claim goes stale (its holder crashed): the retry settles it.
    await ownerPool()`update provider_jobs set settling_at = now() - interval '11 minutes' where id = ${jobId}`;
    await ownerPool()`update webhook_receipts set claimed_at = now() - interval '1 hour'`;
    await processPendingWebhooks(deps);
    expect((await ownerPool()`select status from provider_jobs where id = ${jobId}`)[0]!.status).toBe('succeeded');
  });

  it('a resumed production collects the render its crashed run submitted instead of paying for another', async () => {
    const t = await makeTenant();
    const sceneId = newId();
    const { jobId } = await orphanedRender(t, '10 minutes', sceneId);
    expect(await collectOpenRender(t.workspaceId, sceneId, 'other-inputs')).toBe(false); // different inputs: not this render
    expect(await collectOpenRender(t.workspaceId, sceneId, 'abc')).toBe(true);
    const [asset] = await ownerPool()`select lineage from assets where workspace_id = ${t.workspaceId} and kind = 'scene_render'`;
    expect(asset!.lineage).toMatchObject({ sceneId, inputHash: 'abc', providerJobId: jobId });
    expect((await ownerPool()`select status from provider_jobs where id = ${jobId}`)[0]!.status).toBe('succeeded');
    expect(await collectOpenRender(t.workspaceId, sceneId, 'abc')).toBe(false); // nothing left open
    // A render another worker is still polling is not taken from it.
    const live = newId();
    await orphanedRender(t, '5 seconds', live);
    expect(await collectOpenRender(t.workspaceId, live, 'abc')).toBe(false);
    expect(await ownerPool()`select 1 from assets where workspace_id = ${t.workspaceId} and kind = 'scene_render'`).toHaveLength(1);
  });

  it('refuses bodies that are not task callbacks', async () => {
    expect(await receiveProviderCallback('byteplus', newId(), { hello: 'world' })).toBeNull();
    expect(await receiveProviderCallback('byteplus', newId(), { id: 'x', status: 'exploded' })).toBeNull();
  });
});
