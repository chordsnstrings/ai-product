import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { MockImage, MockLlm, MockVideo, ProviderError, setProviders, type TtsProvider, type TtsRequest } from '@arkiv/providers';
import { providerVoiceId, resetEnvCache } from '@arkiv/shared';
import { authorize } from './cost-governor';
import { synthesizeVoice } from './model-gateway';
import { ctxFor } from './testing';

/** Plan 06 Phase 3 #4: each TTS provider gets its own voice id for the logical voice (never MiniMax's id on Seed). */
beforeEach(truncateAll);
afterEach(() => {
  setProviders(undefined);
  delete process.env.TTS_VOICE_MAP;
  process.env.PROVIDERS_MODE = 'mock';
  resetEnvCache();
});
afterAll(closeAll);

function recorder(name: string, fail: boolean): TtsProvider & { calls: TtsRequest[] } {
  const calls: TtsRequest[] = [];
  return {
    name,
    calls,
    async synthesize(req) {
      calls.push(req);
      if (fail) throw new ProviderError(name, 'down', false, 'server');
      return { bytes: Buffer.from('ID3'), mime: 'audio/mpeg', chars: req.text.length, durationMs: 1000, model: req.model, providerRequestId: `${name}-1` };
    },
  };
}

async function tokenFor(workspaceId: string, userId: string) {
  const ctx = ctxFor(workspaceId, userId);
  const a = await withTenant(workspaceId, (tx) => authorize(tx, ctx, { purpose: 'repair', lines: [{ kind: 'tts', provider: 'minimax', model: 'speech-2.8-hd', chars: 5000 }], idempotencyKey: `tts:${Math.random()}` }));
  return { ctx, token: a.token };
}

describe('voice catalogue', () => {
  it('resolves provider-specific ids and sends the Seed speaker id to the fallback', async () => {
    process.env.TTS_VOICE_MAP = JSON.stringify({ warm_female: { 'byteplus-speech': 'seed_warm_en_v1' } });
    resetEnvCache();
    expect(providerVoiceId('warm_female', 'minimax')).toBe('English_Graceful_Lady');
    expect(providerVoiceId('warm_female', 'byteplus-speech')).toBe('seed_warm_en_v1');

    const primary = recorder('minimax', true);
    const fallback = recorder('byteplus-speech', false);
    setProviders({ llm: new MockLlm(), image: new MockImage(), video: new MockVideo(), tts: primary, ttsFallback: fallback, wireModel: (m) => m });
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    await synthesizeVoice({ ctx, token, task: 'tts.voiceover', text: 'Two drops, morning and night.', voice: 'warm_female' });
    expect(primary.calls.map((c) => c.voice)).toEqual(['English_Graceful_Lady']);
    expect(fallback.calls.map((c) => c.voice)).toEqual(['seed_warm_en_v1']);
  });

  it('never falls back with a voice the fallback provider does not have', async () => {
    process.env.PROVIDERS_MODE = 'live'; // no mock ids; providers themselves are injected below
    resetEnvCache();
    expect(providerVoiceId('warm_female', 'byteplus-speech')).toBeNull();
    const primary = recorder('minimax', true);
    const fallback = recorder('byteplus-speech', false);
    setProviders({ llm: new MockLlm(), image: new MockImage(), video: new MockVideo(), tts: primary, ttsFallback: fallback, wireModel: (m) => m });
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    await expect(synthesizeVoice({ ctx, token, task: 'tts.voiceover', text: 'Two drops.', voice: 'warm_female' })).rejects.toBeInstanceOf(ProviderError);
    expect(fallback.calls).toHaveLength(0);
  });
});

