import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { MockImage, MockLlm, MockTts, MockVideo, ProviderError, setProviders, type LlmJsonRequest, type LlmJsonResult, type LlmProvider } from '@arkiv/providers';
import { newId } from '@arkiv/shared';
import { authorize } from './cost-governor';
import { llmJson, providerInflight, synthesizeVoice } from './model-gateway';
import { ctxFor } from './testing';

/** The provider registry is reference data (kept across truncation): restore the seeded settings. */
async function restore() {
  await ownerPool()`update providers set status = 'active', concurrency_limit = case name when 'anthropic' then 16 else 8 end,
                      timeout_ms = case name when 'anthropic' then 600000 when 'minimax' then 60000 else 180000 end, retry_attempts = 3, retry_backoff_ms = 500`;
  setProviders(undefined);
}
beforeEach(async () => {
  await truncateAll();
  await restore();
});
afterEach(restore);
afterAll(closeAll);

/** An LLM adapter whose behaviour each test scripts. */
class ScriptedLlm implements LlmProvider {
  readonly name = 'anthropic';
  calls = 0;
  active = 0;
  maxActive = 0;
  constructor(private readonly step: (n: number) => Promise<void>) {}
  async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
    const n = ++this.calls;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await this.step(n);
      return new MockLlm().json(req);
    } finally {
      this.active--;
    }
  }
}
const use = (llm: LlmProvider) => setProviders({ llm, image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });

async function call(workspaceId: string, userId: string) {
  const ctx = ctxFor(workspaceId, userId);
  const auth = await withTenant(workspaceId, (tx) =>
    authorize(tx, ctx, { purpose: 'storyboard', lines: [{ kind: 'llm', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 20_000, outputTokens: 8_000 }], idempotencyKey: `g:${newId()}` }),
  );
  return llmJson({ ctx, token: auth.token, task: 'extract.product_facts', system: 's', content: [{ type: 'text', text: 'hello' }], schema: z.object({ a: z.string() }), mock: () => ({ a: 'ok' }) });
}

describe('provider registry in the Model Gateway (plan 05 §10)', () => {
  it('refuses a disabled provider before any spend; voice-over falls back to the approved provider', async () => {
    const t = await makeTenant();
    await ownerPool()`update providers set status = 'disabled' where name = 'anthropic'`;
    await expect(call(t.workspaceId, t.userId)).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { providerDisabled: 'anthropic' } });
    expect(await ownerPool()`select 1 from provider_jobs`).toHaveLength(0);

    await ownerPool()`update providers set status = 'disabled' where name = 'minimax'`;
    const ctx = ctxFor(t.workspaceId, t.userId);
    const auth = await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'taste', lines: [{ kind: 'tts', provider: 'minimax', model: 'speech-2.8-hd', chars: 2000 }], idempotencyKey: `tts:${newId()}` }));
    const v = await synthesizeVoice({ ctx, token: auth.token, task: 'tts.voiceover', subject: null, text: 'Soft skin in one step.', voice: 'warm_female' });
    expect(v.provider).toBe('byteplus');
  });

  it('retries transient errors as many times as the registry says', async () => {
    const t = await makeTenant();
    const flaky = new ScriptedLlm(async (n) => {
      if (n < 3) throw new ProviderError('anthropic', 'overloaded', true, 'rate_limit');
    });
    use(flaky);
    await ownerPool()`update providers set retry_attempts = 2 where name = 'anthropic'`;
    await expect(call(t.workspaceId, t.userId)).rejects.toThrow(/overloaded/);
    expect(flaky.calls).toBe(2);
    await ownerPool()`update providers set retry_attempts = 4 where name = 'anthropic'`;
    flaky.calls = 0;
    expect((await call(t.workspaceId, t.userId)).data).toEqual({ a: 'ok' });
    expect(flaky.calls).toBe(3);
  });

  it('abandons a request after the registry timeout (a retryable timeout, recorded as a failed job)', async () => {
    const t = await makeTenant();
    use(new ScriptedLlm(() => new Promise((r) => setTimeout(r, 5_000))));
    await ownerPool()`update providers set timeout_ms = 1000, retry_attempts = 1 where name = 'anthropic'`;
    const t0 = Date.now();
    await expect(call(t.workspaceId, t.userId)).rejects.toMatchObject({ kind: 'timeout', retryable: true });
    expect(Date.now() - t0).toBeLessThan(4_000);
    const [job] = await ownerPool()`select status, error from provider_jobs`;
    expect(job).toMatchObject({ status: 'failed' });
    expect(job!.error).toMatch(/timed out after 1000ms/);
  });

  it('caps in-flight requests per provider at the concurrency limit, and records the call units', async () => {
    const t = await makeTenant();
    const slow = new ScriptedLlm(() => new Promise((r) => setTimeout(r, 150)));
    use(slow);
    await ownerPool()`update providers set concurrency_limit = 1 where name = 'anthropic'`;
    await Promise.all([call(t.workspaceId, t.userId), call(t.workspaceId, t.userId), call(t.workspaceId, t.userId)]);
    expect(slow.calls).toBe(3);
    expect(slow.maxActive).toBe(1);
    expect(providerInflight('anthropic')).toBe(0);
    await ownerPool()`update providers set concurrency_limit = 3 where name = 'anthropic'`;
    slow.maxActive = 0;
    await Promise.all([call(t.workspaceId, t.userId), call(t.workspaceId, t.userId), call(t.workspaceId, t.userId)]);
    expect(slow.maxActive).toBe(3);
    const [job] = await ownerPool()`select input_refs from provider_jobs limit 1`;
    expect(job!.input_refs).toMatchObject({ units: { kind: 'llm', outputTokens: 8000 } });
  });
});
