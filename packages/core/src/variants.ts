import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTenant } from '@arkiv/db';
import { platformsFor } from '@arkiv/shared';
import { captionCues, composeAd, layoutVoice, probe, withTempDir, type SceneInput, type VoiceClip } from '@arkiv/media';
import { assetBytes, saveAsset } from './assets';
import { brandBrainFor } from './brand';
import { scanCreativeText, scanPasses } from './compliance';
import { diffCompositions, type CompositionManifest, type VoiceSegment } from './composition';
import type { TenantContext } from './context';
import { authorizeOrTakeOver, settle } from './cost-governor';
import { allowedClaimTexts } from './creative-director';
import { emit } from './events';
import { setExperimentState } from './experiments';
import { synthesizeVoice } from './model-gateway';
import { ASPECTS, productionRoutes, voiceLine } from './production';
import { qaExperimentIntegrity, qaExport, type CheckResult } from './qa';
import { loadRates } from './rates';

/** Hook variants ship every export the master does (plan 06 Phase 3 #6: 9:16 / 4:5 / 1:1). */
const VARIANT_ASPECTS = ASPECTS;
/** Fastest a new spoken hook may be delivered to fit the master's hook slot. */
const HOOK_MAX_TEMPO = 1.35;
const HOOK_GAP_MS = 80;

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Economical hook variants (§5 Creative Test definition): built from the master's composition manifest — the
 * same footage, the same voice-over for every scene after the hook, the same end card, every export — changing
 * only the opening hook. A spoken hook is re-voiced (one short line, alternate voice copy per §5) and spliced
 * into the master's hook slot; a visual-only hook reuses the master voice-over untouched. Experiment integrity
 * (§25 check 6) compares the two manifests, so a variant that changed anything it promised to hold constant is
 * never shipped (§20 CONTROLLED).
 */
