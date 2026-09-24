import { createHash } from 'node:crypto';
import { withSystem, withTenant, type Tx } from '@arkiv/db';
import { DomainError, providerVoiceId, sleep, SUBJECT_REF, type EventRefs, type EventSubjectType, type LogicalVoice, type Micros } from '@arkiv/shared';
import {
  providers,
  ProviderError,
  type BilledUnits,
  type ContentPart,
  type ImageResult,
  type LlmJsonResult,
  type ProviderSet,
  type RawMeta,
  type SegmentationProvider,
  type SegmentationResult,
  type TtsProvider,
  type TtsResult,
  type VideoPoll,
} from '@arkiv/providers';
import { logger } from '@arkiv/shared/log';
import type { z } from 'zod';
import { raiseAlert } from './alerts';
import { saveAsset } from './assets';
import type { TenantContext } from './context';
import { consumeAuthorization, creditBack, recordProviderCost } from './cost-governor';
import { emit } from './events';
import { isFlagOn } from './flags';
import { hashRequest } from './idempotency';
import { findPrompt } from './prompts';
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
  /**
   * The exact provider model version staff pinned for this route (§48 "pin where possible"): sent on the wire
   * instead of the configured id, so a silent provider upgrade can't change output. Applies to the stable arm and
   * to a canary that keeps the stable model; a canary on another model is never pinned to this one's version.
   */
  pinnedVersion: string | null;
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
  const [r] = await tx`select task, provider, model, prompt_version, circuit_open, canary, fallback_task, pinned_model_version from model_routes where task = ${task}`;
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
    pinnedVersion: !inCanary || !canary!.model || canary!.model === r.model ? ((r.pinned_model_version as string | null) || null) : null,
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

// ───────────── Provider registry (plan 05 §10) ─────────────

/** Per-provider settings staff manage in the console: status, concurrency limit, per-request timeout, retry policy. */
export interface ProviderPolicy {
  status: 'active' | 'degraded' | 'disabled';
  concurrencyLimit: number;
  timeoutMs: number;
  retryAttempts: number;
  retryBackoffMs: number;
}

/** Used for a provider the registry doesn't list (it always should). */
export const DEFAULT_PROVIDER_POLICY: ProviderPolicy = { status: 'active', concurrencyLimit: 8, timeoutMs: 180_000, retryAttempts: 3, retryBackoffMs: 500 };

export async function providerPolicy(tx: Tx, provider: string): Promise<ProviderPolicy> {
  const [p] = await tx`select status, concurrency_limit, timeout_ms, retry_attempts, retry_backoff_ms from providers where name = ${provider}`;
  if (!p) return DEFAULT_PROVIDER_POLICY;
  return { status: p.status, concurrencyLimit: Number(p.concurrency_limit), timeoutMs: Number(p.timeout_ms), retryAttempts: Number(p.retry_attempts), retryBackoffMs: Number(p.retry_backoff_ms) };
}

/**
 * In-flight provider requests per provider in this process, capped at the registry's concurrency limit: a call
 * over the limit waits for a slot (it already holds its Cost Governor reservation, so nothing is double-spent).
 */
const inflight = new Map<string, { active: number; waiters: (() => void)[] }>();
async function acquireSlot(provider: string, limit: number): Promise<() => void> {
  let s = inflight.get(provider);
  if (!s) inflight.set(provider, (s = { active: 0, waiters: [] }));
  while (s.active >= Math.max(1, limit)) await new Promise<void>((resolve) => s!.waiters.push(resolve));
  s.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s!.active--;
    s!.waiters.shift()?.();
  };
}

/** Current in-flight count for a provider in this process (tests, health). */
export const providerInflight = (provider: string) => inflight.get(provider)?.active ?? 0;

/** One provider request, abandoned as a retryable timeout after the registry's per-request timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, provider: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError(provider, `request timed out after ${ms}ms`, true, 'timeout')), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** A provider request under the registry's policy: per-request timeout and bounded transient retries. */
const request = <T>(started: { route: Route; policy: ProviderPolicy; billed?: BilledUnits[] }, fn: () => Promise<T>) =>
  withTransientRetry(
    async () => {
      try {
        return await withTimeout(fn(), started.policy.timeoutMs, started.route.provider);
      } catch (e) {
        // An attempt that failed after the provider billed it (partial provider billing) is booked on the job,
        // whether or not a retry then succeeds.
        noteBilled(started, e);
        throw e;
      }
    },
    started.policy.retryAttempts,
    started.policy.retryBackoffMs,
  );

/** Record what a failed attempt was billed for (see BilledUnits), once per error. */
function noteBilled(started: { billed?: BilledUnits[] }, e: unknown) {
  if (!(e instanceof ProviderError) || !e.billed || noted.has(e)) return;
  noted.add(e);
  (started.billed ??= []).push(e.billed);
}
const noted = new WeakSet<object>();