/** The approved fallback is a separate provider job on its own route, priced at its own rate (§34, §41: arch-23, prod-29). */
describe('voice-over fallback route', () => {
  async function routeOf(task: string) {
    const [r] = await ownerPool()`select provider, model from model_routes where task = ${task}`;
    return r as { provider: string; model: string };
  }
  async function charMillion(provider: string, model: string) {
    const [r] = await ownerPool()`select (rates->>'char_million')::bigint as c from provider_rate_tables where provider = ${provider} and model = ${model} and status = 'published' order by version desc limit 1`;
    return Number(r!.c);
  }

  it('a failed primary is closed unbilled and the fallback records its own provider, model and cost', async () => {
    const primary = recorder('minimax', true);
    const fallback = recorder('byteplus-speech', false);
    setProviders({ llm: new MockLlm(), image: new MockImage(), video: new MockVideo(), tts: primary, ttsFallback: fallback, wireModel: (m) => m });
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    const text = 'Two drops, morning and night.';
    const r = await synthesizeVoice({ ctx, token, task: 'tts.voiceover', text, voice: 'warm_female' });
    const fb = await routeOf('tts.voiceover_fallback');
    const pr = await routeOf('tts.voiceover');
    expect(fb.provider).not.toBe(pr.provider);
    expect(r).toMatchObject({ task: 'tts.voiceover_fallback', provider: fb.provider });
    expect(fallback.calls[0]!.model).toBe(fb.model); // the fallback's own wire model, not the primary's
    const jobs = await ownerPool()`select task, provider, model, status, actual_micros, provider_request_id from provider_jobs where workspace_id = ${t.workspaceId} order by created_at`;
    expect(jobs.map((j) => ({ task: j.task, provider: j.provider, model: j.model, status: j.status }))).toEqual([
      { task: 'tts.voiceover', provider: pr.provider, model: pr.model, status: 'failed' },
      { task: 'tts.voiceover_fallback', provider: fb.provider, model: fb.model, status: 'succeeded' },
    ]);
    expect(Number(jobs[0]!.actual_micros)).toBe(0);
    expect(Number(jobs[1]!.actual_micros)).toBe(Math.ceil((text.length * (await charMillion(fb.provider, fb.model))) / 1_000_000));
    expect(jobs[1]!.provider_request_id).toBe('byteplus-speech-1');
    const [cost] = await ownerPool()`select coalesce(sum(amount), 0)::bigint as n from ledger_entries where workspace_id = ${t.workspaceId} and type = 'PROVIDER_COST_RECORDED'`;
    expect(Number(cost!.n)).toBe(Number(jobs[1]!.actual_micros));
  });

  it('an open primary circuit goes straight to the approved fallback (plan 05 §10)', async () => {
    const primary = recorder('minimax', false);
    const fallback = recorder('byteplus-speech', false);
    setProviders({ llm: new MockLlm(), image: new MockImage(), video: new MockVideo(), tts: primary, ttsFallback: fallback, wireModel: (m) => m });
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    await ownerPool()`update model_routes set circuit_open = true where task = 'tts.voiceover'`;
    try {
      const r = await synthesizeVoice({ ctx, token, task: 'tts.voiceover', text: 'Tap to try it.', voice: 'warm_female' });
      expect(r.task).toBe('tts.voiceover_fallback');
      expect(primary.calls).toHaveLength(0);
      const jobs = await ownerPool()`select task from provider_jobs where workspace_id = ${t.workspaceId}`;
      expect(jobs.map((j) => j.task)).toEqual(['tts.voiceover_fallback']);
    } finally {
      await ownerPool()`update model_routes set circuit_open = false where task = 'tts.voiceover'`;
    }
  });

  it('without a configured fallback adapter the primary failure stands (never an alias of the primary)', async () => {
    const primary = recorder('minimax', true);
    setProviders({ llm: new MockLlm(), image: new MockImage(), video: new MockVideo(), tts: primary, ttsFallback: null, wireModel: (m) => m });
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    await expect(synthesizeVoice({ ctx, token, task: 'tts.voiceover', text: 'Hi.', voice: 'warm_female' })).rejects.toBeInstanceOf(ProviderError);
    expect(primary.calls).toHaveLength(1);
  });
});
