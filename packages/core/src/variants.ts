import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, platformAssets, platformsFor } from '@arkiv/shared';
import { captionCues, composeAd, COMPOSER_VERSION, layoutVoice, probe, withTempDir, type SceneInput, type VoiceClip } from '@arkiv/media';
import { raiseAlert } from './alerts';
import { assetBytes, saveAsset, saveCaptions } from './assets';
import { brandBrainFor } from './brand';
import { scanCreativeText, scanPasses } from './compliance';
import { diffCompositions, disclosureMetadata, type CompositionManifest, type VoiceSegment } from './composition';
import type { TenantContext } from './context';
import { authorizeOrTakeOver, settle } from './cost-governor';
import { versionCreative } from './creatives';
import { allowedClaimTexts } from './creative-director';
import { emit } from './events';
import { setExperimentState } from './experiments';
import { LEASE_BUSY, renewJobLease, withJobLease } from './leases';
import { linkJobOutput, synthesizeVoice } from './model-gateway';
import { bonusHookDue } from './offers';
import { enqueue, Queues } from './outbox';
import { ASPECTS, productionRoutes, voiceLine } from './production';
import { qaExperimentIntegrity, qaExport, qaVoiceTrack, type CheckResult } from './qa';
import { loadRates } from './rates';

/** Hook variants ship every export the master does (plan 06 Phase 3 #6: 9:16 / 4:5 / 1:1). */
const VARIANT_ASPECTS = ASPECTS;
/** Fastest a new spoken hook may be delivered to fit the master's hook slot. */
const HOOK_MAX_TEMPO = 1.35;
const HOOK_GAP_MS = 80;

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Object refs shared by a hook variant's events (the master project's experiment and SKU). */
const variantRefs = (p: Record<string, unknown>) => ({ experimentId: p.experiment_id as string, skuId: p.sku_id as string, projectId: p.id as string, storyboardId: p.storyboard_id as string | null });

/** A run's lease on a project's hook variants; renewed per variant, so a crashed run's lease lapses quickly. */
export const VARIANTS_LEASE_SECONDS = 300;
const variantsLease = (projectId: string) => `variants:${projectId}`;

/**
 * Economical hook variants (§5 Creative Test definition): built from the master's composition manifest — the
 * same footage, the same voice-over for every scene after the hook, the same end card, every export — changing
 * only the opening hook. A spoken hook is re-voiced (one short line, alternate voice copy per §5) and spliced
 * into the master's hook slot; a visual-only hook reuses the master voice-over untouched. Experiment integrity
 * (§25 check 6) compares the two manifests, so a variant that changed anything it promised to hold constant is
 * never shipped (§20 CONTROLLED). Each variant is recorded as a new version of the master (CREATIVE_VERSIONED).
 *
 * Worker (`hook-variants`). One run per project at a time (§35 "every transition must be idempotent"): a
 * duplicate or overlapping delivery — a pg-boss retry after the job's expiry while the first run is still going,
 * or a staff retry — stands down and re-checks later instead of composing the same variants again. Each variant
 * is claimed when its creative is written (`creative_id is null`), so a variant can never get two creatives.
 */
export async function produceHookVariants(ctx: TenantContext, projectId: string): Promise<number> {
  const holder = randomUUID();
  const r = await withJobLease(ctx.workspaceId, variantsLease(projectId), holder, VARIANTS_LEASE_SECONDS, () => runHookVariants(ctx, projectId, holder));
  if (r !== LEASE_BUSY) return r;
  // Another run holds the lease: look again once it has had time to finish (or its lease has lapsed after a
  // crash). The follow-up finds finished variants already claimed and makes only what is still missing.
  await withTenant(ctx.workspaceId, (tx) =>
    enqueue(tx, ctx.workspaceId, Queues.hookVariants, { projectId }, { singletonKey: `variants:${projectId}:recheck`, runAfter: new Date(Date.now() + VARIANTS_LEASE_SECONDS * 1000) }),
  );
  return 0;
}

/** A hook version built from a master's manifest, ready to be saved (or why it can't be made). */
type HookBuild =
  | { ok: true; outs: { aspect: string; file: string; srt?: string }[]; manifest: CompositionManifest; changed: string[]; integrity: CheckResult }
  | { ok: false; reason: string };

