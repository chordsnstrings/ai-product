import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, sleep, type Micros } from '@arkiv/shared';
import {
  providers,
  ProviderError,
  type ContentPart,
  type ImageResult,
  type LlmJsonResult,
  type TtsResult,
  type VideoPoll,
} from '@arkiv/providers';
import type { z } from 'zod';
import type { TenantContext } from './context';
import { consumeAuthorization, creditBack, recordProviderCost } from './cost-governor';
import { hashRequest } from './idempotency';
import { actualCost, loadRates, priceLine, type CostLine } from './rates';

/**
 * Model Gateway (§33): provider-agnostic, and the ONLY path to a billable provider. Every call must present a
 * Cost Governor authorization token (§37). Each call is recorded in provider_jobs with model/prompt versions,
 * input hashes, latency and actual cost (§41 reproducibility).
 */

export interface Route {
  task: string;
  provider: string;
  model: string;
  promptVersion: string;
  circuitOpen: boolean;
}

export async function route(tx: Tx, task: string): Promise<Route> {
  const [r] = await tx`select task, provider, model, prompt_version, circuit_open from model_routes where task = ${task}`;
  if (!r) throw new DomainError('UNAVAILABLE', `No model route for ${task}`);
  return { task, provider: r.provider, model: r.model, promptVersion: r.prompt_version, circuitOpen: r.circuit_open };
}

interface CallMeta {
  ctx: TenantContext;
  token: string;
  task: string;
  subject?: { type: string; id: string } | null;
  inputRefs?: Record<string, unknown>;
}

async function begin(meta: CallMeta, line: CostLine, requestFingerprint: unknown) {
  return withTenant(meta.ctx.workspaceId, async (tx) => {
    const r = await route(tx, meta.task);
    if (r.circuitOpen) throw new DomainError('UNAVAILABLE', `Provider circuit open for ${meta.task}`);
    const rates = await loadRates(tx);
    const expected = priceLine(rates, line).micros;
    const auth = await consumeAuthorization(tx, meta.token, expected);
    const [job] = await tx`
      insert into provider_jobs (workspace_id, project_id, subject_type, subject_id, provider, task, model, prompt_version,
        request_hash, input_refs, status, authorization_id, estimate_micros)
      values (${meta.ctx.workspaceId}, ${auth.projectId}, ${meta.subject?.type ?? null}, ${meta.subject?.id ?? null},
        ${r.provider}, ${meta.task}, ${r.model}, ${r.promptVersion}, ${hashRequest(requestFingerprint)},
        ${tx.json((meta.inputRefs ?? {}) as never)}, 'dispatched', ${auth.authorizationId}, ${expected})
      returning id`;
    return { route: r, jobId: job!.id as string, authorizationId: auth.authorizationId, projectId: auth.projectId, expected };
  });
}

async function finish(
  meta: CallMeta,
  started: { jobId: string; authorizationId: string; projectId: string | null; expected: Micros },
  outcome: { ok: true; actualLine: CostLine; modelVersion?: string; providerRequestId?: string; output?: unknown; latencyMs: number; outputAssetId?: string } | { ok: false; error: string; latencyMs: number; billedLine?: CostLine },
) {
  await withTenant(meta.ctx.workspaceId, async (tx) => {
    const rates = await loadRates(tx);
    const line = outcome.ok ? outcome.actualLine : outcome.billedLine;
    const actual = line ? actualCost(rates, line) : 0;
    await creditBack(tx, started.authorizationId, started.expected - actual);
    await tx`
      update provider_jobs set status = ${outcome.ok ? 'succeeded' : 'failed'}, actual_micros = ${actual},
        latency_ms = ${outcome.latencyMs}, completed_at = now(),
        model_version_returned = ${outcome.ok ? (outcome.modelVersion ?? null) : null},
        provider_request_id = coalesce(provider_request_id, ${outcome.ok ? (outcome.providerRequestId ?? null) : null}),
        error = ${outcome.ok ? null : outcome.error},
        output = ${outcome.ok && outcome.output !== undefined ? tx.json(outcome.output as never) : null},
        output_asset_id = ${outcome.ok ? (outcome.outputAssetId ?? null) : null}
      where id = ${started.jobId}`;
    if (actual > 0) await recordProviderCost(tx, meta.ctx, started.jobId, actual, started.projectId, started.authorizationId);
  });
}

/** Provider-safe retry for transient failures — bounded and separate from creative QA retries (§39). */
async function withTransientRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof ProviderError) || !e.retryable || i === attempts - 1) throw e;
      await sleep(process.env.NODE_ENV === 'test' ? 5 : 500 * 2 ** i);
    }
  }
  throw last;
}

export interface LlmCall<T> extends CallMeta {
  system: string;
  content: ContentPart[];
  schema: z.ZodType<T>;
  mock: () => T;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}

export async function llmJson<T>(call: LlmCall<T>): Promise<LlmJsonResult<T> & { jobId: string; promptVersion: string }> {
  const approxIn = Math.ceil((call.system.length + call.content.reduce((n, c) => n + (c.type === 'image' ? 6000 : c.text.length), 0)) / 4);
  const maxTokens = call.maxTokens ?? 8000;
  const p = await providers();
  const started = await begin(call, { kind: 'llm', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: approxIn, outputTokens: maxTokens }, {
    task: call.task,
    content: call.content.map((c) => (c.type === 'image' ? { type: 'image', len: c.base64.length } : c)),
  });
  const t0 = Date.now();
  try {
    const res = await withTransientRetry(() =>
      p.llm.json({
        task: call.task,
        model: p.wireModel(started.route.model),
        system: call.system,
        content: call.content,
        schema: call.schema,
        mock: call.mock,
        effort: call.effort,
        maxTokens,
      }),
    );
    await finish(call, started, {
      ok: true,
      actualLine: { kind: 'llm', provider: 'anthropic', model: started.route.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cachedTokens: res.usage.cachedTokens },
      modelVersion: res.modelVersion,
      output: res.data,
      latencyMs: Date.now() - t0,
    });
    return { ...res, jobId: started.jobId, promptVersion: started.route.promptVersion };
  } catch (e) {
    await finish(call, started, { ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 });
    throw e;
  }
}

