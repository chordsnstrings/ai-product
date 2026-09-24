import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTenant, type Tx } from '@arkiv/db';
import { COST_LIMITS, DEFAULT_VOICE, DomainError, platformsFor, type LogicalVoice, type Micros, type Platform, type ProjectState } from '@arkiv/shared';
import { captionCues, composeAd, layoutVoice, probe, scheduleVoice, withTempDir, type Aspect, type Cue, type SceneInput, type VoiceClip } from '@arkiv/media';
import { ProviderError } from '@arkiv/providers';
import { assetBytes, saveAsset, verifyAssetIntegrity } from './assets';
import { assertCan } from './authz';
import { brandBrainFor } from './brand';
import type { LineMapping } from './compliance';
import { CLEAN_PHOTO_TIP, exactProductFrame, productImagery } from './composite';
import { diffCompositions, type CompositionManifest, type ManifestScene, type VoiceSegment } from './composition';
import type { TenantContext } from './context';
import { authorize, holdAuthorization, reissueToken, settle, type Purpose } from './cost-governor';
import { allowedClaimTexts } from './creative-director';
import { emit } from './events';
import { isFlagOn } from './flags';
import { append, type LedgerUnit } from './ledger';
import { generateImage, generateVideo, lineFor, route, synthesizeVoice, type Route } from './model-gateway';
import { enqueue, priorityFor, Queues } from './outbox';
import { planSteps, step } from './progress';
import { getProject, IN_PRODUCTION, isTerminal, PATH, transition } from './projects';
import { qaClaims, qaExperimentIntegrity, qaExport, qaScene, summarize, type CheckResult } from './qa';
import { estimate, loadRates, priceLine, type CostLine, type RateTable } from './rates';

export const PRODUCTION_STEPS = [
  { key: 'prepare', label: 'Preparing your product' },
  { key: 'scenes', label: 'Creating scenes' },
  { key: 'accuracy', label: 'Checking product accuracy' },
  { key: 'claims', label: 'Checking claims' },
  { key: 'voice', label: 'Adding voice and captions' },
  { key: 'platforms', label: 'Preparing platform versions' },
];

export const ASPECTS: Aspect[] = ['9x16', '4x5', '1x1'];
/** Seedance models reject very short durations; generate ≥ 5s and trim in composition (§48 per-model duration). */
const MIN_GEN_SECONDS = 5;
/** Generated environment plates for strict product composites (§23). */
export const PLATE_TASK = 'image.environment_plate';
/** A voice-over may run this far past the end of the ad before the export is refused (never cut mid-word). */
const VO_OVERFLOW_TOLERANCE_MS = 250;

type SceneRow = Record<string, unknown> & { id: string; production_mode: string; duration_ms: number; purpose: string };

const PLATFORM_LABEL: Record<Platform, string> = { TIKTOK: 'TikTok', INSTAGRAM_REELS: 'Instagram Reels', FACEBOOK_FEED: 'Facebook/Instagram feed' };

/**
 * Claims QA for every platform the given exports publish to; a line must be approved on each of them. The
 * per-line Claim ID mapping is kept (data.mapping) so it can be written to the scenes and shown in review.
 */
export async function claimsQaForExports(tx: Tx, skuId: string, lines: string[], aspects: readonly Aspect[], opts: { names?: (string | null | undefined)[] } = {}): Promise<CheckResult> {
  const results: { platform: Platform; check: CheckResult }[] = [];
  for (const platform of platformsFor(aspects)) results.push({ platform, check: qaClaims(lines, await allowedClaimTexts(tx, skuId, { platforms: [platform] }), opts) });
  const failing = results.filter((r) => !r.check.pass);
  if (!failing.length) return { ...results[0]!.check, detail: `${results[0]!.check.detail} · ${results.map((r) => PLATFORM_LABEL[r.platform]).join(', ')}` };
  return {
    check: 'claims',
    pass: false,
    hard: true,
    detail: failing.map((f) => `${PLATFORM_LABEL[f.platform]}: ${f.check.detail}`).join(' | '),
    data: { platforms: failing.map((f) => ({ platform: f.platform, ...(f.check.data as object) })), mapping: (results[0]!.check.data as { mapping?: LineMapping[] })?.mapping ?? [] },
  };
}

/** Claim IDs a scene's own lines use, from a claims-QA mapping (§24: a scene stores the claims it uses). */
export function sceneClaimIds(lines: (string | null | undefined)[], mapping: readonly LineMapping[]): string[] {
  const own = new Set(lines.filter((l): l is string => !!l && !!l.trim()).map((l) => l.trim()));
  return [...new Set(mapping.filter((m) => own.has(m.line) && m.status === 'claim' && m.claimId).map((m) => m.claimId!))];
}

/** Generated seconds for one render of a scene (whole seconds, at least the model minimum). */
export const genSeconds = (durationMs: number) => Math.max(MIN_GEN_SECONDS, Math.ceil(durationMs / 1000));

type RouteModel = Pick<Route, 'provider' | 'model'>;

/** The routes a production is priced on — the same routes (canary arm included) the gateway dispatches on. */
export interface ProductionRoutes {
  video: RouteModel;
  /** The voice-over route and its approved fallback: the voice line covers whichever is dearer. */
  tts: RouteModel[];
  qa: RouteModel;
  plate: RouteModel | null;
}

export async function productionRoutes(tx: Tx, workspaceId: string | null): Promise<ProductionRoutes> {
  const tts = await route(tx, 'tts.voiceover', workspaceId);
  const fallback = tts.fallbackTask ? await route(tx, tts.fallbackTask, workspaceId) : null;
  const [plate] = await tx`select 1 from model_routes where task = ${PLATE_TASK}`;
  return {
    video: await route(tx, 'video.scene', workspaceId),
    tts: fallback ? [tts, fallback] : [tts],
    qa: await route(tx, 'qa.fidelity', workspaceId),
    plate: plate ? await route(tx, PLATE_TASK, workspaceId) : null,
  };
}

export interface ProductionPlan {
  lines: CostLine[];
  /** Generative scenes this run renders (a scene with a reusable accepted render is not rendered or priced again). */
  generative: string[];
  /** Generated seconds of one render attempt, per generative scene. */
  seconds: Record<string, number>;
  /**
   * QA repair reserve, in generated seconds of the video route (§6: 25% of raw video cost; topped up to one repair
   * of the longest scene when the plan still fits its class ceiling). Free repairs draw on it; a repair it cannot
   * fund switches the scene to the exact-product composite instead (§25 "QA failure again").
   */
  reserveSeconds: number;
}

/**
 * A voice line priced at the dearer of the voice route and its approved fallback, since either may serve the
 * call (§34 Voice). A route without a published rate can't be used, so it doesn't shape the line.
 */
export function voiceLine(routes: Pick<ProductionRoutes, 'tts'>, rates: Map<string, RateTable>, chars: number): CostLine {
  const priced = routes.tts.flatMap((r) => {
    const line = lineFor(r, { kind: 'tts', chars });
    try {
      return [{ line, micros: priceLine(rates, line).micros }];
    } catch {
      return [];
    }
  });
  return priced.sort((a, b) => b.micros - a.micros)[0]?.line ?? lineFor(routes.tts[0]!, { kind: 'tts', chars });
}

/**
 * Production Planner (§23, §37): chooses the medium scene by scene and prices the plan on the live rate table
 * and the routed models before any spend.
 *  - one render per generative scene, carrying the Cost Governor's 25% QA retry reserve (§6) — never a full
 *    second render per scene;
 *  - the pooled reserve is topped up to one repair of the longest scene when it would otherwise not cover any
 *    repair (§25 "one automatic repair covered by reserve"), unless that would breach the class ceiling (§5);
 *  - voice at the dearer of the voice route and its approved fallback; QA inspections for first attempts, funded
 *    repairs, exact-product fallbacks and environment plates; the media pipeline.
 */