/** What a hook version is built from: the master's composition and what the new hook must pass. */
interface HookSource {
  projectId: string;
  skuId: string;
  manifest: CompositionManifest;
  /** The storyboard's hook text (the opening line when the hook is spoken). */
  hookText: string | null;
  names: (string | null)[];
  allowed: Awaited<ReturnType<typeof allowedClaimTexts>>;
}

/**
 * Build one economical hook version (§5 Creative Test definition) in `dir`: the master's footage, voice-over after
 * the hook and end card, every export — only the opening hook changes. A spoken hook is re-voiced (one short TTS
 * line) and fitted into the master's hook slot; a visual-only hook reuses the master voice-over untouched.
 * Experiment integrity (§25 check 6) compares the two manifests, and every export passes export QA; anything else
 * is refused with the reason, never shipped.
 */
async function buildHookVersion(
  ctx: TenantContext,
  dir: string,
  src: HookSource,
  hook: string,
  voiceRef: { variantId?: string; bonusFor?: string },
  intended: { changed: string[]; heldConstant: string[] },
): Promise<HookBuild> {
  const ws = ctx.workspaceId;
  const { manifest } = src;
  // Never ship a hook that makes a claim the vault doesn't cover on every platform it's exported to.
  if (!scanPasses(scanCreativeText([hook], src.allowed, { names: src.names }))) return { ok: false, reason: 'hook failed claims check' };
  const hookScene = manifest.scenes[0]!;
  const segments = manifest.voiceover?.segments ?? [];
  const hookSeg = segments.find((s) => s.sceneId === hookScene.sceneId) ?? null;
  // The hook is spoken when the opening scene's line *is* the storyboard hook; otherwise it is visual-only.
  const spokenHook = !!hookSeg && !!src.hookText && norm(hookSeg.text) === norm(src.hookText);
  const nextStart = segments.filter((s) => s !== hookSeg && s.startMs >= (hookSeg?.startMs ?? 0)).reduce((m, s) => Math.min(m, s.startMs), Infinity);
  const hookRoomEnd = Math.min(hookSeg ? hookSeg.startMs + hookScene.durationMs : 0, nextStart - HOOK_GAP_MS);
  // 1. The new spoken hook (if the hook is spoken), fitted into the master's hook slot.
  let newSeg: VoiceSegment | null = null;
  if (spokenHook && hookSeg) {
    let clip: { id: string; bytes: Buffer };
    try {
      clip = await hookClip(ctx, voiceRef, hook, manifest.voiceover!.voice, src.skuId, src.projectId);
    } catch (e) {
      // The Cost Governor refused it: this voice-over would take the test past its cost ceiling (§5). Skipped,
      // never produced over budget.
      if (e instanceof DomainError && e.code === 'GATE_BLOCKED') return { ok: false, reason: 'the test’s cost ceiling is reached' };
      throw e;
    }
    const file = path.join(dir, 'hook.mp3');
    await writeFile(file, clip.bytes);
    const ms = (await probe(file)).durationMs;
    const room = hookRoomEnd - hookSeg.startMs;
    const tempo = ms > room ? ms / Math.max(1, room) : 1;
    if (tempo > HOOK_MAX_TEMPO) return { ok: false, reason: 'spoken hook too long to keep the rest of the voice-over unchanged' };
    newSeg = { sceneId: hookSeg.sceneId, text: hook, clipAssetId: clip.id, startMs: hookSeg.startMs, endMs: Math.round(hookSeg.startMs + ms / tempo), tempo: Math.round(tempo * 10_000) / 10_000 };
  }
  // 2. The version's manifest: the master's, with only the hook changed.
  const versionManifest: CompositionManifest = {
    ...manifest,
    scenes: [{ ...hookScene, overlayText: hook.slice(0, 60), spokenText: newSeg ? hook : hookScene.spokenText }, ...manifest.scenes.slice(1)],
    voiceover: manifest.voiceover && newSeg ? { ...manifest.voiceover, segments: segments.map((s) => (s === hookSeg ? newSeg! : s)) } : manifest.voiceover,
    captions: newSeg ? [...captionCues(hook, newSeg.startMs, newSeg.endMs), ...manifest.captions.filter((c) => !(c.startMs >= hookSeg!.startMs && c.endMs <= hookSeg!.endMs))].sort((a, b) => a.startMs - b.startMs) : manifest.captions,
    aspects: VARIANT_ASPECTS,
    composer: COMPOSER_VERSION,
  };
  const changed = diffCompositions(manifest, versionManifest);
  const integrity = qaExperimentIntegrity(intended, { changed });
  if (!integrity.pass) return { ok: false, reason: integrity.detail };
  // 3. Compose from the master's exact assets.
  const inputs: SceneInput[] = [];
  for (const [i, s] of versionManifest.scenes.entries()) {
    if (!s.assetId) return { ok: false, reason: 'a master scene has no stored asset' };
    const f = path.join(dir, `s${i}.${s.kind === 'video' ? 'mp4' : 'png'}`);
    await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, s.assetId!)));
    inputs.push({ kind: s.kind, file: f, durationMs: s.durationMs, overlayText: s.overlayText, motion: 'push' });
  }
  let voPath: string | null = null;
  const segs = versionManifest.voiceover?.segments ?? [];
  if (segs.length) {
    const clips: VoiceClip[] = [];
    for (const [i, s] of segs.entries()) {
      const f = path.join(dir, `vo-${i}.mp3`);
      await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, s.clipAssetId)));
      clips.push({ file: f, startMs: s.startMs, tempo: s.tempo });
    }
    voPath = path.join(dir, 'vo.wav');
    await layoutVoice(clips, versionManifest.durationMs, voPath);
  }
  const e = versionManifest.endCard;
  const endCard = { productName: e.productName, cta: e.cta, index: e.index, durationMs: e.durationMs, accent: e.accent ?? null, note: e.note ?? null };
  // The version is the master's footage with a re-voiced hook: it carries the master's AI-content disclosure (§40).
  const outs = await composeAd({ scenes: inputs, voiceover: voPath, captions: versionManifest.captions, endCard, aspects: VARIANT_ASPECTS, metadata: disclosureMetadata(versionManifest.disclosure) }, dir);
  const checks: CheckResult[] = [integrity];
  for (const o of outs) checks.push(...(await qaExport(o.file, o.aspect, versionManifest.durationMs, o.layout)));
  checks.push(await qaVoiceTrack(outs[0]!.file, versionManifest.voiceover?.segments ?? [], outs[0]!.srt));
  if (checks.some((c) => !c.pass && c.hard)) return { ok: false, reason: checks.filter((c) => !c.pass && c.hard).map((c) => c.detail).join('; ').slice(0, 300) };
  return { ok: true, outs, manifest: versionManifest, changed, integrity };
}

