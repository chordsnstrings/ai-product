import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTenant, type Tx } from '@arkiv/db';
import { DEFAULT_VOICE, DomainError, platformsFor, type Platform, type ProjectState } from '@arkiv/shared';
import { composeAd, placeholderFrame, withTempDir, type Aspect, type SceneInput } from '@arkiv/media';
import { ProviderError } from '@arkiv/providers';
import { assetBytes, saveAsset, verifyAssetIntegrity } from './assets';
import { assertCan } from './authz';
import { brandBrainFor } from './brand';
import type { TenantContext } from './context';
import { authorize, holdAuthorization, reissueToken, settle } from './cost-governor';
import { allowedClaimTexts } from './creative-director';
import { emit } from './events';
import { append, type LedgerUnit } from './ledger';
import { generateVideo, synthesizeVoice } from './model-gateway';
import { enqueue, priorityFor, Queues } from './outbox';
import { planSteps, step } from './progress';
import { getProject, IN_PRODUCTION, isTerminal, PATH, transition } from './projects';
import { qaClaims, qaExperimentIntegrity, qaExport, qaScene, summarize, type CheckResult } from './qa';
import type { CostLine } from './rates';

export const PRODUCTION_STEPS = [
  { key: 'prepare', label: 'Preparing your product' },
  { key: 'scenes', label: 'Creating scenes' },
  { key: 'accuracy', label: 'Checking product accuracy' },
  { key: 'claims', label: 'Checking claims' },
  { key: 'voice', label: 'Adding voice and captions' },
  { key: 'platforms', label: 'Preparing platform versions' },
];

const ASPECTS: Aspect[] = ['9x16', '4x5', '1x1'];
/** Seedance models reject very short durations; generate ≥ 5s and trim in composition (§48 per-model duration). */
const MIN_GEN_SECONDS = 5;

type SceneRow = Record<string, unknown> & { id: string; production_mode: string; duration_ms: number; purpose: string };

const PLATFORM_LABEL: Record<Platform, string> = { TIKTOK: 'TikTok', INSTAGRAM_REELS: 'Instagram Reels', FACEBOOK_FEED: 'Facebook/Instagram feed' };

/** Claims QA for every platform the given exports publish to; a line must be approved on each of them. */
export async function claimsQaForExports(tx: Tx, skuId: string, lines: string[], aspects: readonly Aspect[]): Promise<CheckResult> {
  const results: { platform: Platform; check: CheckResult }[] = [];
  for (const platform of platformsFor(aspects)) results.push({ platform, check: qaClaims(lines, await allowedClaimTexts(tx, skuId, { platforms: [platform] })) });
  const failing = results.filter((r) => !r.check.pass);
  if (!failing.length) return { ...results[0]!.check, detail: `${lines.length} lines checked for ${results.map((r) => PLATFORM_LABEL[r.platform]).join(', ')}` };
  return {
    check: 'claims',
    pass: false,
    hard: true,
    detail: failing.map((f) => `${PLATFORM_LABEL[f.platform]}: ${f.check.detail}`).join(' | '),
    data: { platforms: failing.map((f) => ({ platform: f.platform, ...(f.check.data as object) })) },
  };
}