export async function produceHookVariants(ctx: TenantContext, projectId: string): Promise<number> {
  const ws = ctx.workspaceId;
  const data = await withTenant(ws, async (tx) => {
    const [p] = await tx`select * from projects where id = ${projectId}`;
    if (!p?.experiment_id || p.state !== 'COMPLETE') return null;
    const hookVariants = await tx`select * from variants where experiment_id = ${p.experiment_id} and role = 'variant'
                                  and project_id is null and creative_id is null order by code`;
    const [master] = p.final_creative_id ? await tx`select composition from creatives where id = ${p.final_creative_id}` : [];
    const [sb] = await tx`select hook_text from storyboards where id = ${p.storyboard_id}`;
    const [sku] = await tx`select name from skus where id = ${p.sku_id}`;
    const brand = await brandBrainFor(tx, p.sku_id as string);
    const allowed = await allowedClaimTexts(tx, p.sku_id as string, { platforms: platformsFor(VARIANT_ASPECTS) });
    return { p, hookVariants, manifest: (master?.composition ?? null) as CompositionManifest | null, hookText: (sb?.hook_text as string | null) ?? null, names: [sku?.name as string, brand?.name ?? null], allowed };
  });
  if (!data || !data.hookVariants.length) return 0;
  const { p, manifest } = data;
  if (!manifest?.scenes.length) {
    // Without the master's composition nothing can be held constant: no variant rather than a confounded one.
    await withTenant(ws, (tx) => setExperimentState(tx, ctx, p.experiment_id as string, 'READY_TO_RUN', 'hook variants unavailable: master has no composition record'));
    return 0;
  }
  const hookScene = manifest.scenes[0]!;
  const segments = manifest.voiceover?.segments ?? [];
  const hookSeg = segments.find((s) => s.sceneId === hookScene.sceneId) ?? null;
  // The hook is spoken when the opening scene's line *is* the storyboard hook; otherwise it is visual-only.
  const spokenHook = !!hookSeg && !!data.hookText && norm(hookSeg.text) === norm(data.hookText);
  const nextStart = segments.filter((s) => s !== hookSeg && s.startMs >= (hookSeg?.startMs ?? 0)).reduce((m, s) => Math.min(m, s.startMs), Infinity);
  const hookRoomEnd = Math.min(hookSeg ? hookSeg.startMs + hookScene.durationMs : 0, nextStart - HOOK_GAP_MS);

  let made = 0;
  for (const v of data.hookVariants) {
    const hook = (v.label as string).trim();
    // Never ship a hook that makes a claim the vault doesn't cover on every platform it's exported to.
    if (!scanPasses(scanCreativeText([hook], data.allowed, { names: data.names }))) {
      await withTenant(ws, (tx) => emit(tx, ctx, 'VARIANT_SKIPPED', { type: 'variant', id: v.id as string }, { reason: 'hook failed claims check' }));
      continue;
    }
    const ok = await withTempDir(async (dir) => {
      // 1. The new spoken hook (if the hook is spoken), fitted into the master's hook slot.
      let newSeg: VoiceSegment | null = null;
      if (spokenHook && hookSeg) {
        const clip = await hookClip(ctx, v.id as string, hook, manifest.voiceover!.voice, p.sku_id as string, projectId);
        const file = path.join(dir, 'hook.mp3');
        await writeFile(file, clip.bytes);
        const ms = (await probe(file)).durationMs;
        const room = hookRoomEnd - hookSeg.startMs;
        const tempo = ms > room ? ms / Math.max(1, room) : 1;
        if (tempo > HOOK_MAX_TEMPO) {
          await withTenant(ws, (tx) => emit(tx, ctx, 'VARIANT_SKIPPED', { type: 'variant', id: v.id as string }, { reason: 'spoken hook too long to keep the rest of the voice-over unchanged' }));
          return false;
        }
        newSeg = { sceneId: hookSeg.sceneId, text: hook, clipAssetId: clip.id, startMs: hookSeg.startMs, endMs: Math.round(hookSeg.startMs + ms / tempo), tempo: Math.round(tempo * 10_000) / 10_000 };
      }
      // 2. The variant's manifest: the master's, with only the hook changed.
      const variantManifest: CompositionManifest = {
        ...manifest,
        scenes: [{ ...hookScene, overlayText: hook.slice(0, 60), spokenText: newSeg ? hook : hookScene.spokenText }, ...manifest.scenes.slice(1)],
        voiceover: manifest.voiceover && newSeg ? { ...manifest.voiceover, segments: segments.map((s) => (s === hookSeg ? newSeg! : s)) } : manifest.voiceover,
        captions: newSeg ? [...captionCues(hook, newSeg.startMs, newSeg.endMs), ...manifest.captions.filter((c) => !(c.startMs >= hookSeg!.startMs && c.endMs <= hookSeg!.endMs))].sort((a, b) => a.startMs - b.startMs) : manifest.captions,
        aspects: VARIANT_ASPECTS,
      };
      const changed = diffCompositions(manifest, variantManifest);
      const integrity = qaExperimentIntegrity({ changed: (v.changed_variables as string[]) ?? ['hook'], heldConstant: (v.held_constant as string[]) ?? [] }, { changed });
      if (!integrity.pass) {
        await withTenant(ws, (tx) => emit(tx, ctx, 'VARIANT_SKIPPED', { type: 'variant', id: v.id as string }, { reason: integrity.detail }));
        return false;
      }
      // 3. Compose from the master's exact assets.
      const inputs: SceneInput[] = [];
      for (const [i, s] of variantManifest.scenes.entries()) {
        if (!s.assetId) return false;
        const f = path.join(dir, `s${i}.${s.kind === 'video' ? 'mp4' : 'png'}`);
        await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, s.assetId!)));
        inputs.push({ kind: s.kind, file: f, durationMs: s.durationMs, overlayText: s.overlayText, motion: 'push' });
      }
      let voPath: string | null = null;
      const segs = variantManifest.voiceover?.segments ?? [];
      if (segs.length) {
        const clips: VoiceClip[] = [];
        for (const [i, s] of segs.entries()) {
          const f = path.join(dir, `vo-${i}.mp3`);
          await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, s.clipAssetId)));
          clips.push({ file: f, startMs: s.startMs, tempo: s.tempo });
        }
        voPath = path.join(dir, 'vo.wav');
        await layoutVoice(clips, variantManifest.durationMs, voPath);
      }
      const e = variantManifest.endCard;
      const endCard = { productName: e.productName, cta: e.cta, index: e.index, durationMs: e.durationMs };
      const outs = await composeAd({ scenes: inputs, voiceover: voPath, captions: variantManifest.captions, endCard, aspects: VARIANT_ASPECTS }, dir);
      const checks: CheckResult[] = [integrity];
      for (const o of outs) checks.push(...(await qaExport(o.file, o.aspect, variantManifest.durationMs)));
      if (checks.some((c) => !c.pass && c.hard)) {
        await withTenant(ws, (tx) => emit(tx, ctx, 'VARIANT_SKIPPED', { type: 'variant', id: v.id as string }, { reason: checks.filter((c) => !c.pass && c.hard).map((c) => c.detail).join('; ').slice(0, 300) }));
        return false;
      }
      await withTenant(ws, async (tx) => {
        const ids: string[] = [];
        for (const o of outs) {
          const a = await saveAsset(tx, ws, { bytes: await readFile(o.file), mime: 'video/mp4', kind: 'final_export', skuId: p.sku_id as string, source: 'composed', lineage: { projectId, variantId: v.id, aspect: o.aspect, srt: o.srt, changed } });
          ids.push(a.id);
        }
        const [cr] = await tx`insert into creatives (workspace_id, sku_id, origin, parent_creative_id, project_id, genome, genome_version, final_asset_ids, composition)
                              values (${ws}, ${p.sku_id}, 'generated', ${p.final_creative_id}, ${projectId}, ${tx.json({ ...(v.genes as object), hookText: hook } as never)}, 1, ${ids},
                                      ${tx.json(variantManifest as never)})
                              returning id`;
        await tx`update variants set creative_id = ${cr!.id} where id = ${v.id}`;
        await emit(tx, ctx, 'VARIANT_GENERATED', { type: 'variant', id: v.id as string }, { changed, creativeId: cr!.id, integrity: integrity.detail });
      });
      return true;
    });
    if (ok) made++;
  }
  await withTenant(ws, (tx) => setExperimentState(tx, ctx, p.experiment_id as string, 'READY_TO_RUN', 'variants ready'));
  return made;
}