async function runHookVariants(ctx: TenantContext, projectId: string, holder: string): Promise<number> {
  const ws = ctx.workspaceId;
  const data = await withTenant(ws, async (tx) => {
    const [p] = await tx`select * from projects where id = ${projectId}`;
    if (!p || p.state !== 'COMPLETE') return null;
    const hookVariants = p.experiment_id
      ? await tx`select * from variants where experiment_id = ${p.experiment_id} and role = 'variant' and project_id is null and creative_id is null order by code`
      : [];
    const [master] = p.final_creative_id ? await tx`select composition from creatives where id = ${p.final_creative_id}` : [];
    const [sb] = await tx`select hook_text from storyboards where id = ${p.storyboard_id}`;
    const [sku] = await tx`select name from skus where id = ${p.sku_id}`;
    const brand = await brandBrainFor(tx, p.sku_id as string);
    const allowed = await allowedClaimTexts(tx, p.sku_id as string, { platforms: platformsFor(VARIANT_ASPECTS) });
    return { p, hookVariants, manifest: (master?.composition ?? null) as CompositionManifest | null, hookText: (sb?.hook_text as string | null) ?? null, names: [sku?.name as string, brand?.name ?? null], allowed };
  });
  if (!data) return 0;
  const { p, manifest } = data;
  // A one-off ad: its offer's bonus alternate hook, if it has one due (standard §7/§8).
  if (!p.experiment_id) return manifest?.scenes.length ? runBonusHook(ctx, projectId, holder, { projectId, skuId: p.sku_id as string, manifest, hookText: data.hookText, names: data.names, allowed: data.allowed }) : 0;
  if (!data.hookVariants.length) return 0;
  if (!manifest?.scenes.length) {
    // Without the master's composition nothing can be held constant: no variant rather than a confounded one.
    await withTenant(ws, (tx) => settleExperiment(tx, ctx, p.experiment_id as string, 'hook variants unavailable: master has no composition record'));
    return 0;
  }
  const src: HookSource = { projectId, skuId: p.sku_id as string, manifest, hookText: data.hookText, names: data.names, allowed: data.allowed };

  let made = 0;
  for (const v of data.hookVariants) {
    // Lease lost (this run stalled past its lease): the run that took over finishes the job.
    if (!(await renewJobLease(ws, variantsLease(projectId), holder, VARIANTS_LEASE_SECONDS))) return made;
    const [still] = await withTenant(ws, (tx) => tx`select creative_id from variants where id = ${v.id}`);
    if (!still || still.creative_id) continue; // made by an earlier run since we listed it
    const hook = (v.label as string).trim();
    const ok = await withTempDir(async (dir) => {
      const built = await buildHookVersion(ctx, dir, src, hook, { variantId: v.id as string }, { changed: (v.changed_variables as string[]) ?? ['hook'], heldConstant: (v.held_constant as string[]) ?? [] });
      if (!built.ok) {
        await withTenant(ws, (tx) => emit(tx, ctx, 'VARIANT_SKIPPED', { type: 'variant', id: v.id as string }, { reason: built.reason }, variantRefs(p)));
        return false;
      }
      return withTenant(ws, async (tx) => {
        // Claim the variant first: an overlapping run that got here before us wins, and we write nothing.
        const [cur] = await tx`select creative_id from variants where id = ${v.id} for update`;
        if (!cur || cur.creative_id) return false;
        const { ids, exported, captionsAssetId } = await saveHookExports(tx, ctx, p, built, { variantId: v.id as string });
        const creativeId = await versionCreative(tx, ctx, {
          skuId: p.sku_id as string,
          parentCreativeId: p.final_creative_id as string,
          projectId,
          genome: { ...(v.genes as object), hookText: hook },
          finalAssetIds: ids,
          composition: built.manifest,
          changedVariables: built.changed.length ? built.changed : ['hook'],
          experimentId: p.experiment_id as string,
          variantId: v.id as string,
          storyboardId: (p.storyboard_id as string | null) ?? null,
          captionsAssetId,
        });
        const [claimed] = await tx`update variants set creative_id = ${creativeId}, platform_assets = ${tx.json(platformAssets(exported) as never)} where id = ${v.id} and creative_id is null returning id`;
        if (!claimed) throw new Error(`variant ${v.id as string} was claimed concurrently`); // rolls back the creative and its assets
        await emit(tx, ctx, 'VARIANT_GENERATED', { type: 'variant', id: v.id as string }, { changed: built.changed, creativeId, integrity: built.integrity.detail }, { ...variantRefs(p), creativeId });
        return true;
      });
    });
    if (ok) made++;
  }
  await withTenant(ws, (tx) => settleExperiment(tx, ctx, p.experiment_id as string, 'variants ready'));
  return made;
}