/** Production Planner (§23): chooses the medium scene by scene and prices the plan before any spend. */
export function planProduction(scenes: SceneRow[], voiceChars: number): { lines: CostLine[]; generative: string[] } {
  const generative = scenes.filter((s) => s.production_mode === 'GENERATIVE_INTERACTION' && !s.locked).map((s) => s.id);
  const lines: CostLine[] = [];
  for (const id of generative) {
    const s = scenes.find((x) => x.id === id)!;
    const seconds = Math.max(MIN_GEN_SECONDS, Math.ceil(s.duration_ms / 1000));
    // Ceiling covers the render plus one full free repair (§25); only actual spend is recorded.
    lines.push({ kind: 'video', provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds, resolution: '720p', retryReserve: false });
    lines.push({ kind: 'video', provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds, resolution: '720p', retryReserve: false });
  }
  if (voiceChars) lines.push({ kind: 'tts', provider: 'minimax', model: 'speech-2.8-hd', chars: voiceChars });
  // QA inspections: one per generative scene attempt (×2 for the free repair) + final pass.
  lines.push({ kind: 'llm', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 5_000 * (generative.length * 2 + 1), outputTokens: 800 * (generative.length * 2 + 1) });
  lines.push({ kind: 'media', outputs: 1 });
  return { lines, generative };
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

/** Final QA found a hard defect in the composed exports: the ad cannot be delivered. */
class FinalQaFailure extends Error {}

/** Outage-class failures (§44): transient provider errors after the gateway's own retries, or an open circuit. */
export function isProviderOutage(e: unknown): boolean {
  if (e instanceof ProviderOutage) return true;
  if (e instanceof ProviderError) return e.kind === 'server' || e.kind === 'timeout' || e.kind === 'rate_limit';
  return e instanceof DomainError && e.code === 'UNAVAILABLE';
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
 *    new token (never reserved twice), accepted scene renders and the voice-over are reused, QA attempts already
 *    spent are counted, and stages already passed are not re-entered (§25 idempotent resume, §35, §39).
 *  - A provider outage pauses the project (NEEDS_USER_ACTION + outage) with the reservation held, and it resumes
 *    when the provider recovers; only QA failures may switch technique to the exact-product composite (§44).
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

async function runProduction(ctx: TenantContext, projectId: string, runId: string): Promise<ProduceOutcome> {
  const ws = ctx.workspaceId;
  const load = await withTenant(ws, async (tx) => {
    const p = await getProject(tx, projectId);
    const scenes = (await tx`select * from scenes where storyboard_id = ${p.storyboard_id} order by position`) as unknown as SceneRow[];
    const [sb] = await tx`select * from storyboards where id = ${p.storyboard_id}`;
    const [sku] = await tx`select * from skus where id = ${p.sku_id}`;
    const [fp] = await tx`select * from visual_fingerprints where sku_id = ${p.sku_id} and active`;
    const [variant] = p.variant_id ? await tx`select * from variants where id = ${p.variant_id}` : [null];
    return { p, scenes, sb, sku: sku!, fp, variant };
  });
  const { p, scenes, sb, sku, fp, variant } = load;
  if (!RUNNABLE.includes(p.state as ProjectState) || sb?.status !== 'approved') return 'skipped';
  const unit = (p.entitlement_unit as Exclude<LedgerUnit, 'usd_micros'>) ?? 'taste';
  const voText = scenes.map((s) => s.spoken_line as string | null).filter(Boolean).join(' ');
  const plan = planProduction(scenes, voText.length);
  const purpose = unit === 'creative_test' ? 'creative_test' : unit;
  const heartbeat = () => renewLease(ctx, projectId, runId);

  // 1. Reservation (RENDER_RESERVED). A live reservation from an interrupted or paused run is taken over with a
  //    new token; otherwise (fresh approval, or the sweeper released a stranded one) the entitlement is reserved.
  let auth: { authorizationId: string; token: string };
  try {
    auth = await withTenant(ws, async (tx) => {
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
        const r = await authorize(tx, ctx, { purpose, projectId, lines: plan.lines, entitlement: { unit, amount: 1, periodKey }, idempotencyKey: `produce:${projectId}`, ttlMinutes: AUTH_TTL_MINUTES });
        a = { authorizationId: r.authorizationId, token: r.token };
      }
      const [now] = await tx`select state from projects where id = ${projectId}`;
      if (now!.state === 'STORYBOARD_APPROVED' || now!.state === 'NEEDS_USER_ACTION') {
        await tx`update projects set outage = null where id = ${projectId}`;
        await transition(tx, ctx, projectId, 'RENDER_RESERVED', { patch: { authorization_id: a.authorizationId } });
      } else {
        await tx`update projects set authorization_id = ${a.authorizationId} where id = ${projectId}`;
      }
      await step(tx, ws, projectId, 'prepare', 'done', `${scenes.length} scenes planned`);
      return a;
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'CONFLICT') return 'skipped';
    if (e instanceof DomainError && (e.code === 'PAYMENT_REQUIRED' || e.code === 'GATE_BLOCKED')) {
      await withTenant(ws, (tx) => transition(tx, ctx, projectId, 'NEEDS_USER_ACTION', { reason: e.message }));
      return 'failed';
    }
    // Kill switch / anomaly hold / open circuit before anything was reserved: pause and try again later.
    if (isProviderOutage(e)) return pauseForOutage(ctx, projectId, 'authorize', e, []);
    throw e;
  }

  const checks: CheckResult[] = [];
  try {
    await withTenant(ws, async (tx) => {
      await advance(tx, ctx, projectId, 'RENDERING');
      await step(tx, ws, projectId, 'scenes', 'active');
    });
    const refs = await withTenant(ws, async (tx) => Promise.all(((fp?.reference_asset_ids as string[]) ?? []).slice(0, 2).map((id) => assetBytes(tx, id))));

    await withTempDir(async (dir) => {
      const sceneInputs: (SceneInput & { purpose: string; spoken?: string | null })[] = [];
      let n = 0;
      for (const s of scenes) {
        n++;
        await heartbeat();
        const frameBytes = await withTenant(ws, async (tx) => {
          const [v] = await tx`select asset_id from scene_versions where id = ${s.current_version_id as string}`;
          return v?.asset_id ? assetBytes(tx, v.asset_id as string) : placeholderFrame(s.visual_plan as string, '9x16', n);
        });
        const framePath = path.join(dir, `frame-${n}.png`);
        await writeFile(framePath, frameBytes);
        if (s.purpose === 'cta') {
          sceneInputs.push({ kind: 'still', file: framePath, durationMs: s.duration_ms, overlayText: null, purpose: 'cta' });
          continue;
        }
        const renders = await withTenant(ws, (tx) => tx`select asset_id, status from scene_versions where scene_id = ${s.id} and kind = 'render' order by version`);
        const acceptedRender = renders.filter((r) => r.status === 'accepted').at(-1);
        if (acceptedRender?.asset_id && (s.locked || plan.generative.includes(s.id))) {
          // Locked + already rendered, or accepted by an interrupted run: reuse, never regenerate (§13, §24, §25).
          const f = path.join(dir, `scene-${n}.mp4`);
          await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, acceptedRender.asset_id as string)));
          sceneInputs.push({ kind: 'video', file: f, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null, purpose: s.purpose });
          continue;
        }
        if (!plan.generative.includes(s.id)) {
          sceneInputs.push({ kind: 'still', file: framePath, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null, motion: 'push', purpose: s.purpose });
          continue;
        }
        // Generative scene: render → QA → one free repair → technique switch (§25 retry policy). Attempts already
        // spent by an interrupted run count, so a resume never grants an extra repair.
        let accepted: Buffer | null = null;
        let attempt = renders.filter((r) => r.status === 'qa_failed').length;
        while (!accepted && attempt < 2) {
          attempt++;
          try {
            const vid = await generateVideo({
              ctx,
              token: auth.token,
              task: 'video.scene',
              subject: { type: 'scene', id: s.id },
              prompt: `${s.visual_plan as string}. ${s.product_behavior ?? ''} Keep the product identical to the reference image. Natural adult skin, no retouching, no text.${attempt === 2 ? ' Keep the product fully still and clearly readable; simpler hand motion.' : ''}`,
              references: [`data:image/png;base64,${frameBytes.toString('base64')}`],
              seconds: Math.max(MIN_GEN_SECONDS, Math.ceil(s.duration_ms / 1000)),
              resolution: '720p',
              ratio: '9:16',
              mockLabel: `${s.purpose} · ${(s.visual_plan as string).slice(0, 60)}`,
              heartbeat,
            });
            const res = await qaScene({
              ctx,
              token: auth.token,
              sceneId: s.id,
              sceneText: s.visual_plan as string,
              videoBytes: vid.bytes,
              referenceBytes: refs,
              fingerprint: { labelText: (fp?.label_text as string) ?? null, closure: (fp?.closure as string) ?? null, paletteDistanceMax: 70 },
              planText: s.visual_plan as string,
              attempt,
            });
            const ok = res.every((c) => c.pass);
            await withTenant(ws, async (tx) => {
              const a = await saveAsset(tx, ws, { bytes: vid.bytes, mime: 'video/mp4', kind: 'scene_render', skuId: sku.id as string, source: 'generated', lineage: { sceneId: s.id, attempt, providerJobId: vid.jobId, model: vid.modelVersion, promptVersion: vid.promptVersion } });
              const [v] = await tx`select coalesce(max(version), 0) + 1 as v from scene_versions where scene_id = ${s.id} and kind = 'render'`;
              await tx`insert into scene_versions (workspace_id, scene_id, version, kind, asset_id, technique, model, prompt_version, qa, status)
                       values (${ws}, ${s.id}, ${v!.v}, 'render', ${a.id}, 'generative', ${vid.modelVersion ?? null}, ${vid.promptVersion},
                               ${tx.json(res as never)}, ${ok ? 'accepted' : 'qa_failed'})`;
              await emit(tx, ctx, ok ? 'QA_PASSED' : 'QA_FAILED', { type: 'scene', id: s.id }, { attempt, checks: res.map((c) => ({ check: c.check, pass: c.pass, hard: c.hard })) });
              if (!ok && attempt === 1) {
                await append(tx, ctx, { type: 'FREE_QA_RETRY', unit: 'usd_micros', amount: 0, projectId, authorizationId: auth.authorizationId, idempotencyKey: `qa-retry:${s.id}`, reason: res.find((c) => !c.pass)?.detail ?? 'QA' });
                await step(tx, ws, projectId, 'accuracy', 'active', 'Improving product accuracy');
              }
            });
            checks.push(...res.map((c) => ({ ...c, detail: `Scene ${n}: ${c.detail}` })));
            if (ok) {
              const f = path.join(dir, `scene-${n}.mp4`);
              await writeFile(f, vid.bytes);
              accepted = vid.bytes;
              sceneInputs.push({ kind: 'video', file: f, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null, purpose: s.purpose });
            }
          } catch (e) {
            // Moderation (a policy false positive, §44) is answered like a QA failure: a compliant alternative shot.
            if (e instanceof ProviderError && e.kind === 'moderation') {
              checks.push({ check: 'visual', pass: false, hard: false, detail: `Scene ${n}: provider moderation — using a compliant alternative shot` });
              continue;
            }
            // Outages pause the production; they never degrade the ad to avoid cost (§44, §48).
            if (isProviderOutage(e)) throw new ProviderOutage('video.scene', e);
            throw e;
          }
        }
        if (!accepted) {
          // Repeated QA failure changes technique instead of looping spend (§25): exact product composite.
          sceneInputs.push({ kind: 'still', file: framePath, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null, motion: 'push', purpose: s.purpose });
          await withTenant(ws, (tx) => step(tx, ws, projectId, 'accuracy', 'active', 'Using your exact product photo for this shot'));
          checks.push({ check: 'product_fidelity', pass: true, hard: false, detail: `Scene ${n}: switched to exact product composite after repeated QA failure` });
        }
      }
      await heartbeat();
      await withTenant(ws, async (tx) => {
        await step(tx, ws, projectId, 'scenes', 'done', `${scenes.length} scenes`);
        await advance(tx, ctx, projectId, 'QA_RUNNING');
        await step(tx, ws, projectId, 'accuracy', 'done', 'Product matches your reference photos');
      });

      // Claims check on everything said or shown, before voice is synthesized (Launch Gate 3), per platform the
      // exports are published to (9:16 → TikTok + Reels, 4:5/1:1 → Feed) in the brand's market (§17, §43).
      const lines = [...scenes.flatMap((s) => [s.spoken_line, s.overlay_text]), sb.hook_text, sb.cta_text].filter(Boolean) as string[];
      const claimCheck = await withTenant(ws, (tx) => claimsQaForExports(tx, sku.id as string, lines, ASPECTS));
      checks.push(claimCheck);
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

      // Voice-over (MiniMax → BytePlus fallback), reused if an interrupted run already made this exact one.
      await heartbeat();
      await withTenant(ws, async (tx) => {
        await advance(tx, ctx, projectId, 'COMPOSING');
        await step(tx, ws, projectId, 'voice', 'active');
      });
      let voPath: string | null = null;
      if (voText) {
        // Logical voice from the Brand Brain; the gateway resolves each TTS provider's own voice id.
        const voice = (await withTenant(ws, (tx) => brandBrainFor(tx, sku.id as string)))?.brain.voice ?? DEFAULT_VOICE;
        const textHash = createHash('sha256').update(`${voice}\n${voText}`).digest('hex');
        let voBytes = await withTenant(ws, async (tx) => {
          const [a] = await tx`select id from assets where kind = 'voiceover' and lineage->>'projectId' = ${projectId} and lineage->>'textHash' = ${textHash}
                               order by created_at desc limit 1`;
          return a ? assetBytes(tx, a.id as string) : null;
        });
        if (!voBytes) {
          try {
            const vo = await synthesizeVoice({ ctx, token: auth.token, task: 'tts.voiceover', subject: { type: 'project', id: projectId }, text: voText, voice });
            voBytes = vo.bytes;
            await withTenant(ws, (tx) => saveAsset(tx, ws, { bytes: vo.bytes, mime: 'audio/mpeg', kind: 'voiceover', skuId: sku.id as string, source: 'generated', lineage: { providerJobId: vo.jobId, projectId, textHash } }));
          } catch (e) {
            if (isProviderOutage(e)) throw new ProviderOutage('tts.voiceover', e);
            throw e;
          }
        }
        voPath = path.join(dir, 'vo.mp3');
        await writeFile(voPath, voBytes);
      }
      await withTenant(ws, (tx) => step(tx, ws, projectId, 'voice', 'done', voText ? 'Voice-over and captions added' : 'Captions added'));

      // Composition (deterministic from scene versions, §24) + platform variants.
      await heartbeat();
      await withTenant(ws, async (tx) => {
        await advance(tx, ctx, projectId, 'PLATFORM_VARIANTS');
        await step(tx, ws, projectId, 'platforms', 'active');
      });
      const cta = sceneInputs.find((s) => s.purpose === 'cta');
      const outs = await composeAd(
        {
          scenes: sceneInputs.filter((s) => s.purpose !== 'cta'),
          voiceover: voPath,
          endCard: { productName: sku.name as string, cta: (sb.cta_text as string) ?? 'Shop now', index: `NO. ${String(sku.catalogue_no).padStart(3, '0')}`, durationMs: cta?.durationMs ?? 2000 },
          aspects: ASPECTS,
        },
        dir,
      );

      // Final QA: platform/audio per export + asset integrity + experiment integrity.
      await heartbeat();
      await withTenant(ws, (tx) => advance(tx, ctx, projectId, 'FINAL_QA'));
      const exportAssets: { aspect: Aspect; assetId: string }[] = [];
      for (const o of outs) {
        checks.push(...(await qaExport(o.file, o.aspect, 15000)));
        const bytes = await readFile(o.file);
        const a = await withTenant(ws, (tx) =>
          saveAsset(tx, ws, { bytes, mime: 'video/mp4', kind: 'final_export', skuId: sku.id as string, source: 'composed', lineage: { projectId, aspect: o.aspect, srt: o.srt, storyboardId: sb.id } }),
        );
        exportAssets.push({ aspect: o.aspect, assetId: a.id });
      }
      const integrity = await withTenant(ws, async (tx) => Promise.all(exportAssets.map((e) => verifyAssetIntegrity(tx, e.assetId))));
      checks.push({ check: 'asset_integrity', pass: integrity.every(Boolean), hard: !integrity.every(Boolean), detail: integrity.every(Boolean) ? 'Files stored in our storage; checksums verified' : 'Checksum mismatch' });
      checks.push(
        qaExperimentIntegrity(
          variant ? { changed: variant.changed_variables as string[], heldConstant: variant.held_constant as string[] } : null,
          { changed: variant ? (variant.changed_variables as string[]) : [] },
        ),
      );
      const report = summarize(checks.filter((c) => !(c.check === 'visual' && /provider/.test(c.detail)) || !c.pass));
      const hardFinal = checks.filter((c) => ['platform', 'audio', 'asset_integrity', 'experiment_integrity'].includes(c.check)).some((c) => !c.pass && c.hard);
      if (hardFinal) throw new FinalQaFailure(`Final QA failed: ${checks.filter((c) => !c.pass && c.hard).map((c) => c.detail).join('; ').slice(0, 250)}`);

      // Deliver: creative record with lineage, settle consumed, notify. Only the lease holder may deliver.
      await heartbeat();
      await withTenant(ws, async (tx) => {
        const [concept] = await tx`select proposal from concepts where id = ${p.selected_concept_id}`;
        const proposal = (concept?.proposal ?? {}) as Record<string, unknown>;
        const [cr] = await tx`
          insert into creatives (workspace_id, sku_id, origin, project_id, genome, genome_version, final_asset_ids)
          values (${ws}, ${sku.id}, 'generated', ${projectId},
            ${tx.json({ angle: proposal.angle, hookMechanism: proposal.hookMechanism, proofMechanism: proposal.proofMechanism, treatment: proposal.treatment, hookText: sb.hook_text, durationSec: 15, hasCaptions: true, hasVoiceover: !!voText } as never)},
            1, ${exportAssets.map((e) => e.assetId)})
          returning id`;
        if (p.variant_id) await tx`update variants set creative_id = ${cr!.id} where id = ${p.variant_id}`;
        await tx`update projects set qa_report = ${tx.json({ ...report, pass: true } as never)}, final_creative_id = ${cr!.id} where id = ${projectId}`;
        await step(tx, ws, projectId, 'platforms', 'done', 'TikTok · Reels 9:16 · Feed 4:5 · Square');
        await transition(tx, ctx, projectId, 'COMPLETE');
        await settle(tx, ctx, auth.authorizationId, 'consumed');
        await emit(tx, ctx, 'VARIANT_GENERATED', { type: 'project', id: projectId }, { creativeId: cr!.id, exports: exportAssets });
        await emit(tx, ctx, 'COMPOSITION_COMPLETED', { type: 'project', id: projectId }, {});
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
 * again; a paused one keeps its held reservation).
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
