import { createHash } from 'node:crypto';
import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, providerVoiceId, sleep, type LogicalVoice, type Micros } from '@arkiv/shared';
import {
  providers,
  ProviderError,
  type ContentPart,
  type ImageResult,
  type LlmJsonResult,
  type TtsProvider,
  type TtsResult,
  type VideoPoll,
} from '@arkiv/providers';
import { logger } from '@arkiv/shared/log';
import type { z } from 'zod';
import type { TenantContext } from './context';
import { consumeAuthorization, creditBack, recordProviderCost } from './cost-governor';
import { isFlagOn } from './flags';
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
  /** Which rollout arm served this call (plan 05 §11 canary rollout). */
  arm: 'stable' | 'canary';
  /** Staff-approved fallback route used when this one fails or its circuit is open (§44, plan 05 §10). */
  fallbackTask: string | null;
}

/** A route's canary arm, written by the console's route.update (plan 05 §11: 5% → 25% → 100%). */
export interface Canary {
  model?: string;
  promptVersion?: string;
  pct: number;
  startedAt?: string;
}

/** Deterministic 0–99 bucket per (task, workspace): a workspace stays on one arm for the whole rollout step. */
export function canaryBucket(task: string, workspaceId: string): number {
  return parseInt(createHash('sha256').update(`canary:${task}:${workspaceId}`).digest('hex').slice(0, 8), 16) % 100;
}

export async function route(tx: Tx, task: string, workspaceId?: string | null): Promise<Route> {
  const [r] = await tx`select task, provider, model, prompt_version, circuit_open, canary, fallback_task from model_routes where task = ${task}`;
  if (!r) throw new DomainError('UNAVAILABLE', `No model route for ${task}`);
  const canary = r.canary as Canary | null;
  const inCanary = !!canary && !!workspaceId && Number(canary.pct) > 0 && canaryBucket(task, workspaceId) < Number(canary.pct);
  return {
    task,
    provider: r.provider,
    model: inCanary ? (canary!.model ?? r.model) : r.model,
    promptVersion: inCanary ? (canary!.promptVersion ?? r.prompt_version) : r.prompt_version,
    circuitOpen: r.circuit_open,
    arm: inCanary ? 'canary' : 'stable',
    fallbackTask: (r.fallback_task as string | null) ?? null,
  };
}

/** The billable units of one gateway call, before its route decides which provider/model prices them. */
export type TaskUnits =
  | { kind: 'llm'; inputTokens: number; outputTokens: number; cachedTokens?: number }
  | { kind: 'image'; images: number }
  | { kind: 'video'; seconds: number; resolution: '720p' | '1080p'; retryReserve?: boolean }
  | { kind: 'tts'; chars: number };

/** A cost line for units served by a route: priced with the model the route resolved to, never a fixed one. */
export function lineFor(r: Pick<Route, 'provider' | 'model'>, units: TaskUnits): CostLine {
  return { ...units, provider: r.provider, model: r.model } as CostLine;
}

/**
 * Cost lines for a planned set of gateway calls, each priced with the provider/model its task routes to for this
 * workspace (canary arm included) — the same route the gateway debits when the call is made (§6, §37).
 * Re-routing a task therefore re-prices every estimate that uses it.
 */
export async function routedLines(tx: Tx, workspaceId: string | null, items: ({ task: string } & TaskUnits)[]): Promise<CostLine[]> {
  const cache = new Map<string, Route>();
  const out: CostLine[] = [];
  for (const { task, ...units } of items) {
    if (!cache.has(task)) cache.set(task, await route(tx, task, workspaceId));
    out.push(lineFor(cache.get(task)!, units as TaskUnits));
  }
  return out;
}

/**
 * How customer copy names the service behind a task (standard §8: no provider names, job IDs or token counts
 * in the interface): "our video partner", "our voice partner"…
 */
export function partnerFor(task: string): string {
  const family = task.split('.')[0];
  if (family === 'video') return 'our video partner';
  if (family === 'image') return 'our image partner';
  if (family === 'tts') return 'our voice partner';
  if (['creative_director', 'qa', 'extract', 'genome', 'customer_language', 'vision'].includes(family ?? '')) return 'our AI partner';
  return 'a production partner';
}

/** Tasks that dispatch a render; `kill.renders` stops them at the gateway as well as at authorization. */
const isRenderTask = (task: string) => task.startsWith('video.');

interface CallMeta {
  ctx: TenantContext;
  token: string;
  task: string;
  subject?: { type: string; id: string } | null;
  inputRefs?: Record<string, unknown>;
}

/**
 * Open a provider call: resolve the route (and its canary arm), refuse open circuits and killed providers
 * (plan 05 §20 kill.provider.*, and kill.renders for renders), price the call with the routed model and debit the
 * authorization.
 */