/** Store a built hook version's exports (one final_export asset per aspect). */
async function saveHookExports(tx: Tx, ctx: TenantContext, p: Record<string, unknown>, built: Extract<HookBuild, { ok: true }>, lineage: { variantId?: string; bonusFor?: string }) {
  const ids: string[] = [];
  const exported: { aspect: string; assetId: string }[] = [];
  const srt = built.outs.find((o) => o.srt)?.srt ?? null;
  const captions = srt ? await saveCaptions(tx, ctx.workspaceId, p.sku_id as string, srt, { projectId: p.id, ...lineage }) : null;
  // The version's provenance (§25.7): the master export's (same footage, authorization and rates), with this
  // version's voice clips, claims and composer.
  const [master] = p.final_creative_id
    ? await tx`select a.lineage->'provenance' as pv from creatives c join assets a on a.id = c.final_asset_ids[1] and a.workspace_id = c.workspace_id
               where c.id = ${p.final_creative_id as string} and c.workspace_id = ${ctx.workspaceId}`
    : [];
  const m = built.manifest;
  const provenance = master?.pv
    ? { ...(master.pv as object), claimIds: [...new Set(m.scenes.flatMap((x) => x.claimIds ?? []))], voiceClipIds: (m.voiceover?.segments ?? []).map((sg) => sg.clipAssetId), composer: COMPOSER_VERSION }
    : null;
  for (const o of built.outs) {
    const a = await saveAsset(tx, ctx.workspaceId, { bytes: await readFile(o.file), mime: 'video/mp4', kind: 'final_export', skuId: p.sku_id as string, source: 'composed', lineage: { projectId: p.id, ...lineage, aspect: o.aspect, srt: o.srt, captionsAssetId: captions?.id ?? null, changed: built.changed, ...(provenance ? { provenance } : {}) } });
    ids.push(a.id);
    exported.push({ aspect: o.aspect, assetId: a.id });
  }
  return { ids, exported, captionsAssetId: captions?.id ?? null };
}