export function planProduction(
  scenes: SceneRow[],
  voiceChars: number,
  routes: ProductionRoutes,
  rates: Map<string, RateTable>,
  opts: { reuse?: ReadonlySet<string>; plates?: number; ceilingMicros?: Micros | null } = {},
): ProductionPlan {
  const generative = scenes.filter((s) => s.production_mode === 'GENERATIVE_INTERACTION' && !opts.reuse?.has(s.id)).map((s) => s.id);
  const seconds = Object.fromEntries(generative.map((id) => [id, genSeconds(scenes.find((x) => x.id === id)!.duration_ms)])) as Record<string, number>;
  const secs = Object.values(seconds);
  const renders: CostLine[] = generative.map((id) => lineFor(routes.video, { kind: 'video', seconds: seconds[id]!, resolution: '720p' }));
  const pooled = secs.reduce((a, b) => a + b, 0) * COST_LIMITS.RETRY_RESERVE_FRACTION;
  const longest = secs.length ? Math.max(...secs) : 0;
  const shortest = secs.length ? Math.min(...secs) : 0;
  const plates = routes.plate ? (opts.plates ?? 0) : 0;
  const voice = (): CostLine[] => (voiceChars ? [voiceLine(routes, rates, voiceChars)] : []);
  const tail = (reserve: number): CostLine[] => {
    const repairs = generative.length ? Math.min(generative.length, Math.floor((reserve + 1e-6) / shortest)) : 0;
    const inspections = 2 * generative.length + repairs + plates + 1;
    return [
      ...voice(),
      lineFor(routes.qa, { kind: 'llm', inputTokens: 5_000 * inspections, outputTokens: 800 * inspections }),
      ...(plates && routes.plate ? [lineFor(routes.plate, { kind: 'image', images: plates })] : []),
      { kind: 'media', outputs: 1 },
    ];
  };
  if (longest > pooled + 1e-6) {
    const topUp = lineFor(routes.video, { kind: 'video', seconds: longest - pooled, resolution: '720p', retryReserve: false });
    const lines = [...renders, topUp, ...tail(longest)];
    if (opts.ceilingMicros == null || estimate(rates, lines).totalMicros <= opts.ceilingMicros) return { lines, generative, seconds, reserveSeconds: longest };
  }
  return { lines: [...renders, ...tail(pooled)], generative, seconds, reserveSeconds: pooled };
}

const CEILING_PURPOSES: readonly Purpose[] = ['taste', 'standalone', 'creative_test'];

/**
 * Hash of what a scene's render depends on (§24, §35): the frame it is generated from, the visual plan, the
 * product behaviour and the generated length. An accepted render with the same hash is reused by a retry.
 */
export function renderInputHash(s: SceneRow): string {
  return createHash('sha256')
    .update(JSON.stringify({ frame: s.current_version_id ?? null, plan: s.visual_plan ?? null, behavior: s.product_behavior ?? null, seconds: genSeconds(s.duration_ms) }))
    .digest('hex');
}

type VersionRow = { id: string; scene_id: string; version: number; kind: string; asset_id: string | null; status: string; technique: string | null; input_hash: string | null; lineage: Record<string, unknown> };

/** Accepted renders a run may reuse instead of rendering again: a locked scene keeps its render; otherwise the inputs must be unchanged. */
function reusableRenders(scenes: SceneRow[], versions: VersionRow[]): Map<string, VersionRow> {
  const out = new Map<string, VersionRow>();
  for (const s of scenes) {
    if (s.production_mode !== 'GENERATIVE_INTERACTION') continue;
    const hash = renderInputHash(s);
    // Renders recorded before inputs were hashed (null) were made for the approved — and since frozen — storyboard.
    const acc = versions.filter((v) => v.scene_id === s.id && v.kind === 'render' && v.status === 'accepted' && v.asset_id && (s.locked || v.input_hash == null || v.input_hash === hash)).at(-1);
    if (acc) out.set(s.id, acc);
  }
  return out;
}

/** What a production retry would reserve at today's rates and routes (plan 05 §12), reusing accepted renders. */
export async function productionEstimate(tx: Tx, workspaceId: string, projectId: string): Promise<Micros | null> {
  const [p] = await tx`select storyboard_id, sku_id, entitlement_unit from projects where id = ${projectId} and workspace_id = ${workspaceId}`;
  if (!p?.storyboard_id) return null;
  const scenes = (await tx`select * from scenes where storyboard_id = ${p.storyboard_id} and workspace_id = ${workspaceId} order by position`) as unknown as SceneRow[];
  const versions = (await tx`select id, scene_id, version, kind, asset_id, status, technique, input_hash, lineage from scene_versions
                             where workspace_id = ${workspaceId} and scene_id = any(${scenes.map((s) => s.id)}::uuid[]) order by version`) as unknown as VersionRow[];
  const routes = await productionRoutes(tx, workspaceId);
  const rates = await loadRates(tx);
  const voChars = scenes.reduce((n, s) => n + ((s.spoken_line as string | null)?.trim().length ?? 0), 0);
  const plan = planProduction(scenes, voChars, routes, rates, { reuse: new Set(reusableRenders(scenes, versions).keys()), ceilingMicros: COST_LIMITS.CREATIVE_TEST_CEILING });
  return estimate(rates, plan.lines).totalMicros;
}

/**
 * Storyboard approval = the expensive-production boundary (§13). For Taste/Standalone this is called by the
 * payment webhook; for subscribers by the merchant's approval. Idempotent.
 */
export async function approveForProduction(tx: Tx, ctx: TenantContext, projectId: string, unit: Exclude<LedgerUnit, 'usd_micros'>) {
  if (ctx.actor.kind === 'user') assertCan(ctx, 'storyboard.approve');
  const p = await getProject(tx, projectId);
  if (!p.storyboard_id) throw new DomainError('CONFLICT', 'Storyboard is not ready yet.');
  if (['STORYBOARD_APPROVED', 'RENDER_RESERVED', 'RENDERING', 'QA_RUNNING', 'COMPOSING', 'PLATFORM_VARIANTS', 'FINAL_QA', 'COMPLETE'].includes(p.state as string)) return { replayed: true };
  const [sb] = await tx`select status from storyboards where id = ${p.storyboard_id}`;
  if (sb?.status !== 'ready') throw new DomainError('CONFLICT', 'Storyboard is not ready yet.');
  await tx`update storyboards set status = 'approved', approved_at = now(), approved_by = ${ctx.actor.kind + ':' + ctx.actor.id} where id = ${p.storyboard_id}`;
  await transition(tx, ctx, projectId, 'STORYBOARD_APPROVED', { patch: { entitlement_unit: unit, kind: unit === 'creative_test' ? 'creative_test' : unit } });
  await planSteps(tx, ctx.workspaceId, projectId, PRODUCTION_STEPS);
  await enqueue(tx, ctx.workspaceId, Queues.produceProject, { projectId, actor: ctx.actor }, { singletonKey: `produce:${projectId}`, priority: priorityFor(ctx, 'production') });
  return { replayed: false };
}

/** A run holds a per-project lease, renewed as it works; a crashed run's lease lapses so another run can resume. */
export const PRODUCTION_LEASE_MINUTES = 5;
/** A production stuck without a live run is failed (entitlement returned) before its 180-minute reservation TTL. */
export const STUCK_DEADLINE_MINUTES = 150;
/** How long a provider outage may pause a production before we stop and return the entitlement. */
export const OUTAGE_MAX_HOURS = 6;
const AUTH_TTL_MINUTES = 180;
const leaseResource = (projectId: string) => `produce:${projectId}`;

/** Customer-facing copy (failure_reason is shown in the funnel); internal causes go on the event only. */
export const OUTAGE_MESSAGE = 'A production service we use is temporarily unavailable. Your ad is paused and will resume automatically — your credit is held and you won’t be charged twice.';
const FAILED_MESSAGE = 'We couldn’t produce this ad to our quality standard. You haven’t been charged for it.';

export type ProduceOutcome = 'complete' | 'failed' | 'skipped' | 'paused';

/** Another run took over this production (our lease lapsed): stop without touching state or spend. */
class LeaseLost extends Error {
  constructor() {
    super('production lease lost');
  }
}