/** A billed failure's units as a cost line of the call's own kind, route and model (null when they don't apply). */
export function billedLine(line: CostLine, u: BilledUnits): CostLine | null {
  if (line.kind === 'llm' && u.tokens) return { ...line, inputTokens: u.tokens.input, outputTokens: u.tokens.output, cachedTokens: 0 };
  if (line.kind === 'video' && u.seconds) return { ...line, seconds: u.seconds, retryReserve: false };
  if (line.kind === 'tts' && u.chars) return { ...line, chars: u.chars };
  if (line.kind === 'image' && u.images) return { ...line, images: u.images };
  return null;
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
  /**
   * Evaluate a candidate instead of the live route (plan 05 §11 eval runs: template version × model): the
   * call is priced, sent and recorded with this model and prompt version. Internal eval runs only.
   */
  candidate?: { model?: string; promptVersion?: string };
  /**
   * The prompt template family this call expects (prompts.ts). The route's prompt_version must name a
   * registered version of it; that version's text is the system prompt sent. (Not `prompt`: image and video
   * calls carry their generation prompt under that name.)
   */
  template?: string;
}

/** A route's prompt_version resolved to its registered template text; unknown versions are refused (§41). */
export function routedPrompt(r: Pick<Route, 'task' | 'promptVersion'>, family: string): string {
  const t = findPrompt(r.promptVersion);
  if (!t || t.name !== family) {
    throw new DomainError('UNAVAILABLE', 'Our AI partner is unavailable right now. Your work is saved.', { promptVersion: r.promptVersion, task: r.task, expected: family });
  }
  return t.text;
}

/** The wire model a route is called with: its pinned provider version when staff pinned one, else the configured id. */
const wireModelFor = (r: Route, p: ProviderSet) => r.pinnedVersion ?? p.wireModel(r.model);

/** Refs to a provider job's subject (scene, SKU, variant…), so its events join the object they worked on (§36). */
function subjectRefs(subject: CallMeta['subject']): EventRefs {
  const key = subject ? SUBJECT_REF[subject.type as EventSubjectType] : undefined;
  return key && subject ? { [key]: subject.id } : {};
}

interface Started {
  /** Units billed by failed attempts of this call (partial provider billing), booked when the job closes. */
  billed?: BilledUnits[];
  route: Route;
  /** The routed template's text, when the call names a template family. */
  system: string | null;
  policy: ProviderPolicy;
  line: CostLine;
  jobId: string;
  authorizationId: string;
  projectId: string | null;
  expected: Micros;
}

/**
 * Open a provider call: resolve the route (and its canary arm), refuse open circuits and killed providers
 * (plan 05 §20 kill.provider.*, and kill.renders for renders), price the call with the routed model, debit the
 * authorization and record the job (PROVIDER_JOB_CREATED, standard §37).
 */