// ───────────── Offer bonus: an alternate opening hook (standard §7 bonus entitlements, §8) ─────────────

/**
 * The alternate opening hook an offer promised (§8 "any low-COGS bonus such as an alternate opening hook"): the
 * chosen concept's next hook option, built exactly like an experiment's hook variant (same footage, one re-voiced
 * line, integrity and export QA) and delivered with the ad as a version of it. Its voice-over counts toward the
 * same Creative Test cost ceiling. When it can't be made, staff are alerted to make good on the promise.
 */
async function runBonusHook(ctx: TenantContext, projectId: string, holder: string, src: HookSource): Promise<number> {
  const ws = ctx.workspaceId;
  const plan = await withTenant(ws, async (tx) => {
    if (!(await bonusHookDue(tx, projectId))) return null;
    const [c] = await tx`select c.proposal from projects p join concepts c on c.id = p.selected_concept_id and c.workspace_id = p.workspace_id where p.id = ${projectId}`;
    const options = ((c?.proposal as { hookOptions?: string[] } | undefined)?.hookOptions ?? []).map((h) => h.trim()).filter(Boolean);
    return { hook: options.find((h) => norm(h) !== norm(src.hookText)) ?? null };
  });
  if (!plan) return 0;
  if (!(await renewJobLease(ws, variantsLease(projectId), holder, VARIANTS_LEASE_SECONDS))) return 0;
  const notDelivered = (why: string) =>
    withTenant(ws, async (tx) => {
      await tx`update projects set bonus_hook_failed_at = now() where id = ${projectId} and workspace_id = ${ws} and bonus_hook_creative_id is null`;
      await raiseAlert(tx, {
        kind: 'offer.bonus_not_delivered',
        severity: 'risk',
        subject: { type: 'project', id: projectId },
        message: `The alternate opening hook this ad’s offer promised couldn’t be made: ${why}. Make it by hand or make good with the customer.`,
        details: { workspaceId: ws, projectId, why },
      });
    });
  if (!plan.hook) {
    await notDelivered('the concept has no other hook option');
    return 0;
  }
  const hook = plan.hook;
  const made = await withTempDir(async (dir) => {
    const built = await buildHookVersion(ctx, dir, src, hook, { bonusFor: projectId }, { changed: ['hook'], heldConstant: [...BONUS_HELD] });
    if (!built.ok) {
      await notDelivered(built.reason);
      return false;
    }
    return withTenant(ws, async (tx) => {
      const [p] = await tx`select * from projects where id = ${projectId} for update`;
      if (!p || p.bonus_hook_creative_id) return false; // delivered by an overlapping run
      const { ids, captionsAssetId } = await saveHookExports(tx, ctx, p, built, { bonusFor: projectId });
      const creativeId = await versionCreative(tx, ctx, {
        skuId: p.sku_id as string,
        parentCreativeId: p.final_creative_id as string,
        projectId,
        genome: { hookText: hook, bonus: 'alternate_hook' },
        finalAssetIds: ids,
        composition: built.manifest,
        changedVariables: built.changed.length ? built.changed : ['hook'],
        storyboardId: (p.storyboard_id as string | null) ?? null,
        captionsAssetId,
      });
      // Delivered with the ad: the delivery page lists it beside the master's exports.
      await tx`update projects set bonus_hook_creative_id = ${creativeId} where id = ${projectId} and workspace_id = ${ws}`;
      return true;
    });
  });
  return made ? 1 : 0;
}