/** A provider (or its circuit) is down: pause with the reservation held and resume later (§44). */
class ProviderOutage extends Error {
  constructor(
    readonly task: string,
    readonly underlying: unknown,
  ) {
    super(`${task}: ${(underlying as Error)?.message ?? 'unavailable'}`);
  }
}

/** Final QA found a hard defect: the ad cannot be delivered. */
class FinalQaFailure extends Error {}

/** Outage-class failures (§44): transient provider errors after the gateway's own retries, or an open circuit. */
export function isProviderOutage(e: unknown): boolean {
  if (e instanceof ProviderOutage) return true;
  if (e instanceof ProviderError) return e.kind === 'server' || e.kind === 'timeout' || e.kind === 'rate_limit';
  return e instanceof DomainError && e.code === 'UNAVAILABLE';
}

/** The authorization has no room left for this call (the repair reserve is spent). */
const reserveExhausted = (e: unknown) => e instanceof DomainError && e.code === 'FORBIDDEN' && (e.details as { reason?: string } | undefined)?.reason === 'ceiling_or_expired';

/** A hard product-identity failure (label, shape, closure, count) in one QA pass (§16, §44). */
export const hardFidelityFail = (res: readonly CheckResult[]) => res.some((c) => c.check === 'product_fidelity' && !c.pass && c.hard);

/** The QA repair reserve of one run, in generated seconds (see ProductionPlan.reserveSeconds). */
class RepairReserve {
  constructor(private left: number) {}
  take(seconds: number): boolean {
    if (seconds > this.left + 1e-6) return false;
    this.left -= seconds;
    return true;
  }
}