async function begin(meta: CallMeta, line: (r: Route) => CostLine, requestFingerprint: unknown) {
  return withTenant(meta.ctx.workspaceId, async (tx) => {
    const r = await route(tx, meta.task, meta.ctx.workspaceId);
    // Customer-safe messages: the route and provider travel in `details` (and the job log), never in the text.
    const partner = partnerFor(meta.task).replace(/^./, (c) => c.toUpperCase());
    if (r.circuitOpen) throw new DomainError('UNAVAILABLE', `${partner} is busy right now. Your work is saved.`, { circuitOpen: meta.task });
    if (await isFlagOn(tx, `kill.provider.${r.provider}`, meta.ctx.workspaceId)) {
      throw new DomainError('UNAVAILABLE', `${partner} is paused for maintenance. Your work is saved.`, { killSwitch: r.provider, task: meta.task });
    }
    if (isRenderTask(meta.task) && (await isFlagOn(tx, 'kill.renders', meta.ctx.workspaceId))) {
      throw new DomainError('UNAVAILABLE', 'Production is paused for maintenance. Your place is held.', { killSwitch: 'renders' });
    }
    const costLine = line(r);
    const rates = await loadRates(tx);
    const expected = priceLine(rates, costLine).micros;
    const auth = await consumeAuthorization(tx, meta.token, expected);
    const [job] = await tx`
      insert into provider_jobs (workspace_id, project_id, subject_type, subject_id, provider, task, model, prompt_version,
        request_hash, input_refs, status, authorization_id, estimate_micros, arm)
      values (${meta.ctx.workspaceId}, ${auth.projectId}, ${meta.subject?.type ?? null}, ${meta.subject?.id ?? null},
        ${r.provider}, ${meta.task}, ${r.model}, ${r.promptVersion}, ${hashRequest(requestFingerprint)},
        ${tx.json((meta.inputRefs ?? {}) as never)}, 'dispatched', ${auth.authorizationId}, ${expected}, ${r.arm})
      returning id`;
    return { route: r, line: costLine, jobId: job!.id as string, authorizationId: auth.authorizationId, projectId: auth.projectId, expected };
  });
}