/** What a bonus hook holds constant (everything but the opening line). */
const BONUS_HELD = ['body', 'offer', 'cta', 'product', 'duration', 'scenes_2_plus', 'voiceover'] as const;

/**
 * Production is over: the test is READY_TO_RUN when at least two of its variants (master, hook variants, control)
 * have a creative to compare; with fewer — every hook variant refused by experiment integrity (§25 check 6) — it
 * can't isolate anything and is INVALIDATED (§35) rather than launched as a one-ad "test".
 */
async function settleExperiment(tx: Tx, ctx: TenantContext, experimentId: string, reason: string) {
  // A system transition (the job may carry the approving merchant as its actor): never refused as a user move.
  const sys = { workspaceId: ctx.workspaceId, actor: { kind: 'system' as const, id: 'hook-variants' } };
  const [n] = await tx`select count(*)::int as n from variants where experiment_id = ${experimentId} and creative_id is not null`;
  if (Number(n!.n) >= 2) await setExperimentState(tx, sys, experimentId, 'READY_TO_RUN', reason);
  else await setExperimentState(tx, sys, experimentId, 'INVALIDATED', `no comparable variant was produced (${reason})`);
}

/**
 * The spoken hook for one variant (or an offer's bonus hook): reused if already voiced, else one short TTS call
 * under its own Cost Governor authorization (no Creative Test is consumed: hook variants are part of the test, §5).
 */
async function hookClip(ctx: TenantContext, ref: { variantId?: string; bonusFor?: string }, text: string, voice: string, skuId: string, projectId: string): Promise<{ id: string; bytes: Buffer }> {
  const ws = ctx.workspaceId;
  const textHash = createHash('sha256').update(`${voice}\n${text}`).digest('hex');
  const lineageKey = ref.variantId ? 'variantId' : 'bonusFor';
  const refId = (ref.variantId ?? ref.bonusFor)!;
  const existing = await withTenant(ws, async (tx) => {
    const [a] = await tx`select id from assets where kind = 'voiceover' and lineage->>${lineageKey} = ${refId} and lineage->>'textHash' = ${textHash}
                         order by created_at desc limit 1`;
    return a ? { id: a.id as string, bytes: await assetBytes(tx, a.id as string) } : null;
  });
  if (existing) return existing;
  const idem = ref.variantId ? `hook-vo:${ref.variantId}:${textHash.slice(0, 16)}` : `bonus-hook-vo:${refId}:${textHash.slice(0, 16)}`;
  const auth = await withTenant(ws, async (tx) =>
    authorizeOrTakeOver(tx, ctx, { purpose: 'creative_test', projectId, lines: [voiceLine(await productionRoutes(tx, ws), await loadRates(tx), text.length)], idempotencyKey: idem }, 15),
  );
  try {
    const subject = ref.variantId ? { type: 'variant', id: ref.variantId } : { type: 'project', id: refId };
    const vo = await synthesizeVoice({ ctx, token: auth.token, task: 'tts.voiceover', subject, inputRefs: { projectId, [lineageKey]: refId, textHash }, text, voice: voice as never });
    return await withTenant(ws, async (tx) => {
      const a = await saveAsset(tx, ws, { bytes: vo.bytes, mime: 'audio/mpeg', kind: 'voiceover', skuId, source: 'generated', lineage: { providerJobId: vo.jobId, provider: vo.provider, task: vo.task, projectId, [lineageKey]: refId, textHash } });
      await linkJobOutput(tx, ws, vo.jobId, a.id);
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      return { id: a.id, bytes: vo.bytes };
    });
  } catch (e) {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
    throw e;
  }
}