async function acquireLease(ctx: TenantContext, projectId: string, runId: string): Promise<boolean> {
  const res = leaseResource(projectId);
  return withTenant(ctx.workspaceId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${'lease:' + res}))`;
    await tx`delete from workspace_leases where resource = ${res} and expires_at < now()`;
    const [live] = await tx`select holder from workspace_leases where resource = ${res}`;
    if (live) return live.holder === runId;
    await tx`insert into workspace_leases (workspace_id, resource, holder, expires_at)
             values (${ctx.workspaceId}, ${res}, ${runId}, now() + make_interval(mins => ${PRODUCTION_LEASE_MINUTES}))`;
    return true;
  });
}

async function renewLease(ctx: TenantContext, projectId: string, runId: string): Promise<void> {
  const r = await withTenant(ctx.workspaceId, (tx) => tx`update workspace_leases set expires_at = now() + make_interval(mins => ${PRODUCTION_LEASE_MINUTES})
                                                           where resource = ${leaseResource(projectId)} and holder = ${runId} returning 1`);
  if (!r.length) throw new LeaseLost();
}

async function releaseLease(ctx: TenantContext, projectId: string, runId: string): Promise<void> {
  await withTenant(ctx.workspaceId, (tx) => tx`delete from workspace_leases where resource = ${leaseResource(projectId)} and holder = ${runId}`);
}

/** Is a run producing this project right now (live lease)? Explicitly scoped: callable as system_rw. */
export async function productionRunning(tx: Tx, workspaceId: string, projectId: string): Promise<boolean> {
  const [l] = await tx`select 1 from workspace_leases where workspace_id = ${workspaceId} and resource = ${leaseResource(projectId)} and expires_at > now()`;
  return !!l;
}

/** Move forward along the path unless the project is already at or past `to` (a resumed run skips done stages). */
async function advance(tx: Tx, ctx: TenantContext, projectId: string, to: ProjectState) {
  const [p] = await tx`select state from projects where id = ${projectId} for update`;
  const from = p!.state as ProjectState;
  if (PATH.includes(from) && PATH.indexOf(from) >= PATH.indexOf(to)) return;
  await transition(tx, ctx, projectId, to);
}

const RUNNABLE: readonly ProjectState[] = ['STORYBOARD_APPROVED', ...IN_PRODUCTION, 'NEEDS_USER_ACTION'];

/**
 * Produce an approved storyboard (render → QA → claims → voice → compose → final QA → deliver), resumably.
 *  - One live run per project (lease). A duplicate delivery is skipped; a crashed run's lease lapses and the next
 *    delivery — or the stuck-production sweep — resumes from durable state: the live reservation is reused with a
 *    new token (never reserved twice), accepted scene renders and voice lines are reused, QA attempts and repair
 *    reserve already spent are counted, and stages already passed are not re-entered (§25 idempotent resume, §35).
 *  - A provider outage or the renders kill switch pauses the project (NEEDS_USER_ACTION + outage) with the
 *    reservation held, and it resumes when the provider recovers; only QA failures may switch a scene to the
 *    exact-product composite (§44).
 */
export async function produceProject(ctx: TenantContext, projectId: string, opts: { runId?: string } = {}): Promise<ProduceOutcome> {
  const runId = opts.runId ?? randomUUID();
  const [pre] = await withTenant(ctx.workspaceId, (tx) => tx`select state from projects where id = ${projectId}`);
  if (!pre) throw new DomainError('NOT_FOUND', 'Project not found');
  if (!RUNNABLE.includes(pre.state as ProjectState)) return 'skipped';
  if (!(await acquireLease(ctx, projectId, runId))) return 'skipped';
  try {
    return await runProduction(ctx, projectId, runId);
  } finally {
    await releaseLease(ctx, projectId, runId).catch(() => {});
  }
}

function platePrompt(s: SceneRow): string {
  return [
    `Empty product-photography set for a vertical 9:16 skincare ad. Setting: ${s.visual_plan as string}.`,
    'Show only the surface, backdrop, props and light. No bottles, jars, tubes, packaging or products of any kind, no hands, no people, no text, no logos.',
    'Leave a clear, softly lit space in the centre where a product will be placed.',
  ].join(' ');
}

interface Slot {
  input: SceneInput;
  entry: ManifestScene;
}

async function runProduction(ctx: TenantContext, projectId: string, runId: string): Promise<ProduceOutcome> {
  const ws = ctx.workspaceId;
  const load = await withTenant(ws, async (tx) => {
    const p = await getProject(tx, projectId);
    const scenes = (await tx`select * from scenes where storyboard_id = ${p.storyboard_id} order by position`) as unknown as SceneRow[];
    const [sb] = await tx`select * from storyboards where id = ${p.storyboard_id}`;
    const [sku] = await tx`select * from skus where id = ${p.sku_id}`;
    const [fp] = await tx`select * from visual_fingerprints where sku_id = ${p.sku_id} and active`;
    const [variant] = p.variant_id ? await tx`select * from variants where id = ${p.variant_id}` : [null];
    const versions = (await tx`select id, scene_id, version, kind, asset_id, status, technique, input_hash, lineage from scene_versions
                               where scene_id = any(${scenes.map((s) => s.id)}::uuid[]) order by version`) as unknown as VersionRow[];
    const brand = await brandBrainFor(tx, p.sku_id as string);
    return { p, scenes, sb, sku: sku!, fp, variant, versions, brand, imagery: await productImagery(tx, p.sku_id as string) };
  });
  const { p, scenes, sb, sku, fp, variant, versions, brand, imagery } = load;
  if (!RUNNABLE.includes(p.state as ProjectState) || sb?.status !== 'approved') return 'skipped';
  const unit = (p.entitlement_unit as Exclude<LedgerUnit, 'usd_micros'>) ?? 'taste';
  const purpose: Purpose = unit === 'creative_test' ? 'creative_test' : unit;
  const heartbeat = () => renewLease(ctx, projectId, runId);
  const voice: LogicalVoice = brand?.brain.voice ?? DEFAULT_VOICE;
  const names = [sku.name as string, brand?.name ?? null];
  const reusable = reusableRenders(scenes, versions);
  const hashes = new Map(scenes.map((s) => [s.id, renderInputHash(s)]));
  const sameInputs = (v: VersionRow, s: SceneRow) => v.input_hash == null || v.input_hash === hashes.get(s.id);
  const ownFrames = versions.filter((v) => v.kind === 'frame' && v.lineage?.projectId === projectId && v.status === 'accepted');
  const plateFrame = (sceneId: string) => ownFrames.filter((v) => v.scene_id === sceneId && v.lineage?.plateAssetId).at(-1);
  const fallbackFrame = (sceneId: string) => ownFrames.filter((v) => v.scene_id === sceneId && v.lineage?.fallback).at(-1);

  // 1. Reservation (RENDER_RESERVED). A live reservation from an interrupted or paused run is taken over with a
  //    new token; otherwise (fresh approval, or the sweeper released a stranded one) the entitlement is reserved.
  //    The plan is priced on today's routes and rates; renders that can be reused are not priced again (§35).
  let auth: { authorizationId: string; token: string };
  let routes: ProductionRoutes;
  let plan: ProductionPlan;
  try {
    ({ auth, routes, plan } = await withTenant(ws, async (tx) => {
      const routes = await productionRoutes(tx, ws);
      const wantsPlate = (s: SceneRow) => s.production_mode === 'STRICT_COMPOSITE' && s.purpose !== 'cta' && !!imagery.cutout?.keyed && !!routes.plate && !plateFrame(s.id);
      const voChars = scenes.reduce((n, s) => n + ((s.spoken_line as string | null)?.trim().length ?? 0), 0);
      const plan = planProduction(scenes, voChars, routes, await loadRates(tx), {
        reuse: new Set(reusable.keys()),
        plates: scenes.filter(wantsPlate).length,
        ceilingMicros: CEILING_PURPOSES.includes(purpose) ? COST_LIMITS.CREATIVE_TEST_CEILING : null,
      });
      const [cur] = p.authorization_id ? await tx`select id, status from cost_authorizations where id = ${p.authorization_id} for update` : [];
      let a: { authorizationId: string; token: string } | null = null;
      if (cur?.status === 'active') {
        const token = await reissueToken(tx, cur.id as string, AUTH_TTL_MINUTES);
        if (token) a = { authorizationId: cur.id as string, token };
      }
      if (!a) {
        await tx`update cost_authorizations set idempotency_key = idempotency_key || ':retired:' || id::text
                 where workspace_id = ${ws} and project_id = ${projectId} and idempotency_key = ${'produce:' + projectId} and status <> 'active'`;
        const periodKey = unit === 'creative_test' ? ((await tx`select to_char(current_period_start, 'YYYY-MM-DD') as k from subscriptions order by created_at desc limit 1`)[0]?.k ?? null) : null;
        const r = await authorize(tx, ctx, {
          purpose,
          projectId,
          lines: plan.lines,
          entitlement: { unit, amount: 1, periodKey },
          idempotencyKey: `produce:${projectId}`,
          ttlMinutes: AUTH_TTL_MINUTES,
          // Paused renders still hold the customer's place (§44 "preserve reservation"); the run then queues.
          reserveWhileRendersPaused: true,
          meta: { reserveSeconds: plan.reserveSeconds, generative: plan.generative },
        });
        a = { authorizationId: r.authorizationId, token: r.token };
      }
      const [now] = await tx`select state from projects where id = ${projectId}`;
      if (now!.state === 'STORYBOARD_APPROVED' || now!.state === 'NEEDS_USER_ACTION') {
        // A resumed pause keeps its outage record until the stage that failed gets through, so an outage that
        // never recovers still reaches its deadline (OUTAGE_MAX_HOURS) instead of restarting the clock each retry.
        await clearOutage(tx, projectId, ['authorize']);
        await transition(tx, ctx, projectId, 'RENDER_RESERVED', { patch: { authorization_id: a.authorizationId } });
      } else {
        await tx`update projects set authorization_id = ${a.authorizationId} where id = ${projectId}`;
      }
      await step(tx, ws, projectId, 'prepare', 'done', `${scenes.length} scenes planned`);
      return { auth: a, routes, plan };
    }));
  } catch (e) {
    if (e instanceof DomainError && e.code === 'CONFLICT') return 'skipped';
    if (e instanceof DomainError && (e.code === 'PAYMENT_REQUIRED' || e.code === 'GATE_BLOCKED')) {
      await withTenant(ws, (tx) => transition(tx, ctx, projectId, 'NEEDS_USER_ACTION', { reason: e.message }));
      return 'failed';
    }
    // Anomaly hold / open circuit / unpriceable route before anything was reserved: pause and try again later.
    if (isProviderOutage(e)) return pauseForOutage(ctx, projectId, 'authorize', e, []);
    throw e;
  }

  // Renders switched off (kill.renders): the reservation holds the customer's place; the run queues (§44).
  if (await withTenant(ws, (tx) => isFlagOn(tx, 'kill.renders', ws))) {
    return pauseForOutage(ctx, projectId, 'renders', new DomainError('UNAVAILABLE', 'Renders are paused for maintenance'), []);
  }

  // The repair reserve left on this reservation: its planned seconds minus repairs already paid for on it.
  const reserve = await withTenant(ws, async (tx) => {
    const [a] = await tx`select estimate->>'reserveSeconds' as rs from cost_authorizations where id = ${auth.authorizationId}`;
    const jobs = await tx`select subject_id, count(*)::int as n from provider_jobs
                          where authorization_id = ${auth.authorizationId} and task = 'video.scene' and status <> 'failed' group by subject_id`;
    const used = jobs.reduce((t, j) => {
      const s = scenes.find((x) => x.id === j.subject_id);
      return t + (s && j.n > 1 ? (j.n - 1) * genSeconds(s.duration_ms) : 0);
    }, 0);
    return new RepairReserve(Math.max(0, (a?.rs != null ? Number(a.rs) : plan.reserveSeconds) - used));
  });

  const checks: CheckResult[] = [];
  try {
    await withTenant(ws, async (tx) => {
      await advance(tx, ctx, projectId, 'RENDERING');
      await step(tx, ws, projectId, 'scenes', 'active');
    });
    const refs = await withTenant(ws, async (tx) => Promise.all(((fp?.reference_asset_ids as string[]) ?? []).slice(0, 2).map((id) => assetBytes(tx, id))));
    const fingerprint = { labelText: (fp?.label_text as string) ?? null, closure: (fp?.closure as string) ?? null, paletteDistanceMax: 70 };
    if (imagery.cutout && !imagery.cutout.keyed) checks.push({ check: 'product_fidelity', pass: true, hard: false, detail: `Your product photo couldn’t be cut out cleanly, so product shots use the photo itself. ${CLEAN_PHOTO_TIP}` });

    await withTempDir(async (dir) => {
      /** Save an exact-product frame drawn during production as a scene version (§24 composition from versions). */
      const saveFrame = async (s: SceneRow, bytes: Buffer, technique: string, lineage: Record<string, unknown>, qa: CheckResult[] = []) =>
        withTenant(ws, async (tx) => {
          const a = await saveAsset(tx, ws, { bytes, mime: 'image/png', kind: 'storyboard_frame', skuId: sku.id as string, source: 'composed', lineage: { sceneId: s.id, projectId, technique, ...lineage } });
          const [v] = await tx`select coalesce(max(version), 0) + 1 as v from scene_versions where scene_id = ${s.id} and kind = 'frame'`;
          const [row] = await tx`insert into scene_versions (workspace_id, scene_id, version, kind, asset_id, technique, qa, status, lineage)
                                 values (${ws}, ${s.id}, ${v!.v}, 'frame', ${a.id}, ${technique}, ${tx.json(qa as never)}, 'accepted',
                                         ${tx.json({ projectId, ...lineage } as never)})
                                 returning id`;
          return { assetId: a.id, versionId: row!.id as string };
        });

      /** The storyboard frame a scene was approved with (or, if it has none, an exact-product frame). */
      const frameOf = async (s: SceneRow, n: number) => {
        const v = versions.find((x) => x.id === s.current_version_id);
        if (v?.asset_id) return { bytes: await withTenant(ws, (tx) => assetBytes(tx, v.asset_id!)), assetId: v.asset_id, versionId: v.id, technique: v.technique ?? 'frame' };
        const fb = await exactProductFrame(imagery, { purpose: s.purpose });
        if (!fb) throw new FinalQaFailure(`Scene ${n} has no frame and there is no product image to compose one from`);
        const saved = await saveFrame(s, fb.bytes, fb.technique, fb.lineage);
        return { bytes: fb.bytes, ...saved, technique: fb.technique };
      };

      const still = async (s: SceneRow, n: number, f: { bytes: Buffer; assetId: string | null; versionId: string | null; technique: string }): Promise<Slot> => {
        const file = path.join(dir, `frame-${n}.png`);
        await writeFile(file, f.bytes);
        return {
          input: { kind: 'still', file, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null, motion: 'push' },
          entry: manifestScene(s, 'still', f.assetId, f.versionId, f.technique),
        };
      };

      const manifestScene = (s: SceneRow, kind: 'still' | 'video', assetId: string | null, versionId: string | null, technique: string): ManifestScene => ({
        sceneId: s.id,
        position: Number(s.position),
        purpose: s.purpose,
        kind,
        assetId,
        versionId,
        technique,
        overlayText: (s.overlay_text as string | null) ?? null,
        spokenText: ((s.spoken_line as string | null) ?? '').trim() || null,
        durationMs: s.duration_ms,
        claimIds: [],
      });

      /**
       * Repeated QA failure (or no repair the reserve can fund) changes technique instead of looping spend
       * (§25, §44): the exact product from the merchant's own photo — itself QA-checked — never a reused
       * generated frame.
       */
      const exactFallback = async (s: SceneRow, n: number, why: string): Promise<Slot> => {
        await withTenant(ws, (tx) => step(tx, ws, projectId, 'accuracy', 'active', 'Using your exact product photo for this shot'));
        const prior = fallbackFrame(s.id);
        if (prior?.asset_id) {
          checks.push({ check: 'product_fidelity', pass: true, hard: false, detail: `Scene ${n}: switched to exact product composite (${why}); checked earlier` });
          return still(s, n, { bytes: await withTenant(ws, (tx) => assetBytes(tx, prior.asset_id!)), assetId: prior.asset_id, versionId: prior.id, technique: prior.technique ?? 'exact_product_composite' });
        }
        const fb = await exactProductFrame(imagery, { purpose: s.purpose });
        if (!fb) throw new FinalQaFailure(`Scene ${n}: repeated QA failure and no exact product image to fall back to`);
        const res = await qaScene({ ctx, token: auth.token, sceneId: s.id, sceneText: 'The exact product photo placed on a plain studio backdrop', frameBytes: fb.bytes, referenceBytes: refs, fingerprint, planText: 'exact product composite', attempt: 3 });
        checks.push(...res.map((c) => ({ ...c, detail: `Scene ${n}: switched to exact product composite (${why}) — ${c.detail}` })));
        if (hardFidelityFail(res)) throw new FinalQaFailure(`Scene ${n}: even the exact product composite failed product QA`);
        const saved = await saveFrame(s, fb.bytes, fb.technique, { ...fb.lineage, fallback: true, reason: why }, res);
        return still(s, n, { bytes: fb.bytes, ...saved, technique: fb.technique });
      };

      /** Generative scene: render → QA → one free repair funded by the reserve → technique switch (§25). */
      const generative = async (s: SceneRow, n: number, frame: { bytes: Buffer }): Promise<Slot> => {
        const reused = reusable.get(s.id);
        if (reused?.asset_id) {
          // Accepted by an earlier run with the same inputs (or locked): reuse, never regenerate (§13, §24, §35).
          const file = path.join(dir, `scene-${n}.mp4`);
          await writeFile(file, await withTenant(ws, (tx) => assetBytes(tx, reused.asset_id!)));
          return { input: { kind: 'video', file, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null }, entry: manifestScene(s, 'video', reused.asset_id, reused.id, 'generative') };
        }
        const seconds = genSeconds(s.duration_ms);
        // Attempts already spent on these inputs by an interrupted run count: a resume never grants an extra repair.
        let attempt = versions.filter((v) => v.scene_id === s.id && v.kind === 'render' && v.status === 'qa_failed' && sameInputs(v, s)).length;
        let why = 'repeated QA failure';
        let lastFailure = 'QA';
        while (attempt < 2) {
          attempt++;
          if (attempt === 2) {
            if (!reserve.take(seconds)) {
              why = 'repair reserve used';
              break;
            }
            await withTenant(ws, async (tx) => {
              await append(tx, ctx, { type: 'FREE_QA_RETRY', unit: 'usd_micros', amount: 0, projectId, authorizationId: auth.authorizationId, idempotencyKey: `qa-retry:${s.id}:${auth.authorizationId}`, reason: lastFailure.slice(0, 200) });
              await step(tx, ws, projectId, 'accuracy', 'active', 'Improving product accuracy');
            });
          }
          try {
            const vid = await generateVideo({
              ctx,
              token: auth.token,
              task: 'video.scene',
              subject: { type: 'scene', id: s.id },
              prompt: `${s.visual_plan as string}. ${s.product_behavior ?? ''} Keep the product identical to the reference image. Natural adult skin, no retouching, no text.${attempt === 2 ? ' Keep the product fully still and clearly readable; simpler hand motion.' : ''}`,
              references: [`data:image/png;base64,${frame.bytes.toString('base64')}`],
              seconds,
              resolution: '720p',
              ratio: '9:16',
              mockLabel: `${s.purpose} · ${(s.visual_plan as string).slice(0, 60)}`,
              heartbeat,
            });
            const res = await qaScene({ ctx, token: auth.token, sceneId: s.id, sceneText: s.visual_plan as string, videoBytes: vid.bytes, referenceBytes: refs, fingerprint, planText: s.visual_plan as string, attempt });
            const ok = res.every((c) => c.pass);
            const saved = await withTenant(ws, async (tx) => {
              const a = await saveAsset(tx, ws, { bytes: vid.bytes, mime: 'video/mp4', kind: 'scene_render', skuId: sku.id as string, source: 'generated', lineage: { sceneId: s.id, attempt, providerJobId: vid.jobId, model: vid.modelVersion, promptVersion: vid.promptVersion, inputHash: hashes.get(s.id) } });
              const [v] = await tx`select coalesce(max(version), 0) + 1 as v from scene_versions where scene_id = ${s.id} and kind = 'render'`;
              const [row] = await tx`insert into scene_versions (workspace_id, scene_id, version, kind, asset_id, technique, model, prompt_version, qa, status, input_hash, lineage)
                                     values (${ws}, ${s.id}, ${v!.v}, 'render', ${a.id}, 'generative', ${vid.modelVersion ?? null}, ${vid.promptVersion},
                                             ${tx.json(res as never)}, ${ok ? 'accepted' : 'qa_failed'}, ${hashes.get(s.id)!},
                                             ${tx.json({ attempt, providerJobId: vid.jobId, frameVersionId: s.current_version_id ?? null } as never)})
                                     returning id`;
              await emit(tx, ctx, ok ? 'QA_PASSED' : 'QA_FAILED', { type: 'scene', id: s.id }, { attempt, projectId, hardFail: hardFidelityFail(res), checks: res.map((c) => ({ check: c.check, pass: c.pass, hard: c.hard })) }, {
                projectId, skuId: sku.id as string, storyboardId: sb!.id as string, experimentId: p.experiment_id as string | null, variantId: p.variant_id as string | null,
                providerJobId: vid.jobId, authorizationId: auth.authorizationId, assetId: a.id,
              });
              return { assetId: a.id, versionId: row!.id as string };
            });
            checks.push(...res.map((c) => ({ ...c, detail: `Scene ${n}: ${c.detail}` })));
            if (ok) {
              const file = path.join(dir, `scene-${n}.mp4`);
              await writeFile(file, vid.bytes);
              return { input: { kind: 'video', file, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null }, entry: manifestScene(s, 'video', saved.assetId, saved.versionId, 'generative') };
            }
            lastFailure = res.find((c) => !c.pass)?.detail ?? 'QA';
          } catch (e) {
            // Moderation (a policy false positive, §44) is answered like a QA failure: a compliant alternative shot.
            if (e instanceof ProviderError && e.kind === 'moderation') {
              checks.push({ check: 'visual', pass: false, hard: false, detail: `Scene ${n}: provider moderation — using a compliant alternative shot` });
              lastFailure = 'provider moderation';
              continue;
            }
            // The authorization can't fund the repair (e.g. rates rose since planning): stop spending, switch technique.
            if (attempt === 2 && reserveExhausted(e)) {
              why = 'repair not covered by the reserve';
              break;
            }
            // Outages pause the production; they never degrade the ad to avoid cost (§44, §48).
            if (isProviderOutage(e)) throw new ProviderOutage('video.scene', e);
            throw e;
          }
        }
        return exactFallback(s, n, why);
      };

      /**
       * Strict product composite (§23): the exact cut-out on a generated, product-free environment plate when one
       * passes QA; otherwise the approved storyboard frame (the cut-out on the production backdrop). Plates are an
       * enhancement: a plate that fails, or a provider that can't draw one, never pauses or degrades the ad.
       */
      const strict = async (s: SceneRow, n: number): Promise<Slot> => {
        const approved = await frameOf(s, n);
        if (!imagery.cutout?.keyed || !routes.plate) return still(s, n, approved);
        const prior = plateFrame(s.id);
        if (prior?.asset_id) return still(s, n, { bytes: await withTenant(ws, (tx) => assetBytes(tx, prior.asset_id!)), assetId: prior.asset_id, versionId: prior.id, technique: prior.technique ?? 'exact_product_composite' });
        try {
          const img = await generateImage({ ctx, token: auth.token, task: PLATE_TASK, subject: { type: 'scene', id: s.id }, prompt: platePrompt(s), references: [], width: 1080, height: 1920, mockLabel: '' });
          const plate = await withTenant(ws, (tx) => saveAsset(tx, ws, { bytes: img.bytes, mime: img.mime, kind: 'storyboard_frame', skuId: sku.id as string, source: 'generated', lineage: { sceneId: s.id, projectId, plate: true, providerJobId: img.jobId, promptVersion: img.promptVersion } }));
          const fb = (await exactProductFrame(imagery, { purpose: s.purpose, plate: { assetId: plate.id, bytes: img.bytes } }))!;
          const res = await qaScene({ ctx, token: auth.token, sceneId: s.id, sceneText: s.visual_plan as string, frameBytes: fb.bytes, referenceBytes: refs, fingerprint, planText: s.visual_plan as string, attempt: 1 });
          if (!res.every((c) => c.pass)) {
            checks.push({ check: 'visual', pass: true, hard: false, detail: `Scene ${n}: generated setting rejected by QA (${res.find((c) => !c.pass)?.detail ?? 'QA'}); using the studio backdrop` });
            return still(s, n, approved);
          }
          checks.push(...res.map((c) => ({ ...c, detail: `Scene ${n}: exact product on a generated setting — ${c.detail}` })));
          const saved = await saveFrame(s, fb.bytes, fb.technique, fb.lineage, res);
          return still(s, n, { bytes: fb.bytes, ...saved, technique: fb.technique });
        } catch (e) {
          if (e instanceof LeaseLost) throw e;
          if (e instanceof ProviderError || (e instanceof DomainError && (e.code === 'UNAVAILABLE' || e.code === 'FORBIDDEN'))) {
            checks.push({ check: 'visual', pass: true, hard: false, detail: `Scene ${n}: no generated setting (${(e as Error).message.slice(0, 80)}); using the studio backdrop` });
            return still(s, n, approved);
          }
          throw e;
        }
      };

      const body = scenes.filter((s) => s.purpose !== 'cta');
      const ctaScene = scenes.find((s) => s.purpose === 'cta') ?? null;
      const slots: Slot[] = [];
      for (const [i, s] of body.entries()) {
        const n = i + 1;
        await heartbeat();
        if (s.production_mode === 'GENERATIVE_INTERACTION') slots.push(await generative(s, n, await frameOf(s, n)));
        else if (s.production_mode === 'STRICT_COMPOSITE') slots.push(await strict(s, n));
        else slots.push(await still(s, n, await frameOf(s, n)));
      }
      await heartbeat();
      await withTenant(ws, async (tx) => {
        await step(tx, ws, projectId, 'scenes', 'done', `${scenes.length} scenes`);
        await clearOutage(tx, projectId, ['video.scene', 'renders']);
        await advance(tx, ctx, projectId, 'QA_RUNNING');
        await step(tx, ws, projectId, 'accuracy', 'done', 'Product matches your reference photos');
      });

      // Claims check on everything said or shown, before voice is synthesized (Launch Gate 3), per platform the
      // exports are published to (9:16 → TikTok + Reels, 4:5/1:1 → Feed) in the brand's market (§17, §43). Each
      // scene records the Claim IDs its lines use (§24).
      const lines = [...scenes.flatMap((s) => [s.spoken_line, s.overlay_text]), sb.hook_text, sb.cta_text].filter(Boolean) as string[];
      const claimCheck = await withTenant(ws, (tx) => claimsQaForExports(tx, sku.id as string, lines, ASPECTS, { names }));
      checks.push(claimCheck);
      const mapping = ((claimCheck.data as { mapping?: LineMapping[] } | undefined)?.mapping ?? []) as LineMapping[];
      const claimIds = new Map(scenes.map((s) => [s.id, sceneClaimIds([s.spoken_line as string | null, s.overlay_text as string | null], mapping)]));
      await withTenant(ws, async (tx) => {
        for (const s of scenes) await tx`update scenes set claim_ids = ${claimIds.get(s.id)!}::uuid[] where id = ${s.id}`;
      });
      for (const slot of slots) slot.entry.claimIds = claimIds.get(slot.entry.sceneId) ?? [];
      if (!claimCheck.pass) {
        await withTenant(ws, async (tx) => {
          await step(tx, ws, projectId, 'claims', 'failed', 'A line needs changing before we can finish');
          await transition(tx, ctx, projectId, 'BLOCKED_COMPLIANCE', { reason: claimCheck.detail });
          await tx`update projects set qa_report = ${tx.json(summarize(checks) as never)} where id = ${projectId}`;
          await settle(tx, ctx, auth.authorizationId, 'released');
        });
        return;
      }
      await withTenant(ws, (tx) => step(tx, ws, projectId, 'claims', 'done', `${lines.length} lines checked`));

      // Voice-over: one line per scene (MiniMax → approved fallback), fitted to its scene so the captions follow
      // the speech (plan 06 Phase 3 #6; §25 check 4). Lines an interrupted run already voiced are reused.
      await heartbeat();
      await withTenant(ws, async (tx) => {
        await advance(tx, ctx, projectId, 'COMPOSING');
        await step(tx, ws, projectId, 'voice', 'active');
      });
      const endCardMs = ctaScene?.duration_ms ?? 2000;
      const totalMs = body.reduce((t, s) => t + s.duration_ms, 0) + endCardMs;
      const windows = new Map<string, { startMs: number; endMs: number }>();
      let t0 = 0;
      for (const s of body) {
        windows.set(s.id, { startMs: t0, endMs: t0 + s.duration_ms });
        t0 += s.duration_ms;
      }
      if (ctaScene) windows.set(ctaScene.id, { startMs: t0, endMs: t0 + endCardMs });
      const speakers = [...body, ...(ctaScene ? [ctaScene] : [])].filter((s) => ((s.spoken_line as string | null) ?? '').trim());
      const voiced: { scene: SceneRow; text: string; clipAssetId: string; file: string; clipMs: number }[] = [];
      for (const [i, s] of speakers.entries()) {
        await heartbeat();
        const text = (s.spoken_line as string).trim();
        const textHash = createHash('sha256').update(`${voice}\n${text}`).digest('hex');
        let clip = await withTenant(ws, async (tx) => {
          const [a] = await tx`select id from assets where kind = 'voiceover' and lineage->>'projectId' = ${projectId} and lineage->>'sceneId' = ${s.id}
                               and lineage->>'textHash' = ${textHash} order by created_at desc limit 1`;
          return a ? { id: a.id as string, bytes: await assetBytes(tx, a.id as string) } : null;
        });
        if (!clip) {
          try {
            const vo = await synthesizeVoice({ ctx, token: auth.token, task: 'tts.voiceover', subject: { type: 'scene', id: s.id }, text, voice });
            const a = await withTenant(ws, (tx) => saveAsset(tx, ws, { bytes: vo.bytes, mime: 'audio/mpeg', kind: 'voiceover', skuId: sku.id as string, source: 'generated', lineage: { providerJobId: vo.jobId, provider: vo.provider, task: vo.task, projectId, sceneId: s.id, textHash } }));
            clip = { id: a.id, bytes: vo.bytes };
          } catch (e) {
            if (isProviderOutage(e)) throw new ProviderOutage('tts.voiceover', e);
            throw e;
          }
        }
        const file = path.join(dir, `vo-${i}.mp3`);
        await writeFile(file, clip.bytes);
        voiced.push({ scene: s, text, clipAssetId: clip.id, file, clipMs: (await probe(file)).durationMs });
      }
      const schedule = scheduleVoice(voiced.map((v) => ({ windowStartMs: windows.get(v.scene.id)!.startMs, windowEndMs: windows.get(v.scene.id)!.endMs, clipMs: v.clipMs })), totalMs);
      if (schedule.overflowMs > VO_OVERFLOW_TOLERANCE_MS) {
        checks.push({ check: 'audio', pass: false, hard: true, detail: `The voice-over runs ${(schedule.overflowMs / 1000).toFixed(1)}s past the end of the ad even at a brisk pace` });
        throw new FinalQaFailure('Voice-over does not fit the ad');
      }
      const segments: VoiceSegment[] = voiced.map((v, i) => ({ sceneId: v.scene.id, text: v.text, clipAssetId: v.clipAssetId, ...schedule.placed[i]! }));
      const captions: Cue[] = segments.flatMap((sg) => captionCues(sg.text, sg.startMs, sg.endMs));
      let voPath: string | null = null;
      if (segments.length) {
        voPath = path.join(dir, 'vo.wav');
        await layoutVoice(segments.map((sg, i): VoiceClip => ({ file: voiced[i]!.file, startMs: sg.startMs, tempo: sg.tempo })), totalMs, voPath);
      }
      await withTenant(ws, async (tx) => {
        await step(tx, ws, projectId, 'voice', 'done', segments.length ? 'Voice-over and captions added' : 'Captions added');
        await clearOutage(tx, projectId, ['tts.voiceover']);
      });

      // Composition (deterministic from scene versions, §24) + platform variants.
      await heartbeat();
      await withTenant(ws, async (tx) => {
        await advance(tx, ctx, projectId, 'PLATFORM_VARIANTS');
        await step(tx, ws, projectId, 'platforms', 'active');
      });
      const endCard = { productName: sku.name as string, cta: (sb.cta_text as string) ?? 'Shop now', index: `NO. ${String(sku.catalogue_no).padStart(3, '0')}`, durationMs: endCardMs };
      const outs = await composeAd({ scenes: slots.map((s) => s.input), voiceover: voPath, captions, endCard, aspects: ASPECTS }, dir);
      const [concept] = await withTenant(ws, (tx) => tx`select proposal from concepts where id = ${p.selected_concept_id}`);
      const proposal = (concept?.proposal ?? {}) as Record<string, unknown>;
      const manifest: CompositionManifest = {
        version: 1,
        skuId: sku.id as string,
        cutoutAssetId: imagery.cutout?.assetId ?? null,
        scenes: slots.map((s) => s.entry),
        voiceover: segments.length ? { voice, segments } : null,
        captions,
        endCard: { ...endCard, sceneId: ctaScene?.id ?? null, spokenText: ((ctaScene?.spoken_line as string | null) ?? '').trim() || null },
        durationMs: totalMs,
        aspects: ASPECTS,
        genes: { angle: proposal.angle, hookMechanism: proposal.hookMechanism, proofMechanism: proposal.proofMechanism, treatment: proposal.treatment },
      };

      // Final QA: platform/audio per export + asset integrity + experiment integrity.
      await heartbeat();
      await withTenant(ws, (tx) => advance(tx, ctx, projectId, 'FINAL_QA'));
      const exportAssets: { aspect: Aspect; assetId: string }[] = [];
      for (const o of outs) {
        checks.push(...(await qaExport(o.file, o.aspect, totalMs)));
        const bytes = await readFile(o.file);
        const a = await withTenant(ws, (tx) =>
          saveAsset(tx, ws, { bytes, mime: 'video/mp4', kind: 'final_export', skuId: sku.id as string, source: 'composed', lineage: { projectId, aspect: o.aspect, srt: o.srt, storyboardId: sb.id } }),
        );
        exportAssets.push({ aspect: o.aspect, assetId: a.id });
      }
      const integrity = await withTenant(ws, async (tx) => Promise.all(exportAssets.map((e) => verifyAssetIntegrity(tx, e.assetId))));
      checks.push({ check: 'asset_integrity', pass: integrity.every(Boolean), hard: !integrity.every(Boolean), detail: integrity.every(Boolean) ? 'Files stored in our storage; checksums verified' : 'Checksum mismatch' });
      checks.push(await withTenant(ws, (tx) => masterIntegrity(tx, variant, manifest)));
      const report = summarize(checks.filter((c) => !(c.check === 'visual' && /provider/.test(c.detail)) || !c.pass));
      const hardFinal = checks.filter((c) => ['platform', 'audio', 'asset_integrity', 'experiment_integrity'].includes(c.check)).some((c) => !c.pass && c.hard);
      if (hardFinal) throw new FinalQaFailure(`Final QA failed: ${checks.filter((c) => !c.pass && c.hard).map((c) => c.detail).join('; ').slice(0, 250)}`);

      // Deliver: creative record with lineage and composition manifest, settle consumed, notify. Only the lease
      // holder may deliver.
      await heartbeat();
      await withTenant(ws, async (tx) => {
        const [cr] = await tx`
          insert into creatives (workspace_id, sku_id, origin, project_id, genome, genome_version, final_asset_ids, composition)
          values (${ws}, ${sku.id}, 'generated', ${projectId},
            ${tx.json({ angle: proposal.angle, hookMechanism: proposal.hookMechanism, proofMechanism: proposal.proofMechanism, treatment: proposal.treatment, hookText: sb.hook_text, durationSec: Math.round(totalMs / 1000), hasCaptions: true, hasVoiceover: segments.length > 0 } as never)},
            1, ${exportAssets.map((e) => e.assetId)}, ${tx.json(manifest as never)})
          returning id`;
        if (p.variant_id) await tx`update variants set creative_id = ${cr!.id} where id = ${p.variant_id}`;
        await tx`update projects set qa_report = ${tx.json({ ...report, pass: true } as never)}, final_creative_id = ${cr!.id}, outage = null where id = ${projectId}`;
        await step(tx, ws, projectId, 'platforms', 'done', 'TikTok · Reels 9:16 · Feed 4:5 · Square');
        await transition(tx, ctx, projectId, 'COMPLETE');
        await settle(tx, ctx, auth.authorizationId, 'consumed');
        const refs = { projectId, skuId: sku.id as string, creativeId: cr!.id as string, storyboardId: sb!.id as string, experimentId: p.experiment_id as string | null, variantId: p.variant_id as string | null, authorizationId: auth.authorizationId };
        // An experiment's master is its control variant; a one-off ad has no variant (COMPOSITION_COMPLETED only).
        if (p.variant_id) await emit(tx, ctx, 'VARIANT_GENERATED', { type: 'variant', id: p.variant_id as string }, { creativeId: cr!.id, exports: exportAssets, master: true }, refs);
        await emit(tx, ctx, 'COMPOSITION_COMPLETED', { type: 'project', id: projectId }, { creativeId: cr!.id, exports: exportAssets }, refs);
        await enqueue(tx, ws, Queues.sendEmail, { template: 'asset_ready', projectId });
        if (p.experiment_id) await enqueue(tx, ws, Queues.hookVariants, { projectId });
      });
    });
    const [final] = await withTenant(ws, (tx) => tx`select state from projects where id = ${projectId}`);
    return final!.state === 'COMPLETE' ? 'complete' : 'failed';
  } catch (e) {
    if (e instanceof LeaseLost) return 'skipped';
    if (isProviderOutage(e)) return pauseForOutage(ctx, projectId, e instanceof ProviderOutage ? e.task : 'production', e, checks);
    // Hard failures: the customer is not charged for what we could not deliver (§25 retry policy).
    await withTenant(ws, (tx) => failProduction(tx, ctx, projectId, (e as Error).message, { checks }));
    throw e;
  }
}

/** An outage is over once the stage it stopped gets through. */
async function clearOutage(tx: Tx, projectId: string, tasks: string[]) {
  await tx`update projects set outage = null where id = ${projectId} and outage->>'task' = any(${tasks})`;
}

/**
 * Experiment integrity of an experiment's master (§25 check 6). Hook variants are checked against this master's
 * composition when they are made. Against a control, the comparison is computed when the control has a
 * composition manifest; a new master necessarily has its own body, so the result is recorded, not enforced.
 */
async function masterIntegrity(tx: Tx, variant: Record<string, unknown> | null, manifest: CompositionManifest): Promise<CheckResult> {
  if (!variant) return qaExperimentIntegrity(null, { changed: [] });
  const [control] = await tx`select c.composition from variants v join creatives c on c.id = v.creative_id and c.workspace_id = v.workspace_id
                             where v.experiment_id = ${variant.experiment_id as string} and v.role = 'control' limit 1`;
  const intended = { changed: (variant.changed_variables as string[]) ?? [], heldConstant: (variant.held_constant as string[]) ?? [] };
  if (!control) return { check: 'experiment_integrity', pass: true, hard: false, detail: 'Master of this experiment: its hook variants are checked against this composition' };
  if (!control.composition) return { check: 'experiment_integrity', pass: true, hard: false, detail: 'The control is an imported ad without a composition record, so held-constant parts can’t be compared automatically' };
  const res = qaExperimentIntegrity(intended, { changed: diffCompositions(control.composition as CompositionManifest, manifest) });
  return { ...res, hard: false, detail: `Against the control: ${res.detail}` };
}

/**
 * Pause for a provider outage (§44): NEEDS_USER_ACTION with a clear status, the reservation held through the
 * pause, and resumption by the resume sweep once the provider (or its circuit) recovers. An outage longer than
 * OUTAGE_MAX_HOURS ends the attempt: entitlement returned, paid one-off orders refunded.
 */
async function pauseForOutage(ctx: TenantContext, projectId: string, task: string, e: unknown, checks: CheckResult[]): Promise<ProduceOutcome> {
  const detail = ((e as Error)?.message ?? String(e)).slice(0, 300);
  return withTenant(ctx.workspaceId, async (tx) => {
    const [p] = await tx`select state, outage, authorization_id from projects where id = ${projectId} for update`;
    if (!p || isTerminal(p.state as ProjectState) || p.state === 'PROVIDER_FAILED') return 'skipped';
    const prev = (p.outage ?? null) as { since?: string; attempts?: number } | null;
    const since = prev?.since ? new Date(prev.since) : new Date();
    if (Date.now() - since.getTime() > OUTAGE_MAX_HOURS * 3600_000) {
      await failProduction(tx, ctx, projectId, `provider outage over ${OUTAGE_MAX_HOURS}h (${task}): ${detail}`, { checks });
      return 'failed';
    }
    if (p.state !== 'NEEDS_USER_ACTION') await transition(tx, ctx, projectId, 'NEEDS_USER_ACTION', { reason: OUTAGE_MESSAGE, detail: `provider outage (${task}): ${detail}` });
    const outage = { task, since: since.toISOString(), attempts: (prev?.attempts ?? 0) + 1, lastAt: new Date().toISOString(), lastError: detail };
    await tx`update projects set outage = ${tx.json(outage as never)}, failure_reason = ${OUTAGE_MESSAGE},
               qa_report = ${tx.json(summarize(checks) as never)} where id = ${projectId}`;
    if (p.authorization_id) await holdAuthorization(tx, p.authorization_id as string, new Date(since.getTime() + (OUTAGE_MAX_HOURS + 1) * 3600_000));
    await tx`update progress_steps set detail = 'Paused while a provider recovers — we’ll continue automatically.'
             where workspace_id = ${ctx.workspaceId} and subject_id = ${projectId} and status = 'active'`;
    return 'paused';
  });
}

/**
 * End a production that cannot be delivered: PROVIDER_FAILED with a customer-safe reason, the reservation
 * settled as refunded (entitlement returned), and — for paid one-off orders — the automatic refund queued
 * (the L12 guarantee: you don't pay for an ad we couldn't deliver to our quality standard). Idempotent.
 */
export async function failProduction(tx: Tx, ctx: TenantContext, projectId: string, detail: string, opts: { checks?: CheckResult[] } = {}): Promise<boolean> {
  const [p] = await tx`select state, authorization_id from projects where id = ${projectId} and workspace_id = ${ctx.workspaceId} for update`;
  if (!p || isTerminal(p.state as ProjectState) || p.state === 'PROVIDER_FAILED') return false;
  if (opts.checks) await tx`update projects set qa_report = ${tx.json({ ...summarize(opts.checks), error: detail.slice(0, 300) } as never)} where id = ${projectId}`;
  await transition(tx, ctx, projectId, 'PROVIDER_FAILED', { reason: FAILED_MESSAGE, detail: detail.slice(0, 500) });
  await tx`update projects set outage = null where id = ${projectId}`;
  if (p.authorization_id) await settle(tx, ctx, p.authorization_id as string, 'refunded');
  await tx`update progress_steps set status = 'failed', detail = 'We hit a problem on our side. You have not been charged for this attempt.', completed_at = now()
           where workspace_id = ${ctx.workspaceId} and subject_id = ${projectId} and status in ('active','pending')`;
  const [pu] = await tx`select id from purchases where workspace_id = ${ctx.workspaceId} and project_id = ${projectId}
                        and status = 'paid' and kind in ('taste','standalone') order by created_at desc limit 1`;
  if (pu) await enqueue(tx, ctx.workspaceId, Queues.refundPurchase, { projectId, purchaseId: pu.id, reason: 'guarantee' }, { singletonKey: `refund:${pu.id}`, priority: 20 });
  return true;
}

/**
 * Retry a failed or stalled production. A stalled one (in production but no live run) is resumed from durable
 * state; a failed or paused one is re-approved (the entitlement was returned on failure, so the run reserves it
 * again; a paused one keeps its held reservation). Accepted renders with unchanged inputs are reused either way.
 */
export async function retryProduction(tx: Tx, ctx: TenantContext, projectId: string) {
  const p = await getProject(tx, projectId);
  // A retry re-reserves the entitlement: the same right as approving production in the first place.
  if (ctx.actor.kind === 'user') assertCan(ctx, p.entitlement_unit === 'creative_test' ? 'spend.creative_test' : 'storyboard.approve');
  if (IN_PRODUCTION.includes(p.state as ProjectState)) {
    if (await productionRunning(tx, ctx.workspaceId, projectId)) throw new DomainError('CONFLICT', 'This ad is being produced right now.');
    await enqueue(tx, ctx.workspaceId, Queues.produceProject, { projectId, actor: ctx.actor, resume: true }, { singletonKey: `produce:${projectId}:resume:${Date.now()}`, priority: priorityFor(ctx, 'production') });
    return { resumed: true };
  }
  if (!['PROVIDER_FAILED', 'NEEDS_USER_ACTION'].includes(p.state as string)) throw new DomainError('CONFLICT', 'Nothing to retry');
  await tx`update cost_authorizations set idempotency_key = idempotency_key || ':retired:' || extract(epoch from now())::bigint
           where workspace_id = ${ctx.workspaceId} and project_id = ${projectId} and idempotency_key = ${'produce:' + projectId} and status <> 'active'`;
  await transition(tx, ctx, projectId, 'STORYBOARD_APPROVED');
  await tx`update projects set outage = null where id = ${projectId}`;
  await enqueue(tx, ctx.workspaceId, Queues.produceProject, { projectId, actor: ctx.actor, retry: true }, { singletonKey: `produce:${projectId}:${Date.now()}`, priority: priorityFor(ctx, 'production') });
  return { resumed: false };
}