const gatewayLog = logger('gateway');

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
    // One line per provider call, joined to its workspace, project, subject and request (§34, §41).
    const entry = {
      workspaceId: meta.ctx.workspaceId,
      projectId: started.projectId,
      providerJobId: started.jobId,
      task: meta.task,
      subject: meta.subject ?? null,
      latencyMs: outcome.latencyMs,
      estimateMicros: started.expected,
      actualMicros: actual,
    };
    if (outcome.ok) gatewayLog.info('provider call succeeded', entry);
    else gatewayLog.warn('provider call failed', { ...entry, error: outcome.error.slice(0, 300) });
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
  const started = await begin(call, (r) => lineFor(r, { kind: 'llm', inputTokens: approxIn, outputTokens: maxTokens }), {
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
      actualLine: lineFor(started.route, { kind: 'llm', inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cachedTokens: res.usage.cachedTokens }),
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
  const started = await begin(call, (rt) => lineFor(rt, { kind: 'image', images: 1 }), { prompt: call.prompt, refs: call.references.length });
  const t0 = Date.now();
  try {
    const r = await withTransientRetry(() =>
      p.image.generate({ model: p.wireModel(started.route.model), prompt: call.prompt, references: call.references, width: call.width, height: call.height, mockLabel: call.mockLabel }),
    );
    await finish(call, started, { ok: true, actualLine: started.line, modelVersion: r.modelVersion, providerRequestId: r.providerRequestId, latencyMs: Date.now() - t0 });
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
  /** Called while waiting on the provider (at most once a minute) so the caller can keep its run lease alive. */
  heartbeat?: () => Promise<void>;
}

/**
 * Submit + poll to completion. Duplicate submissions are prevented by the caller's scene-version idempotency;
 * slow queues are waited on truthfully rather than resubmitted (§48 "very long provider queue").
 */
export async function generateVideo(call: VideoCall): Promise<{ bytes: Buffer; jobId: string; modelVersion?: string; promptVersion: string }> {
  const p = await providers();
  const started = await begin(call, (rt) => lineFor(rt, { kind: 'video', seconds: call.seconds, resolution: call.resolution, retryReserve: false }), { prompt: call.prompt, seconds: call.seconds, refs: call.references.length });
  const line = started.line;
  const t0 = Date.now();
  let requestId: string | null = null;
  try {
    ({ providerRequestId: requestId } = await withTransientRetry(() =>
      p.video.submit({ model: p.wireModel(started.route.model), prompt: call.prompt, references: call.references, seconds: call.seconds, resolution: call.resolution, ratio: call.ratio, mockLabel: call.mockLabel }),
    ));
    await withTenant(call.ctx.workspaceId, (tx) => tx`update provider_jobs set provider_request_id = ${requestId} where id = ${started.jobId}`);
    const deadline = Date.now() + (call.timeoutMs ?? 15 * 60_000);
    let res: VideoPoll;
    let beat = Date.now();
    for (;;) {
      if (call.heartbeat && Date.now() - beat > 60_000) {
        beat = Date.now();
        await call.heartbeat();
      }
      res = await withTransientRetry(() => p.video.poll(requestId!));
      if (res.status === 'succeeded' || res.status === 'failed' || res.status === 'cancelled') break;
      if (Date.now() > deadline) {
        await p.video.cancel(requestId).catch(() => {});
        throw new ProviderError(started.route.provider, 'video generation timed out', true, 'timeout');
      }
      await sleep(call.pollMs ?? (process.env.NODE_ENV === 'test' ? 20 : 5000));
    }
    if (res.status !== 'succeeded' || !res.bytes) {
      // Provider failures are not billed to the customer; we record zero unless the provider bills partially.
      throw new ProviderError(started.route.provider, res.error ?? `video ${res.status}`, false, /moderation/i.test(res.error ?? '') ? 'moderation' : 'server');
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
  /** Logical voice from the catalogue (e.g. warm_female); resolved per provider below. */
  voice: LogicalVoice;
  /** Speaking rate (1 = natural); used to fit a line to its scene. */
  speed?: number;
}

export type VoiceResult = TtsResult & { jobId: string; task: string; provider: string };

/** One TTS call on one route: its own provider job, rate line (the route's model) and wire model. */
async function ttsCall(call: TtsCall, task: string, adapter: TtsProvider | null): Promise<VoiceResult> {
  const voice = adapter ? providerVoiceId(call.voice, adapter.name) : null;
  if (!adapter || !voice) throw new DomainError('UNAVAILABLE', `No ${task} voice configured for ${call.voice}`, { noVoice: task });
  const p = await providers();
  const meta: CallMeta = { ...call, task };
  const started = await begin(meta, (rt) => lineFor(rt, { kind: 'tts', chars: call.text.length }), { text: call.text, voice: call.voice, speed: call.speed ?? 1 });
  const t0 = Date.now();
  try {
    const r = await withTransientRetry(() => adapter.synthesize({ model: p.wireModel(started.route.model), text: call.text, voice, speed: call.speed }));
    await finish(meta, started, { ok: true, actualLine: lineFor(started.route, { kind: 'tts', chars: r.chars }), modelVersion: r.model, providerRequestId: r.providerRequestId, latencyMs: Date.now() - t0 });
    return { ...r, jobId: started.jobId, task, provider: started.route.provider };
  } catch (e) {
    await finish(meta, started, { ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 });
    throw e;
  }
}

const noVoice = (e: unknown) => e instanceof DomainError && !!(e.details as { noVoice?: string } | undefined)?.noVoice;

/** Failures the approved fallback may answer: the primary provider erred, is switched off, circuit-broken or voiceless. */
const fallbackEligible = (e: unknown) => e instanceof ProviderError || (e instanceof DomainError && e.code === 'UNAVAILABLE');

/**
 * Voice-over with the route's approved fallback (MiniMax primary → BytePlus Seed Speech, §34 Voice). Each route is
 * a separate provider job priced at its own rate: a failed primary is closed as failed (not billed) and the
 * fallback records its own provider, model and actual cost (§41). The fallback also serves when the primary's
 * circuit is open or its provider is switched off (plan 05 §10). The logical voice is resolved per provider; a
 * provider with no approved id for it is never used.
 */
export async function synthesizeVoice(call: TtsCall): Promise<VoiceResult> {
  const p = await providers();
  const primary = await withTenant(call.ctx.workspaceId, (tx) => route(tx, call.task, call.ctx.workspaceId));
  try {
    return await ttsCall(call, call.task, p.tts);
  } catch (primaryErr) {
    if (!primary.fallbackTask || !fallbackEligible(primaryErr)) throw primaryErr;
    try {
      return await ttsCall(call, primary.fallbackTask, p.ttsFallback);
    } catch (fallbackErr) {
      // A fallback that could not even be tried (no voice for it) leaves the primary's failure as the answer.
      if (!noVoice(fallbackErr)) throw fallbackErr;
      if (noVoice(primaryErr)) throw new DomainError('UNAVAILABLE', `No provider voice configured for ${call.voice}`);
      throw primaryErr;
    }
  }
}
