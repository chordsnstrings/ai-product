import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, withTenant } from '@arkiv/db';
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