async function begin(meta: CallMeta, line: (r: Route) => CostLine, requestFingerprint: unknown): Promise<Started> {
  return withTenant(meta.ctx.workspaceId, async (tx) => {
    const live = await route(tx, meta.task, meta.ctx.workspaceId);
    const r: Route = meta.candidate
      ? { ...live, model: meta.candidate.model || live.model, promptVersion: meta.candidate.promptVersion || live.promptVersion, arm: 'stable', pinnedVersion: meta.candidate.model && meta.candidate.model !== live.model ? null : live.pinnedVersion }
      : live;
    const system = meta.template ? routedPrompt(r, meta.template) : null;
    // Customer-safe messages: the route and provider travel in `details` (and the job log), never in the text.
    const partner = partnerFor(meta.task).replace(/^./, (c) => c.toUpperCase());
    if (r.circuitOpen) throw new DomainError('UNAVAILABLE', `${partner} is busy right now. Your work is saved.`, { circuitOpen: meta.task });
    const policy = await providerPolicy(tx, r.provider);
    if (policy.status === 'disabled') throw new DomainError('UNAVAILABLE', `${partner} is unavailable right now. Your work is saved.`, { providerDisabled: r.provider, task: meta.task });
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
        request_hash, input_refs, status, authorization_id, estimate_micros, arm, raw_meta)
      values (${meta.ctx.workspaceId}, ${auth.projectId}, ${meta.subject?.type ?? null}, ${meta.subject?.id ?? null},
        ${r.provider}, ${meta.task}, ${r.model}, ${r.promptVersion}, ${hashRequest(requestFingerprint)},
        ${tx.json({ ...(meta.inputRefs ?? {}), units: unitsOf(costLine) } as never)}, 'dispatched', ${auth.authorizationId}, ${expected}, ${r.arm},
        ${tx.json({ planned: costLine } as never)})
      returning id`;
    const jobId = job!.id as string;
    await emit(
      tx,
      meta.ctx,
      'PROVIDER_JOB_CREATED',
      { type: 'provider_job', id: jobId },
      { task: meta.task, provider: r.provider, model: r.model, promptVersion: r.promptVersion, arm: r.arm, estimateMicros: expected },
      { authorizationId: auth.authorizationId, projectId: auth.projectId, ...subjectRefs(meta.subject) },
    );
    return { route: r, system, policy, line: costLine, jobId, authorizationId: auth.authorizationId, projectId: auth.projectId, expected };
  });
}

/** The billable units of a call (resolution, seconds, images, chars, tokens), kept on the job for COGS breakdowns (plan 05 §8). */
function unitsOf(line: CostLine): Record<string, unknown> {
  const { provider: _p, model: _m, ...units } = line as CostLine & { provider: string; model: string };
  return units;
}

const gatewayLog = logger('gateway');

/** What kind of failure closed a job (ProviderError kind, DomainError code), for events and reconciliation. */
export function errorKind(e: unknown): string {
  if (e instanceof ProviderError) return e.kind;
  if (e instanceof DomainError) return e.code.toLowerCase();
  return 'error';
}

type Outcome =
  | { ok: true; actualLine?: CostLine; actualMicros?: Micros; modelVersion?: string; providerRequestId?: string | null; output?: unknown; latencyMs: number | null; outputAssetId?: string; rawMeta?: RawMeta; wireModel?: string }
  | { ok: false; error: string; errorKind: string; latencyMs: number | null; billedLine?: CostLine; actualMicros?: Micros; providerRequestId?: string | null; rawMeta?: RawMeta; wireModel?: string };

/**
 * Close a provider job exactly once (standard §39: duplicate callbacks and late finishes are expected): the job
 * moves from `dispatched` to succeeded/failed, the unused estimate goes back to the authorization, the actual
 * cost is booked, raw response metadata is kept, and PROVIDER_JOB_SUCCEEDED / PROVIDER_JOB_FAILED is emitted.
 * A second close of the same job (the reconciler got there first, or the other way round) changes nothing.
 */
async function finish(
  meta: Pick<CallMeta, 'ctx' | 'task' | 'subject'>,
  started: Pick<Started, 'jobId' | 'authorizationId' | 'projectId' | 'expected'> & Partial<Pick<Started, 'line' | 'billed'>> & { route?: Pick<Route, 'task' | 'provider' | 'pinnedVersion'> },
  outcome: Outcome,
): Promise<boolean> {
  const closed = await closeJob(meta, started, outcome);
  if (closed && outcome.ok && started.route && versionDrift(started.route.pinnedVersion, outcome.modelVersion)) {
    await raiseVersionDrift(started.route, outcome.modelVersion!, started.jobId).catch((e) => gatewayLog.warn('version drift alert failed', { task: meta.task, error: (e as Error).message }));
  }
  return closed;
}

/**
 * Version drift (plan 05 §10; standard §48 "pin where possible"): the provider answered a pinned route with a
 * different model/version than the one pinned. Mock adapters echo the version they were asked for, tagged "-mock".
 */
export function versionDrift(pinned: string | null | undefined, returned: string | null | undefined): boolean {
  if (!pinned || !returned) return false;
  return returned !== pinned && returned !== `${pinned}-mock`;
}

/** One open Pulse alert per route (a repeat is a no-op until staff resolve it); raised as the system. */
async function raiseVersionDrift(r: Pick<Route, 'task' | 'provider' | 'pinnedVersion'>, returned: string, jobId: string) {
  gatewayLog.warn('provider version drift', { task: r.task, pinned: r.pinnedVersion, returned, providerJobId: jobId });
  await withSystem((tx) =>
    raiseAlert(tx, {
      kind: 'version_drift',
      severity: 'risk',
      subject: { type: 'route', id: r.task },
      message: `${r.provider} answered ${r.task} with ${returned}, not the pinned ${r.pinnedVersion}. Check output quality, then re-pin or roll back.`,
      details: { provider: r.provider, pinned: r.pinnedVersion, returned, providerJobId: jobId },
    }),
  );
}

async function closeJob(
  meta: Pick<CallMeta, 'ctx' | 'task' | 'subject'>,
  started: Pick<Started, 'jobId' | 'authorizationId' | 'projectId' | 'expected'> & Partial<Pick<Started, 'line' | 'billed'>>,
  outcome: Outcome,
): Promise<boolean> {
  return withTenant(meta.ctx.workspaceId, async (tx) => {
    const rates = await loadRates(tx);
    const line = outcome.ok ? outcome.actualLine : outcome.billedLine;
    // What failed attempts were billed for (a refusal after generating, a render rejected after it rendered) is
    // real spend: recorded as provider cost even though the call failed and the customer is not charged (§37).
    const billed = started.line ? (started.billed ?? []).map((u) => billedLine(started.line!, u)).filter((l): l is CostLine => !!l) : [];
    const billedMicros = billed.reduce((s, l) => s + actualCost(rates, l), 0);
    const actual = (outcome.actualMicros ?? (line ? actualCost(rates, line) : 0)) + billedMicros;
    // The failure class is kept on the job: the circuit breaker counts outage-class failures per route (plan 05 §10).
    const extra = { ...(outcome.wireModel ? { wireModel: outcome.wireModel } : {}), ...(outcome.ok ? {} : { errorKind: outcome.errorKind }), ...(billed.length ? { billedOnFailure: billed.map(unitsOf) } : {}) };
    const raw = outcome.rawMeta || Object.keys(extra).length ? { ...(outcome.rawMeta ?? {}), ...extra } : null;
    const [closed] = await tx`
      update provider_jobs set status = ${outcome.ok ? 'succeeded' : 'failed'}, actual_micros = ${actual},
        latency_ms = ${outcome.latencyMs}, completed_at = now(),
        model_version_returned = ${outcome.ok ? (outcome.modelVersion ?? null) : null},
        provider_request_id = coalesce(provider_request_id, ${outcome.providerRequestId ?? null}),
        error = ${outcome.ok ? null : outcome.error},
        output = ${outcome.ok && outcome.output !== undefined ? tx.json(outcome.output as never) : null},
        output_asset_id = ${outcome.ok ? (outcome.outputAssetId ?? null) : null},
        raw_meta = coalesce(raw_meta, '{}'::jsonb) || coalesce(${raw ? tx.json(raw as never) : null}::jsonb, '{}'::jsonb)
      where id = ${started.jobId} and workspace_id = ${meta.ctx.workspaceId} and status = 'dispatched'
      returning provider_request_id`;
    if (!closed) return false;
    await creditBack(tx, started.authorizationId, started.expected - actual);
    if (actual > 0) await recordProviderCost(tx, meta.ctx, started.jobId, actual, started.projectId, started.authorizationId);
    const refs = { authorizationId: started.authorizationId, projectId: started.projectId, ...subjectRefs(meta.subject) };
    const requestId = (closed.provider_request_id as string | null) ?? null;
    if (outcome.ok) {
      await emit(tx, meta.ctx, 'PROVIDER_JOB_SUCCEEDED', { type: 'provider_job', id: started.jobId }, { task: meta.task, latencyMs: outcome.latencyMs, actualMicros: actual, providerRequestId: requestId, modelVersion: outcome.modelVersion ?? null }, refs);
    } else {
      await emit(tx, meta.ctx, 'PROVIDER_JOB_FAILED', { type: 'provider_job', id: started.jobId }, { task: meta.task, latencyMs: outcome.latencyMs, actualMicros: actual, providerRequestId: requestId, errorKind: outcome.errorKind }, refs);
    }
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
    else gatewayLog.warn('provider call failed', { ...entry, errorKind: outcome.errorKind, error: outcome.error.slice(0, 300) });
    return true;
  });
}

/**
 * Provider-safe retry for transient failures — bounded and separate from creative QA retries (§39). Attempts and
 * the (exponential) backoff come from the provider registry.
 */
async function withTransientRetry<T>(fn: () => Promise<T>, attempts = DEFAULT_PROVIDER_POLICY.retryAttempts, backoffMs = DEFAULT_PROVIDER_POLICY.retryBackoffMs): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof ProviderError) || !e.retryable || i === attempts - 1) throw e;
      await sleep(process.env.NODE_ENV === 'test' ? 5 : backoffMs * 2 ** i);
    }
  }
  throw last;
}

/**
 * Outage-class failures an approved fallback route may answer (§44 "optional approved fallback provider"; plan
 * 05 §10 "when open, the Production Planner uses the approved fallback or queues"): an open circuit, a provider
 * switched off, or a provider error that isn't about the content (after the gateway's own transient retries).
 * Content problems (moderation, refusal, invalid input) and the global renders switch never fail over.
 */
export function fallbackEligible(e: unknown): boolean {
  if (e instanceof ProviderError) return e.kind === 'server' || e.kind === 'timeout' || e.kind === 'rate_limit' || e.kind === 'auth';
  if (e instanceof DomainError && e.code === 'UNAVAILABLE') {
    const d = e.details as { circuitOpen?: string; killSwitch?: string; providerDisabled?: string } | undefined;
    return !!d?.circuitOpen || !!d?.providerDisabled || (!!d?.killSwitch && d.killSwitch !== 'renders');
  }
  return false;
}

/**
 * Run a call on its route, and — when the route fails outage-class and staff approved a fallback route that the
 * same adapter can serve — once more on the fallback route: its own provider job, rate line, wire model and
 * prompt version (§41). A fallback that can't take the call (its own circuit is open, or the authorization can't
 * fund its price) leaves the primary's failure as the answer, so the caller pauses/queues as before.
 */
async function withRouteFallback<T>(meta: CallMeta, adapter: { name: string }, call: (m: CallMeta) => Promise<T>): Promise<T> {
  try {
    return await call(meta);
  } catch (primaryErr) {
    if (!fallbackEligible(primaryErr)) throw primaryErr;
    const fb = await withTenant(meta.ctx.workspaceId, async (tx) => {
      const r = await route(tx, meta.task, meta.ctx.workspaceId);
      return r.fallbackTask ? route(tx, r.fallbackTask, meta.ctx.workspaceId) : null;
    });
    if (!fb || fb.provider !== adapter.name) throw primaryErr;
    gatewayLog.warn('provider call failing over', { workspaceId: meta.ctx.workspaceId, task: meta.task, fallbackTask: fb.task, errorKind: errorKind(primaryErr) });
    try {
      return await call({ ...meta, task: fb.task });
    } catch (fallbackErr) {
      if (fallbackErr instanceof DomainError && (fallbackErr.code === 'UNAVAILABLE' || fallbackErr.code === 'FORBIDDEN')) throw primaryErr;
      throw fallbackErr;
    }
  }
}

export interface LlmCall<T> extends CallMeta {
  /** A fixed system prompt; routed calls name their template family in `template` instead. */
  system?: string;
  content: ContentPart[];
  schema: z.ZodType<T>;
  mock: () => T;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}

export async function llmJson<T>(call: LlmCall<T>): Promise<LlmJsonResult<T> & { jobId: string; promptVersion: string; task: string }> {
  const p = await providers();
  // An eval of a candidate measures that candidate: it never fails over to another route.
  if (call.candidate) return llmOnce(call, p);
  return withRouteFallback(call, p.llm, (m) => llmOnce({ ...call, task: m.task }, p));
}

async function llmOnce<T>(call: LlmCall<T>, p: ProviderSet): Promise<LlmJsonResult<T> & { jobId: string; promptVersion: string; task: string }> {
  if (!call.system && !call.template) throw new Error('llmJson needs a system prompt or a prompt template family');
  const contentLen = call.content.reduce((n, c) => n + (c.type === 'image' ? 6000 : c.text.length), 0);
  // Priced with the template the route actually sends (its version may be older or newer than the latest).
  const approxIn = (r: Route) => Math.ceil(((call.system?.length ?? routedPrompt(r, call.template!).length) + contentLen) / 4);
  const maxTokens = call.maxTokens ?? 8000;
  const started = await begin(call, (r) => lineFor(r, { kind: 'llm', inputTokens: approxIn(r), outputTokens: maxTokens }), {
    task: call.task,
    content: call.content.map((c) => (c.type === 'image' ? { type: 'image', len: c.base64.length } : c)),
  });
  const wire = wireModelFor(started.route, p);
  // Waiting for a concurrency slot is not provider latency.
  const release = await acquireSlot(started.route.provider, started.policy.concurrencyLimit);
  const t0 = Date.now();
  try {
    const res = await request(started, () =>
      p.llm.json({
        task: call.task,
        model: wire,
        system: started.system ?? call.system!,
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
      providerRequestId: res.providerRequestId ?? null,
      rawMeta: res.rawMeta,
      wireModel: wire,
      output: res.data,
      latencyMs: Date.now() - t0,
    });
    return { ...res, jobId: started.jobId, promptVersion: started.route.promptVersion, task: call.task };
  } catch (e) {
    await finish(call, started, { ok: false, error: (e as Error).message, errorKind: errorKind(e), latencyMs: Date.now() - t0, wireModel: wire });
    throw e;
  } finally {
    release();
  }
}

export interface ImageCall extends CallMeta {
  prompt: string;
  references: string[];
  width: number;
  height: number;
  mockLabel?: string;
}

export async function generateImage(call: ImageCall): Promise<ImageResult & { jobId: string; promptVersion: string; task: string }> {
  const p = await providers();
  return withRouteFallback(call, p.image, (m) => imageOnce({ ...call, task: m.task }, p));
}

async function imageOnce(call: ImageCall, p: ProviderSet): Promise<ImageResult & { jobId: string; promptVersion: string; task: string }> {
  const started = await begin(call, (rt) => lineFor(rt, { kind: 'image', images: 1 }), { prompt: call.prompt, refs: call.references.length });
  const wire = wireModelFor(started.route, p);
  // Waiting for a concurrency slot is not provider latency.
  const release = await acquireSlot(started.route.provider, started.policy.concurrencyLimit);
  const t0 = Date.now();
  try {
    const r = await request(started, () => p.image.generate({ model: wire, prompt: call.prompt, references: call.references, width: call.width, height: call.height, mockLabel: call.mockLabel }));
    await finish(call, started, { ok: true, actualLine: started.line, modelVersion: r.modelVersion, providerRequestId: r.providerRequestId, rawMeta: r.rawMeta, wireModel: wire, latencyMs: Date.now() - t0 });
    return { ...r, jobId: started.jobId, promptVersion: started.route.promptVersion, task: call.task };
  } catch (e) {
    await finish(call, started, { ok: false, error: (e as Error).message, errorKind: errorKind(e), latencyMs: Date.now() - t0, wireModel: wire });
    throw e;
  } finally {
    release();
  }
}

export interface CutoutCall extends CallMeta {
  /** The product photo to cut out. */
  image: Buffer;
}

/** The background-removal task (plan 06 Phase 1 #6): priced as one image on its route. */
export const CUTOUT_TASK = 'vision.cutout';

/**
 * Background removal for the product cut-out, through the gateway like any billable call: its own route, Cost
 * Governor debit, provider job and usage events. Without a configured adapter nothing is dispatched or charged
 * (UNAVAILABLE), and the caller keeps its keyed or framed cut-out.
 */
export async function removeBackground(call: CutoutCall): Promise<SegmentationResult & { jobId: string; promptVersion: string; task: string }> {
  const p = await providers();
  const adapter = p.segmentation;
  if (!adapter) throw new DomainError('UNAVAILABLE', 'Background removal isn’t available right now.', { notConfigured: 'segmentation' });
  return withRouteFallback(call, adapter, (m) => cutoutOnce({ ...call, task: m.task }, p, adapter));
}

async function cutoutOnce(call: CutoutCall, p: ProviderSet, adapter: SegmentationProvider): Promise<SegmentationResult & { jobId: string; promptVersion: string; task: string }> {
  const started = await begin(call, (rt) => lineFor(rt, { kind: 'image', images: 1 }), { image: createHash('sha256').update(call.image).digest('hex') });
  const wire = wireModelFor(started.route, p);
  // Waiting for a concurrency slot is not provider latency.
  const release = await acquireSlot(started.route.provider, started.policy.concurrencyLimit);
  const t0 = Date.now();
  try {
    const r = await request(started, () => adapter.removeBackground({ model: wire, image: call.image }));
    await finish(call, started, {
      ok: true,
      actualLine: started.line,
      modelVersion: r.modelVersion,
      providerRequestId: r.providerRequestId,
      rawMeta: { ...(r.rawMeta ?? {}), aligned: r.aligned, coverage: Math.round(r.coverage * 1000) / 1000, technique: r.technique },
      wireModel: wire,
      latencyMs: Date.now() - t0,
    });
    return { ...r, jobId: started.jobId, promptVersion: started.route.promptVersion, task: call.task };
  } catch (e) {
    await finish(call, started, { ok: false, error: (e as Error).message, errorKind: errorKind(e), latencyMs: Date.now() - t0, wireModel: wire });
    throw e;
  } finally {
    release();
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
 * slow queues are waited on truthfully rather than resubmitted (§48 "very long provider queue"). A job whose
 * worker dies while waiting stays `dispatched` with its provider request id, and the reconciler collects it.
 * A heartbeat that throws (the run lost its lease, or the production was cancelled) cancels the provider task.
 */
export async function generateVideo(call: VideoCall): Promise<{ bytes: Buffer; jobId: string; modelVersion?: string; promptVersion: string; task: string }> {
  const p = await providers();
  return withRouteFallback(call, p.video, (m) => videoOnce({ ...call, task: m.task }, p));
}

async function videoOnce(call: VideoCall, p: ProviderSet): Promise<{ bytes: Buffer; jobId: string; modelVersion?: string; promptVersion: string; task: string }> {
  const started = await begin(call, (rt) => lineFor(rt, { kind: 'video', seconds: call.seconds, resolution: call.resolution, retryReserve: false }), { prompt: call.prompt, seconds: call.seconds, refs: call.references.length });
  const line = started.line;
  const wire = wireModelFor(started.route, p);
  // Waiting for a concurrency slot is not provider latency.
  const release = await acquireSlot(started.route.provider, started.policy.concurrencyLimit);
  const t0 = Date.now();
  let requestId: string | null = null;
  let lastMeta: RawMeta | undefined;
  try {
    ({ providerRequestId: requestId } = await request(started, () =>
      p.video.submit({ model: wire, prompt: call.prompt, references: call.references, seconds: call.seconds, resolution: call.resolution, ratio: call.ratio, mockLabel: call.mockLabel }),
    ));
    await withTenant(call.ctx.workspaceId, (tx) => tx`update provider_jobs set provider_request_id = ${requestId} where id = ${started.jobId}`);
    const deadline = Date.now() + (call.timeoutMs ?? 15 * 60_000);
    let res: VideoPoll;
    let beat = Date.now();
    for (;;) {
      if (call.heartbeat && Date.now() - beat > 60_000) {
        beat = Date.now();
        try {
          await call.heartbeat();
        } catch (e) {
          // The run stopped (lease lost or production cancelled): don't leave the provider rendering for nobody.
          await p.video.cancel(requestId).catch(() => {});
          throw e;
        }
      }
      res = await request(started, () => p.video.poll(requestId!));
      lastMeta = res.rawMeta ?? lastMeta;
      if (res.status === 'succeeded' || res.status === 'failed' || res.status === 'cancelled') break;
      if (Date.now() > deadline) {
        await p.video.cancel(requestId).catch(() => {});
        throw new ProviderError(started.route.provider, 'video generation timed out', true, 'timeout');
      }
      await sleep(call.pollMs ?? (process.env.NODE_ENV === 'test' ? 20 : 5000));
    }
    if (res.status !== 'succeeded' || !res.bytes) {
      // Provider failures are not billed to the customer; seconds the provider generated (and bills) before the
      // task failed are booked as our cost.
      const err = new ProviderError(started.route.provider, res.error ?? `video ${res.status}`, false, /moderation/i.test(res.error ?? '') ? 'moderation' : 'server', res.outputSeconds ? { seconds: res.outputSeconds } : undefined);
      noteBilled(started, err);
      throw err;
    }
    await finish(call, started, {
      ok: true,
      actualLine: { ...line, seconds: res.outputSeconds ?? call.seconds } as CostLine,
      modelVersion: res.modelVersion,
      providerRequestId: requestId,
      rawMeta: res.rawMeta,
      wireModel: wire,
      latencyMs: Date.now() - t0,
    });
    return { bytes: res.bytes, jobId: started.jobId, modelVersion: res.modelVersion, promptVersion: started.route.promptVersion, task: call.task };
  } catch (e) {
    await finish(call, started, { ok: false, error: (e as Error).message, errorKind: errorKind(e), latencyMs: Date.now() - t0, providerRequestId: requestId, rawMeta: lastMeta, wireModel: wire });
    throw e;
  } finally {
    release();
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
  const wire = wireModelFor(started.route, p);
  // Waiting for a concurrency slot is not provider latency.
  const release = await acquireSlot(started.route.provider, started.policy.concurrencyLimit);
  const t0 = Date.now();
  try {
    const r = await request(started, () => adapter.synthesize({ model: wire, text: call.text, voice, speed: call.speed }));
    await finish(meta, started, { ok: true, actualLine: lineFor(started.route, { kind: 'tts', chars: r.chars }), modelVersion: r.model, providerRequestId: r.providerRequestId, rawMeta: r.rawMeta, wireModel: wire, latencyMs: Date.now() - t0 });
    return { ...r, jobId: started.jobId, task, provider: started.route.provider };
  } catch (e) {
    await finish(meta, started, { ok: false, error: (e as Error).message, errorKind: errorKind(e), latencyMs: Date.now() - t0, wireModel: wire });
    throw e;
  } finally {
    release();
  }
}

const noVoice = (e: unknown) => e instanceof DomainError && !!(e.details as { noVoice?: string } | undefined)?.noVoice;

/** Failures the approved voice fallback may answer: the primary provider erred, is switched off, circuit-broken or voiceless. */
const voiceFallbackEligible = (e: unknown) => e instanceof ProviderError || (e instanceof DomainError && e.code === 'UNAVAILABLE');

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
    if (!primary.fallbackTask || !voiceFallbackEligible(primaryErr)) throw primaryErr;
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

// ───────────── Reconciliation of provider jobs left open (standard §39) ─────────────

/** A render still dispatched after this long has lost its worker; the reconciler polls the provider for it. */
export const RECONCILE_RENDER_AFTER_MINUTES = 20;
/** A synchronous call (LLM, image, voice) still dispatched after this long was abandoned mid-call. */
export const RECONCILE_CALL_AFTER_MINUTES = 30;
/** A render the provider still hasn't finished after this long is cancelled and closed. */
export const RECONCILE_RENDER_GIVE_UP_HOURS = 6;

export interface ReconcileResult {
  succeeded: number;
  failed: number;
  pending: number;
}

/**
 * Close provider jobs a crashed worker left `dispatched` (standard §39 "Provider request IDs, callbacks and raw
 * provider response metadata are persisted"; "every output is copied to owned object storage immediately"):
 *  - a render with a provider request id is polled; a finished one is copied into our storage (assets, linked
 *    by output_asset_id and tagged with its scene and input hash so a resumed production can use it), booked
 *    at its actual cost and closed; a failed one is closed unbilled; one still running is left, unless it has run
 *    past RECONCILE_RENDER_GIVE_UP_HOURS, when it is cancelled;
 *  - a render that never got a request id was never acknowledged: closed unbilled;
 *  - an abandoned synchronous call can't be polled: it is closed as failed and booked at its estimate, because
 *    the provider may well have billed it (COGS is never under-counted).
 * Runs as the system role across tenants; every write is scoped to the job's own workspace.
 */
export async function reconcileProviderJobs(opts: { limit?: number } = {}): Promise<ReconcileResult> {
  const out: ReconcileResult = { succeeded: 0, failed: 0, pending: 0 };
  const rows = await withSystem((tx) => tx`
    select id, workspace_id, task, provider, subject_type, subject_id, project_id, authorization_id, estimate_micros,
           provider_request_id, input_refs, raw_meta, created_at, created_at < now() - make_interval(hours => ${RECONCILE_RENDER_GIVE_UP_HOURS}) as expired
    from provider_jobs
    where status = 'dispatched'
      and ((task like 'video.%' and created_at < now() - make_interval(mins => ${RECONCILE_RENDER_AFTER_MINUTES}))
        or (task not like 'video.%' and created_at < now() - make_interval(mins => ${RECONCILE_CALL_AFTER_MINUTES})))
    order by created_at limit ${opts.limit ?? 100}`);
  if (!rows.length) return out;
  const p = await providers();
  for (const j of rows) {
    const ctx: TenantContext = { workspaceId: j.workspace_id as string, workspaceState: 'ACTIVE_PAID', role: 'OWNER', actor: { kind: 'system', id: 'provider-reconcile' }, requestId: 'provider-reconcile' };
    const meta = { ctx, task: j.task as string, subject: j.subject_type ? { type: j.subject_type as string, id: j.subject_id as string } : null };
    const started = { jobId: j.id as string, authorizationId: j.authorization_id as string, projectId: (j.project_id as string | null) ?? null, expected: Number(j.estimate_micros) };
    const refs = (j.input_refs ?? {}) as { skuId?: string; inputHash?: string };
    const planned = ((j.raw_meta ?? {}) as { planned?: CostLine }).planned;
    const latencyMs = null;
    if (!isRenderTask(j.task as string)) {
      if (await finish(meta, started, { ok: false, error: 'abandoned: the worker was lost during the call', errorKind: 'abandoned', latencyMs, actualMicros: started.expected })) out.failed++;
      continue;
    }
    if (!j.provider_request_id) {
      if (await finish(meta, started, { ok: false, error: 'never acknowledged by the provider (worker lost before submit returned)', errorKind: 'abandoned', latencyMs })) out.failed++;
      continue;
    }
    let res: VideoPoll | null = null;
    try {
      res = await p.video.poll(j.provider_request_id as string);
    } catch {
      out.pending++; // provider unreachable right now: try again next sweep
      continue;
    }
    if (res.status === 'succeeded' && res.bytes) {
      const bytes = res.bytes;
      const asset = await withTenant(ctx.workspaceId, (tx) =>
        saveAsset(tx, ctx.workspaceId, {
          bytes,
          mime: 'video/mp4',
          kind: 'scene_render',
          skuId: refs.skuId ?? null,
          source: 'generated',
          lineage: { sceneId: j.subject_type === 'scene' ? j.subject_id : null, providerJobId: j.id, inputHash: refs.inputHash ?? null, reconciled: true, model: res!.modelVersion ?? null },
        }),
      );
      const line = planned && planned.kind === 'video' ? ({ ...planned, seconds: res.outputSeconds ?? planned.seconds } as CostLine) : undefined;
      const ok = await finish(meta, started, { ok: true, actualLine: line, actualMicros: line ? undefined : started.expected, modelVersion: res.modelVersion, rawMeta: res.rawMeta, outputAssetId: asset.id, latencyMs });
      if (ok) out.succeeded++;
      continue;
    }
    if (res.status === 'failed' || res.status === 'cancelled') {
      // Seconds the provider generated before the task failed are billed: booked like a live call would.
      const billed = planned && planned.kind === 'video' && res.outputSeconds ? { line: planned, billed: [{ seconds: res.outputSeconds }] } : {};
      if (await finish(meta, { ...started, ...billed }, { ok: false, error: res.error ?? `video ${res.status}`, errorKind: /moderation/i.test(res.error ?? '') ? 'moderation' : 'server', latencyMs, rawMeta: res.rawMeta })) out.failed++;
      continue;
    }
    if (j.expired) {
      await p.video.cancel(j.provider_request_id as string).catch(() => {});
      if (await finish(meta, started, { ok: false, error: `still ${res.status} after ${RECONCILE_RENDER_GIVE_UP_HOURS}h; cancelled`, errorKind: 'timeout', latencyMs, rawMeta: res.rawMeta })) out.failed++;
      continue;
    }
    out.pending++;
  }
  return out;
}