export interface ImageCall extends CallMeta {
  prompt: string;
  references: string[];
  width: number;
  height: number;
  mockLabel?: string;
}

export async function generateImage(call: ImageCall): Promise<ImageResult & { jobId: string; promptVersion: string }> {
  const p = await providers();
  const line: CostLine = { kind: 'image', provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 };
  const started = await begin(call, line, { prompt: call.prompt, refs: call.references.length });
  const t0 = Date.now();
  try {
    const r = await withTransientRetry(() =>
      p.image.generate({ model: p.wireModel(started.route.model), prompt: call.prompt, references: call.references, width: call.width, height: call.height, mockLabel: call.mockLabel }),
    );
    await finish(call, started, { ok: true, actualLine: line, modelVersion: r.modelVersion, providerRequestId: r.providerRequestId, latencyMs: Date.now() - t0 });
    return { ...r, jobId: started.jobId, promptVersion: started.route.promptVersion };
  } catch (e) {
    await finish(call, started, { ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 });
    throw e;
  }
}

export interface VideoCall extends CallMeta {
  prompt: string;
  references: string[];
  seconds: number;
  resolution: '720p' | '1080p';
  ratio: '9:16' | '4:5' | '1:1';
  mockLabel?: string;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Submit + poll to completion. Duplicate submissions are prevented by the caller's scene-version idempotency;
 * slow queues are waited on truthfully rather than resubmitted (§48 "very long provider queue").
 */
export async function generateVideo(call: VideoCall): Promise<{ bytes: Buffer; jobId: string; modelVersion?: string; promptVersion: string }> {
  const p = await providers();
  const line: CostLine = { kind: 'video', provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds: call.seconds, resolution: call.resolution, retryReserve: false };
  const started = await begin(call, line, { prompt: call.prompt, seconds: call.seconds, refs: call.references.length });
  const t0 = Date.now();
  let requestId: string | null = null;
  try {
    ({ providerRequestId: requestId } = await withTransientRetry(() =>
      p.video.submit({ model: p.wireModel(started.route.model), prompt: call.prompt, references: call.references, seconds: call.seconds, resolution: call.resolution, ratio: call.ratio, mockLabel: call.mockLabel }),
    ));
    await withTenant(call.ctx.workspaceId, (tx) => tx`update provider_jobs set provider_request_id = ${requestId} where id = ${started.jobId}`);
    const deadline = Date.now() + (call.timeoutMs ?? 15 * 60_000);
    let res: VideoPoll;
    for (;;) {
      res = await withTransientRetry(() => p.video.poll(requestId!));
      if (res.status === 'succeeded' || res.status === 'failed' || res.status === 'cancelled') break;
      if (Date.now() > deadline) {
        await p.video.cancel(requestId).catch(() => {});
        throw new ProviderError('byteplus', 'video generation timed out', true, 'timeout');
      }
      await sleep(call.pollMs ?? (process.env.NODE_ENV === 'test' ? 20 : 5000));
    }
    if (res.status !== 'succeeded' || !res.bytes) {
      // Provider failures are not billed to the customer; we record zero unless the provider bills partially.
      throw new ProviderError('byteplus', res.error ?? `video ${res.status}`, false, /moderation/i.test(res.error ?? '') ? 'moderation' : 'server');
    }
    await finish(call, started, {
      ok: true,
      actualLine: { ...line, seconds: res.outputSeconds ?? call.seconds } as CostLine,
      modelVersion: res.modelVersion,
      providerRequestId: requestId,
      latencyMs: Date.now() - t0,
    });
    return { bytes: res.bytes, jobId: started.jobId, modelVersion: res.modelVersion, promptVersion: started.route.promptVersion };
  } catch (e) {
    await finish(call, started, { ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 });
    throw e;
  }
}

export interface TtsCall extends CallMeta {
  text: string;
  voice: string;
}

/** Voice-over with provider fallback (MiniMax primary, BytePlus Seed Speech fallback). */
export async function synthesizeVoice(call: TtsCall): Promise<TtsResult & { jobId: string }> {
  const p = await providers();
  const line: CostLine = { kind: 'tts', provider: 'minimax', model: 'speech-2.8-hd', chars: call.text.length };
  const started = await begin(call, line, { text: call.text, voice: call.voice });
  const t0 = Date.now();
  try {
    let r: TtsResult;
    try {
      r = await withTransientRetry(() => p.tts.synthesize({ model: p.wireModel('speech-2.8-hd'), text: call.text, voice: call.voice }));
    } catch (primaryErr) {
      if (!(primaryErr instanceof ProviderError)) throw primaryErr;
      r = await p.ttsFallback.synthesize({ model: 'seed-speech-2-0', text: call.text, voice: call.voice });
    }
    await finish(call, started, { ok: true, actualLine: { ...line, chars: r.chars }, providerRequestId: r.providerRequestId, latencyMs: Date.now() - t0 });
    return { ...r, jobId: started.jobId };
  } catch (e) {
    await finish(call, started, { ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 });
    throw e;
  }
}
