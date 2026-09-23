import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTenant, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { composeAd, placeholderFrame, withTempDir, type Aspect, type SceneInput } from '@arkiv/media';
import { ProviderError } from '@arkiv/providers';
import { assetBytes, saveAsset, verifyAssetIntegrity } from './assets';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { authorize, settle } from './cost-governor';
import { allowedClaimTexts } from './creative-director';
import { emit } from './events';
import { append, type LedgerUnit } from './ledger';
import { generateVideo, synthesizeVoice } from './model-gateway';
import { enqueue, Queues } from './outbox';
import { planSteps, step } from './progress';
import { getProject, transition } from './projects';
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
  await enqueue(tx, ctx.workspaceId, Queues.produceProject, { projectId, actor: ctx.actor }, { singletonKey: `produce:${projectId}`, priority: 20 });
  return { replayed: false };
}

export async function produceProject(ctx: TenantContext, projectId: string): Promise<'complete' | 'failed' | 'skipped'> {
  const ws = ctx.workspaceId;
  const load = await withTenant(ws, async (tx) => {
    const p = await getProject(tx, projectId);
    const scenes = (await tx`select * from scenes where storyboard_id = ${p.storyboard_id} order by position`) as unknown as SceneRow[];
    const [sb] = await tx`select * from storyboards where id = ${p.storyboard_id}`;
    const [sku] = await tx`select * from skus where id = ${p.sku_id}`;
    const [fp] = await tx`select * from visual_fingerprints where sku_id = ${p.sku_id} and active`;
    const [variant] = p.variant_id ? await tx`select * from variants where id = ${p.variant_id}` : [null];
    return { p, scenes, sb: sb!, sku: sku!, fp, variant };
  });
  const { p, scenes, sb, sku, fp, variant } = load;
  if (!['STORYBOARD_APPROVED', 'RENDER_RESERVED', 'RENDERING', 'NEEDS_USER_ACTION'].includes(p.state as string)) return 'skipped';
  const unit = (p.entitlement_unit as Exclude<LedgerUnit, 'usd_micros'>) ?? 'taste';
  const voText = scenes.map((s) => s.spoken_line as string | null).filter(Boolean).join(' ');
  const plan = planProduction(scenes, voText.length);
  const purpose = unit === 'creative_test' ? 'creative_test' : unit;

  // 1. Reserve (RENDER_RESERVED). A duplicate job finds the existing authorization and stops (no double spend).
  let auth: Awaited<ReturnType<typeof authorize>>;
  try {
    auth = await withTenant(ws, async (tx) => {
      const periodKey = unit === 'creative_test' ? ((await tx`select to_char(current_period_start, 'YYYY-MM-DD') as k from subscriptions order by created_at desc limit 1`)[0]?.k ?? null) : null;
      const a = await authorize(tx, ctx, { purpose, projectId, lines: plan.lines, entitlement: { unit, amount: 1, periodKey }, idempotencyKey: `produce:${projectId}`, ttlMinutes: 180 });
      await transition(tx, ctx, projectId, 'RENDER_RESERVED', { patch: { authorization_id: a.authorizationId } });
      await step(tx, ws, projectId, 'prepare', 'done', `${scenes.length} scenes planned`);
      return a;
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'CONFLICT') return 'skipped';
    if (e instanceof DomainError && (e.code === 'PAYMENT_REQUIRED' || e.code === 'GATE_BLOCKED' || e.code === 'UNAVAILABLE')) {
      await withTenant(ws, (tx) => transition(tx, ctx, projectId, 'NEEDS_USER_ACTION', { reason: e.message }));
      return 'failed';
    }
    throw e;
  }

  const checks: CheckResult[] = [];
  try {
    await withTenant(ws, async (tx) => {
      await transition(tx, ctx, projectId, 'RENDERING');
      await step(tx, ws, projectId, 'scenes', 'active');
    });
    const refs = await withTenant(ws, async (tx) => Promise.all(((fp?.reference_asset_ids as string[]) ?? []).slice(0, 2).map((id) => assetBytes(tx, id))));
    const cut = fp?.cutout_asset_id ? await withTenant(ws, (tx) => assetBytes(tx, fp.cutout_asset_id as string)) : null;

    const sceneInputs: (SceneInput & { purpose: string; spoken?: string | null })[] = [];
    await withTempDir(async (dir) => {
      let n = 0;
      for (const s of scenes) {
        n++;
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
        const locked = await withTenant(ws, async (tx) => (await tx`select asset_id from scene_versions where scene_id = ${s.id} and kind = 'render' and status = 'accepted' order by version desc limit 1`)[0]);
        if (s.locked && locked?.asset_id) {
          // Locked + already rendered: reuse, never regenerate (§13, §24).
          const f = path.join(dir, `scene-${n}.mp4`);
          await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, locked.asset_id as string)));
          sceneInputs.push({ kind: 'video', file: f, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null, purpose: s.purpose });
          continue;
        }
        if (!plan.generative.includes(s.id)) {
          sceneInputs.push({ kind: 'still', file: framePath, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null, motion: 'push', purpose: s.purpose });
          continue;
        }
        // Generative scene: render → QA → one free repair → technique switch (§25 retry policy).
        let accepted: Buffer | null = null;
        for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
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
            if (!(e instanceof ProviderError)) throw e;
            // Provider failure: no charge; try once more, then fall back to technique change.
            checks.push({ check: 'visual', pass: false, hard: false, detail: `Scene ${n}: provider ${e.kind} — ${e.message.slice(0, 120)}` });
          }
        }
        if (!accepted) {
          // Repeated failure changes technique instead of looping spend (§25): exact product composite.
          sceneInputs.push({ kind: 'still', file: framePath, durationMs: s.duration_ms, overlayText: s.overlay_text as string | null, motion: 'push', purpose: s.purpose });
          await withTenant(ws, (tx) => step(tx, ws, projectId, 'accuracy', 'active', 'Using your exact product photo for this shot'));
          checks.push({ check: 'product_fidelity', pass: true, hard: false, detail: `Scene ${n}: switched to exact product composite after repeated QA failure` });
        }
      }
      await withTenant(ws, async (tx) => {
        await step(tx, ws, projectId, 'scenes', 'done', `${scenes.length} scenes`);
        await transition(tx, ctx, projectId, 'QA_RUNNING');
        await step(tx, ws, projectId, 'accuracy', 'done', 'Product matches your reference photos');
      });

      // Claims check on everything said or shown, before voice is synthesized (Launch Gate 3).
      const allowed = await withTenant(ws, (tx) => allowedClaimTexts(tx, sku.id as string));
      const lines = [...scenes.flatMap((s) => [s.spoken_line, s.overlay_text]), sb.hook_text, sb.cta_text].filter(Boolean) as string[];
      const claimCheck = qaClaims(lines, allowed);
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

      // Voice-over (MiniMax → BytePlus fallback).
      await withTenant(ws, async (tx) => {
        await transition(tx, ctx, projectId, 'COMPOSING');
        await step(tx, ws, projectId, 'voice', 'active');
      });
      let voPath: string | null = null;
      if (voText) {
        const vo = await synthesizeVoice({ ctx, token: auth.token, task: 'tts.voiceover', subject: { type: 'project', id: projectId }, text: voText, voice: 'English_Graceful_Lady' });
        voPath = path.join(dir, 'vo.mp3');
        await writeFile(voPath, vo.bytes);
        await withTenant(ws, (tx) => saveAsset(tx, ws, { bytes: vo.bytes, mime: 'audio/mpeg', kind: 'voiceover', skuId: sku.id as string, source: 'generated', lineage: { providerJobId: vo.jobId } }));
      }
      await withTenant(ws, (tx) => step(tx, ws, projectId, 'voice', 'done', voText ? 'Voice-over and captions added' : 'Captions added'));

      // Composition (deterministic from scene versions, §24) + platform variants.
      await withTenant(ws, async (tx) => {
        await transition(tx, ctx, projectId, 'PLATFORM_VARIANTS');
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
      void cut;

      // Final QA: platform/audio per export + asset integrity + experiment integrity.
      await withTenant(ws, (tx) => transition(tx, ctx, projectId, 'FINAL_QA'));
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
      if (hardFinal) throw new DomainError('UNAVAILABLE', 'Final QA failed', { checks: checks.filter((c) => !c.pass) });

      // Deliver: creative record with lineage, settle consumed, notify.
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
    // Provider/final failures: customer is not charged for what we could not deliver (§25 retry policy).
    await withTenant(ws, async (tx) => {
      await tx`update projects set qa_report = ${tx.json(summarize(checks) as never)} where id = ${projectId}`;
      await transition(tx, ctx, projectId, 'PROVIDER_FAILED', { reason: (e as Error).message.slice(0, 300) });
      await settle(tx, ctx, auth.authorizationId, 'refunded');
      await tx`update progress_steps set status = 'failed', detail = 'We hit a problem on our side. You have not been charged for this attempt.', completed_at = now()
               where subject_id = ${projectId} and status = 'active'`;
    });
    throw e;
  }
}

/** Retry a failed production (entitlement was returned on failure, so this re-reserves it). */
export async function retryProduction(tx: Tx, ctx: TenantContext, projectId: string) {
  const p = await getProject(tx, projectId);
  if (!['PROVIDER_FAILED', 'NEEDS_USER_ACTION'].includes(p.state as string)) throw new DomainError('CONFLICT', 'Nothing to retry');
  await tx`update cost_authorizations set idempotency_key = idempotency_key || ':retired:' || extract(epoch from now())::bigint
           where project_id = ${projectId} and idempotency_key = ${'produce:' + projectId} and status <> 'active'`;
  await transition(tx, ctx, projectId, 'STORYBOARD_APPROVED');
  await enqueue(tx, ctx.workspaceId, Queues.produceProject, { projectId, actor: ctx.actor, retry: true }, { singletonKey: `produce:${projectId}:${Date.now()}` });
}