/**
 * The spoken hook for one variant: reused if already voiced, else one short TTS call under its own Cost Governor
 * authorization (no Creative Test is consumed: hook variants are part of the test, §5).
 */
async function hookClip(ctx: TenantContext, variantId: string, text: string, voice: string, skuId: string, projectId: string): Promise<{ id: string; bytes: Buffer }> {
  const ws = ctx.workspaceId;
  const textHash = createHash('sha256').update(`${voice}\n${text}`).digest('hex');
  const existing = await withTenant(ws, async (tx) => {
    const [a] = await tx`select id from assets where kind = 'voiceover' and lineage->>'variantId' = ${variantId} and lineage->>'textHash' = ${textHash}
                         order by created_at desc limit 1`;
    return a ? { id: a.id as string, bytes: await assetBytes(tx, a.id as string) } : null;
  });
  if (existing) return existing;
  const auth = await withTenant(ws, async (tx) =>
    authorizeOrTakeOver(tx, ctx, { purpose: 'creative_test', projectId, lines: [voiceLine(await productionRoutes(tx, ws), await loadRates(tx), text.length)], idempotencyKey: `hook-vo:${variantId}:${textHash.slice(0, 16)}` }, 15),
  );
  try {
    const vo = await synthesizeVoice({ ctx, token: auth.token, task: 'tts.voiceover', subject: { type: 'variant', id: variantId }, text, voice: voice as never });
    return await withTenant(ws, async (tx) => {
      const a = await saveAsset(tx, ws, { bytes: vo.bytes, mime: 'audio/mpeg', kind: 'voiceover', skuId, source: 'generated', lineage: { providerJobId: vo.jobId, provider: vo.provider, task: vo.task, projectId, variantId, textHash } });
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      return { id: a.id, bytes: vo.bytes };
    });
  } catch (e) {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
    throw e;
  }
}
