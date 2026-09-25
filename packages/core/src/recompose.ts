import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTenant, type Tx } from '@arkiv/db';
import { DEFAULT_VOICE, DomainError, platformAssets } from '@arkiv/shared';
import { captionCues, composeAd, layoutVoice, probe, scheduleVoice, withTempDir, type ComposedOutput, type SceneInput, type VoiceClip } from '@arkiv/media';
import { assetBytes, saveAsset, saveCaptions, verifyAssetIntegrity } from './assets';
import { brandBrainFor } from './brand';
import type { LineMapping } from './compliance';
import { diffCompositions, disclosureMetadata, formatPrice, resolveFactTokens, type CompositionManifest, type FactTokens, type VoiceSegment } from './composition';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { authorizeOrTakeOver, settle, type Purpose } from './cost-governor';
import { versionCreative } from './creatives';
import { LEASE_BUSY, withJobLease } from './leases';
import { enqueue, Queues } from './outbox';
import { linkJobOutput, synthesizeVoice } from './model-gateway';
import { ASPECTS, blockedLines, claimsQaForExports, productionRoutes, testimonialCheck, voiceLine, VO_OVERFLOW_TOLERANCE_MS } from './production';
import { step } from './progress';
import { loadRates } from './rates';
import { recordScriptVersion } from './storyboard';
import { currentFacts } from './product-truth';
import { qaExport, type CheckResult } from './qa';
import { factsForStatements, mapStatements, statementCheck } from './statements';

/**
 * Standard §42 "Price changes during production: update overlays/composition without re-generating footage when
 * possible" and §25 "Text/CTA/price/caption-only edit: usually no render charge — recompose without expensive model
 * call". An ad shows the product's price or size through {price} / {size} tokens in its on-screen text and CTA; they
 * are resolved from the current ProductFacts whenever the ad is composed. A production still running picks a change
 * up by itself; a delivered ad is recomposed from its composition manifest — the same accepted renders, frames and
 * voice-over, new on-screen text — with no provider call, and saved as a new version of the creative.
 */

/** The facts an ad can show through tokens, as of now (tenant or explicitly scoped transaction). */
export async function factTokens(tx: Tx, skuId: string): Promise<FactTokens> {
  const facts = await currentFacts(tx, skuId);
  const price = facts.price && !facts.price.disputed ? facts.price.value : null;
  const size = facts.size && !facts.size.disputed ? facts.size.value : null;
  const currency = ((price?.valueJson ?? {}) as { currency?: string }).currency ?? 'USD';
  return {
    price: price && (price.valueNumber != null || price.valueText) ? { factId: price.id, text: price.valueNumber != null ? formatPrice(price.valueNumber, currency) : price.valueText! } : null,
    size: size?.valueText ? { factId: size.id, text: size.valueText } : null,
  };
}

/** Does the manifest show a token whose fact has changed since it was composed? */
export function tokensStale(used: FactTokens | null | undefined, now: FactTokens): boolean {
  if (!used) return false;
  return (['price', 'size'] as const).some((k) => used[k] && (used[k]!.factId !== now[k]?.factId || used[k]!.text !== now[k]?.text));
}

/** The delivered ad's price or size on screen no longer matches the product (shown on delivery, §42). */
export async function priceUpdate(tx: Tx, workspaceId: string, projectId: string): Promise<{ stale: boolean; shown: string | null; current: string | null } | null> {
  const [r] = await tx`select p.sku_id, c.composition from projects p join creatives c on c.id = p.final_creative_id and c.workspace_id = p.workspace_id
                       where p.id = ${projectId} and p.workspace_id = ${workspaceId} and p.state = 'COMPLETE'`;
  const used = (r?.composition as CompositionManifest | null)?.tokens ?? null;
  if (!r || !used) return null;
  const now = await factTokens(tx, r.sku_id as string);
  return { stale: tokensStale(used, now), shown: used.price?.text ?? used.size?.text ?? null, current: (used.price ? now.price?.text : now.size?.text) ?? null };
}

/** Queue a recomposition of every delivered ad of a SKU that shows a fact that just changed. */
export async function queueRecompositions(tx: Tx, workspaceId: string, skuId: string): Promise<number> {
  const rows = await tx`select p.id from projects p join creatives c on c.id = p.final_creative_id and c.workspace_id = p.workspace_id
                        where p.workspace_id = ${workspaceId} and p.sku_id = ${skuId} and p.state = 'COMPLETE' and c.composition ? 'tokens'
                          and c.composition->'tokens' <> 'null'::jsonb`;
  for (const r of rows) await enqueue(tx, workspaceId, Queues.recomposeProject, { projectId: r.id }, { singletonKey: `recompose:${r.id as string}` });
  return rows.length;
}

/** The merchant's "Update my ad": queue the recomposition of one delivered ad whose price or size changed. */
export async function requestRecompose(tx: Tx, ctx: TenantContext, projectId: string): Promise<{ queued: boolean }> {
  assertCan(ctx, 'sku.edit');
  const u = await priceUpdate(tx, ctx.workspaceId, projectId);
  if (!u?.stale) return { queued: false };
  await enqueue(tx, ctx.workspaceId, Queues.recomposeProject, { projectId }, { singletonKey: `recompose:${projectId}` });
  return { queued: true };
}

const recomposeLease = (projectId: string) => `recompose:${projectId}`;

/**
 * Recompose a delivered ad with the product's current price/size (worker `recompose-project`, or the merchant's
 * "Update my ad"). Media only: no provider is called and nothing is charged. The new text passes the claims and
 * statement checks first (a price nothing backs is never shown). Idempotent: an ad already showing the current facts
 * is left alone; one run per project at a time.
 */
export async function recomposeProject(ctx: TenantContext, projectId: string): Promise<'recomposed' | 'unchanged' | 'skipped'> {
  const r = await withJobLease(ctx.workspaceId, recomposeLease(projectId), randomUUID(), 600, () => runRecompose(ctx, projectId));
  return r === LEASE_BUSY ? 'skipped' : r;
}

async function runRecompose(ctx: TenantContext, projectId: string): Promise<'recomposed' | 'unchanged' | 'skipped'> {
  const ws = ctx.workspaceId;
  const data = await loadDelivered(ws, projectId);
  if (!data?.manifest?.tokens) return 'skipped';
  const { p, manifest, tokens } = data;
  const used = manifest.tokens!;
  if (!tokensStale(used, tokens)) return 'unchanged';
  // The voice-over says the old value: recomposing the pictures alone would contradict it (a new line is needed).
  if (manifest.tokensSpoken) return 'skipped';

  // The new composition: the same scenes and voice, the on-screen text re-resolved from the current facts.
  const scenes = manifest.scenes.map((s) => (s.overlayTemplate ? { ...s, overlayText: resolveFactTokens(s.overlayTemplate, tokens) || null } : s));
  const tpl = manifest.endCard.ctaTemplate ?? null;
  const endCard = tpl
    ? { ...manifest.endCard, cta: resolveFactTokens(tpl.replace(/\{price\}/g, ''), tokens) || 'Shop now', price: /\{price\}/.test(tpl) ? (tokens.price?.text ?? null) : (manifest.endCard.price ?? null) }
    : manifest.endCard;
  const next: CompositionManifest = { ...manifest, scenes, endCard, tokens: { price: used.price ? tokens.price : null, size: used.size ? tokens.size : null } };
  const checks = await textChecks(ws, p, next, data.brandName);
  const failing = checks.filter((c) => !c.pass && c.hard);
  if (failing.length) throw new DomainError('GATE_BLOCKED', `The updated ad can’t be made: ${failing.map((c) => c.detail).join('; ').slice(0, 300)}`);
  const r = await saveVersion(ctx, projectId, p, next, checks, { changedVariables: ['offer'], lineage: { recomposed: true } });
  return r ? 'recomposed' : 'unchanged';
}

/** A delivered ad with the composition it was made from (tenant-scoped). */
async function loadDelivered(ws: string, projectId: string) {
  return withTenant(ws, async (tx) => {
    const [p] = await tx`select p.id, p.state, p.sku_id, p.variant_id, p.experiment_id, p.storyboard_id, p.final_creative_id, p.kind, p.entitlement_unit, c.composition, c.genome, s.name as sku_name
                         from projects p join creatives c on c.id = p.final_creative_id and c.workspace_id = p.workspace_id join skus s on s.id = p.sku_id and s.workspace_id = p.workspace_id
                         where p.id = ${projectId} and p.workspace_id = ${ws}`;
    if (!p || p.state !== 'COMPLETE') return null;
    return { p, manifest: p.composition as CompositionManifest | null, tokens: await factTokens(tx, p.sku_id as string), brandName: (await brandBrainFor(tx, p.sku_id as string))?.name ?? null };
  });
}

/** Every line a composition says or shows (scenes, CTA, price line, the end card's spoken line). */
export function manifestLines(m: CompositionManifest): string[] {
  return [...m.scenes.flatMap((s) => [s.spokenText, s.overlayText]), m.endCard.cta, m.endCard.price, m.endCard.spokenText].filter((l): l is string => !!l);
}

/** Claims, testimonial and statement checks on what a composition says (§25 check 3, §40, Launch Gate 2). */
async function manifestTextChecks(tx: Tx, ws: string, skuId: string, names: (string | null)[], next: CompositionManifest): Promise<CheckResult[]> {
  const lines = manifestLines(next);
  const claims = await claimsQaForExports(tx, skuId, lines, ASPECTS, { names });
  const statements = statementCheck(mapStatements(lines, ((claims.data as { mapping?: LineMapping[] } | undefined)?.mapping ?? []) as LineMapping[], await factsForStatements(tx, skuId)));
  // §40: a scene showing an AI-generated person never speaks as a customer, whatever the new words.
  const rows = await tx`select id, production_mode, shows_human_skin from scenes where workspace_id = ${ws} and id = any(${next.scenes.map((s) => s.sceneId)}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const testimonials = testimonialCheck(
    next.scenes.map((s) => ({ production_mode: (byId.get(s.sceneId)?.production_mode as string | undefined) ?? null, shows_human_skin: !!byId.get(s.sceneId)?.shows_human_skin, spoken_line: s.spokenText, overlay_text: s.overlayText })),
  );
  return [claims, statements, ...(testimonials ? [testimonials] : [])];
}

async function textChecks(ws: string, p: Record<string, unknown>, next: CompositionManifest, brandName: string | null): Promise<CheckResult[]> {
  return withTenant(ws, (tx) => manifestTextChecks(tx, ws, p.sku_id as string, [p.sku_name as string, brandName], next));
}

/**
 * Compose a composition manifest into its exports (§24 "composition is reproducible from scene versions"): the
 * stored scene assets, the voice clips laid out as recorded, the captions and end card — no provider call.
 */
export async function composeFromManifest(ws: string, m: CompositionManifest, dir: string): Promise<ComposedOutput[]> {
  const inputs: SceneInput[] = [];
  for (const [i, s] of m.scenes.entries()) {
    if (!s.assetId) throw new DomainError('CONFLICT', 'This ad was made before recomposition was possible.');
    const f = path.join(dir, `s${i}.${s.kind === 'video' ? 'mp4' : 'png'}`);
    await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, s.assetId!)));
    inputs.push({ kind: s.kind, file: f, durationMs: s.durationMs, overlayText: s.overlayText, motion: 'push' });
  }
  let voPath: string | null = null;
  const segs = m.voiceover?.segments ?? [];
  if (segs.length) {
    const clips: VoiceClip[] = [];
    for (const [i, s] of segs.entries()) {
      const f = path.join(dir, `vo-${i}.mp3`);
      await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, s.clipAssetId)));
      clips.push({ file: f, startMs: s.startMs, tempo: s.tempo });
    }
    voPath = path.join(dir, 'vo.wav');
    await layoutVoice(clips, m.durationMs, voPath);
  }
  const e = m.endCard;
  const card = { productName: e.productName, cta: e.cta, index: e.index, durationMs: e.durationMs, accent: e.accent ?? null, note: e.note ?? null, price: e.price ?? null };
  const out = path.join(dir, 'out');
  await mkdir(out, { recursive: true });
  return composeAd({ scenes: inputs, voiceover: voPath, captions: m.captions, endCard: card, aspects: m.aspects, metadata: disclosureMetadata(m.disclosure ?? { aiGenerated: false, syntheticPeople: false, syntheticVoice: false, generatedScenes: [] }) }, out);
}

/**
 * Compose `next`, pass final QA and store it as a new version of the delivered creative (exports, SRT, creative row,
 * project and variant pointers). Null when the ad moved on meanwhile (another version was saved first).
 */
async function saveVersion(
  ctx: TenantContext,
  projectId: string,
  p: Record<string, unknown>,
  next: CompositionManifest,
  checks: CheckResult[],
  opts: { changedVariables: string[]; lineage: Record<string, unknown>; after?: (tx: Tx, creativeId: string) => Promise<void> },
): Promise<string | null> {
  const ws = ctx.workspaceId;
  return withTempDir(async (dir) => {
    const outs = await composeFromManifest(ws, next, dir);
    for (const o of outs) checks.push(...(await qaExport(o.file, o.aspect, next.durationMs)));
    const bad = checks.filter((c) => !c.pass && c.hard);
    if (bad.length) throw new Error(`recomposition failed final QA: ${bad.map((c) => c.detail).join('; ').slice(0, 300)}`);
    return withTenant(ws, async (tx) => {
      // Another run finished first (or the ad moved on): nothing to do.
      const [cur] = await tx`select final_creative_id from projects where id = ${projectId} and workspace_id = ${ws} for update`;
      if (cur?.final_creative_id !== p.final_creative_id) return null;
      const captions = await saveCaptions(tx, ws, p.sku_id as string, outs[0]!.srt, { projectId, storyboardId: p.storyboard_id, ...opts.lineage });
      const exported: { aspect: string; assetId: string }[] = [];
      for (const o of outs) {
        const a = await saveAsset(tx, ws, { bytes: await readFile(o.file), mime: 'video/mp4', kind: 'final_export', skuId: p.sku_id as string, source: 'composed', lineage: { projectId, aspect: o.aspect, srt: o.srt, captionsAssetId: captions.id, storyboardId: p.storyboard_id, disclosure: next.disclosure, ...opts.lineage } });
        exported.push({ aspect: o.aspect, assetId: a.id });
      }
      if (!(await Promise.all([...exported.map((e) => e.assetId), captions.id].map((id) => verifyAssetIntegrity(tx, id)))).every(Boolean)) throw new Error('recomposition: checksum mismatch');
      const creativeId = await versionCreative(tx, ctx, {
        skuId: p.sku_id as string,
        parentCreativeId: p.final_creative_id as string,
        projectId,
        genome: p.genome as Record<string, unknown>,
        finalAssetIds: exported.map((e) => e.assetId),
        composition: next,
        changedVariables: opts.changedVariables,
        experimentId: (p.experiment_id as string | null) ?? null,
        variantId: (p.variant_id as string | null) ?? null,
        storyboardId: (p.storyboard_id as string | null) ?? null,
        captionsAssetId: captions.id,
      });
      await tx`update projects set final_creative_id = ${creativeId} where id = ${projectId} and workspace_id = ${ws}`;
      if (p.variant_id) await tx`update variants set creative_id = ${creativeId}, platform_assets = ${tx.json(platformAssets(exported) as never)} where id = ${p.variant_id as string} and workspace_id = ${ws}`;
      await opts.after?.(tx, creativeId);
      return creativeId;
    });
  });
}

// ───────────── Text / CTA / caption edits of a delivered ad (standard §25 retry policy) ─────────────

/** A merchant's edit of a delivered ad's words: per scene (spoken line, on-screen text) and the CTA. */
export interface TextEdits {
  scenes?: { sceneId: string; spokenLine?: string | null; overlayText?: string | null }[];
  cta?: string | null;
}

const LIMITS = { spoken: 160, overlay: 70, cta: 40 };
export const TEXT_EDIT_STEP = 'text_edit';
const clean = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();

/** The manifest with the edits applied (words only: scenes, timing and footage are unchanged). */
export function applyTextEdits(m: CompositionManifest, edits: TextEdits): { next: CompositionManifest; spoken: Map<string, string | null>; changed: boolean } {
  const byId = new Map((edits.scenes ?? []).map((e) => [e.sceneId, e]));
  const known = new Set([...m.scenes.map((s) => s.sceneId), ...(m.endCard.sceneId ? [m.endCard.sceneId] : [])]);
  for (const id of byId.keys()) if (!known.has(id)) throw new DomainError('INVALID', 'That scene isn’t part of this ad.');
  const spoken = new Map<string, string | null>();
  let changed = false;
  const scenes = m.scenes.map((s) => {
    const e = byId.get(s.sceneId);
    if (!e) return s;
    const out = { ...s };
    if (e.overlayText !== undefined) {
      const t = clean(e.overlayText).slice(0, LIMITS.overlay) || null;
      if (t !== s.overlayText) {
        out.overlayText = t;
        delete out.overlayTemplate;
        changed = true;
      }
    }
    if (e.spokenLine !== undefined) {
      const t = clean(e.spokenLine).slice(0, LIMITS.spoken) || null;
      if (t !== s.spokenText) {
        out.spokenText = t;
        spoken.set(s.sceneId, t);
        changed = true;
      }
    }
    return out;
  });
  let endCard = m.endCard;
  const cardEdit = m.endCard.sceneId ? byId.get(m.endCard.sceneId) : undefined;
  if (cardEdit?.spokenLine !== undefined) {
    const t = clean(cardEdit.spokenLine).slice(0, LIMITS.spoken) || null;
    if (t !== m.endCard.spokenText) {
      endCard = { ...endCard, spokenText: t };
      spoken.set(m.endCard.sceneId!, t);
      changed = true;
    }
  }
  if (edits.cta !== undefined && edits.cta !== null) {
    const t = clean(edits.cta).slice(0, LIMITS.cta);
    if (!t) throw new DomainError('INVALID', 'The call to action can’t be empty.');
    if (t !== m.endCard.cta) {
      endCard = { ...endCard, cta: t, ctaTemplate: null };
      changed = true;
    }
  }
  return { next: { ...m, scenes, endCard }, spoken, changed };
}

/**
 * The merchant edits a delivered ad's words (standard §25 retry policy "Text/CTA/price/caption-only edit | Usually no
 * render charge | Recompose without expensive model call"): checked now — claims, facts and testimonial rules, so a
 * line that would be refused never queues — then recomposed by the `recompose-project` job from the same footage.
 * No entitlement is used; a changed spoken line costs one short voice-over line under the ad's own cost ceiling.
 * An experiment's ad isn't edited here: its variants are built from it, and changing it would confound the test.
 */
export async function requestTextEdit(tx: Tx, ctx: TenantContext, projectId: string, edits: TextEdits): Promise<{ queued: boolean; revoiced: number }> {
  assertCan(ctx, 'sku.edit');
  const [p] = await tx`select p.id, p.state, p.sku_id, p.experiment_id, p.storyboard_id, p.final_creative_id, c.composition, s.name as sku_name
                       from projects p join creatives c on c.id = p.final_creative_id and c.workspace_id = p.workspace_id join skus s on s.id = p.sku_id and s.workspace_id = p.workspace_id
                       where p.id = ${projectId} and p.workspace_id = ${ctx.workspaceId} for update of p`;
  if (!p || p.state !== 'COMPLETE') throw new DomainError('CONFLICT', 'You can edit your ad once it’s ready.');
  if (p.experiment_id) throw new DomainError('CONFLICT', 'This ad is part of a test: its variants are built from it, so its words stay as they are. Start a new test to try other words.');
  const manifest = p.composition as CompositionManifest | null;
  if (!manifest?.scenes?.length || manifest.scenes.some((s) => !s.assetId)) throw new DomainError('CONFLICT', 'This ad was made before it could be edited.');
  const { next, spoken, changed } = applyTextEdits(manifest, edits);
  if (!changed) return { queued: false, revoiced: 0 };
  const [running] = await tx`select 1 from progress_steps where workspace_id = ${ctx.workspaceId} and subject_id = ${projectId} and step_key = ${TEXT_EDIT_STEP}
                             and status in ('pending', 'active') and started_at > now() - interval '15 minutes'`;
  if (running) throw new DomainError('CONFLICT', 'Your last change is still being made. Try again in a minute.');
  const checks = await manifestTextChecks(tx, ctx.workspaceId, p.sku_id as string, [p.sku_name as string, (await brandBrainFor(tx, p.sku_id as string))?.name ?? null], next);
  if (checks.some((c) => !c.pass && c.hard)) {
    const lines = blockedLines({ checks });
    throw new DomainError('GATE_BLOCKED', `“${lines[0]?.line ?? 'A line'}” can’t be used: ${lines[0]?.reason ?? checks.find((c) => !c.pass)?.detail ?? ''}`, { lines });
  }
  await tx`insert into progress_steps (workspace_id, subject_id, step_key, label, status, started_at, position)
           values (${ctx.workspaceId}, ${projectId}, ${TEXT_EDIT_STEP}, 'Updating your ad', 'pending', now(), 0)
           on conflict (workspace_id, subject_id, step_key) do update set status = 'pending', detail = null, started_at = now(), completed_at = null`;
  const key = createHash('sha256').update(JSON.stringify([p.final_creative_id, edits])).digest('hex').slice(0, 16);
  await enqueue(tx, ctx.workspaceId, Queues.recomposeProject, { projectId, edits, baseCreativeId: p.final_creative_id, actor: ctx.actor }, { singletonKey: `recompose-edit:${projectId}:${key}` });
  return { queued: true, revoiced: spoken.size };
}

/**
 * Worker half of requestTextEdit: re-voice only the changed spoken lines (one short TTS call each, through the Cost
 * Governor under the ad's own purpose and ceiling, no entitlement), fit every line back into its scene, rebuild the
 * captions and recompose. The scenes keep their footage; each edited scene gets a new script version (§24).
 */
export async function applyDeliveredTextEdit(ctx: TenantContext, projectId: string, edits: TextEdits, baseCreativeId: string | null): Promise<'recomposed' | 'unchanged' | 'skipped'> {
  const ws = ctx.workspaceId;
  const run = async (): Promise<'recomposed' | 'unchanged' | 'skipped'> => {
    const data = await loadDelivered(ws, projectId);
    if (!data?.manifest) return 'skipped';
    // The ad changed since the edit was asked for (another edit or a price update): the edit is made on what the
    // merchant saw, never silently onto something else.
    if (baseCreativeId && data.p.final_creative_id !== baseCreativeId) {
      await withTenant(ws, (tx) => step(tx, ws, projectId, TEXT_EDIT_STEP, 'failed', 'Your ad changed while this edit waited. Make the change again.'));
      return 'unchanged';
    }
    await withTenant(ws, (tx) => step(tx, ws, projectId, TEXT_EDIT_STEP, 'active', null, 'Updating your ad'));
    try {
      const { p, manifest } = data;
      const applied = applyTextEdits(manifest, edits);
      if (!applied.changed) {
        await withTenant(ws, (tx) => step(tx, ws, projectId, TEXT_EDIT_STEP, 'done', 'Nothing to change'));
        return 'unchanged';
      }
      const next = await withTempDir((dir) => revoice(ctx, projectId, p, manifest, applied.next, applied.spoken, dir));
      const checks = await textChecks(ws, p, next, data.brandName);
      const failing = checks.filter((c) => !c.pass && c.hard);
      if (failing.length) throw new DomainError('GATE_BLOCKED', `The updated ad can’t be made: ${failing.map((c) => c.detail).join('; ').slice(0, 300)}`);
      const changedVariables = diffCompositions(manifest, next);
      const editedIds = new Set((edits.scenes ?? []).map((e) => e.sceneId));
      const cardId = next.endCard.sceneId;
      const creativeId = await saveVersion(ctx, projectId, p, next, checks, {
        changedVariables: changedVariables.length ? changedVariables : ['copy'],
        lineage: { textEdit: true },
        after: async (tx, creativeId) => {
          // The storyboard follows the delivered ad's words, each edited scene with a new script version (§24).
          for (const s of next.scenes) {
            if (!editedIds.has(s.sceneId)) continue;
            await tx`update scenes set spoken_line = ${s.spokenText}, overlay_text = ${s.overlayText} where id = ${s.sceneId} and workspace_id = ${ws}`;
            await recordScriptVersion(tx, ws, s.sceneId, 'delivered_edit', { creativeId });
          }
          if (cardId && editedIds.has(cardId)) {
            await tx`update scenes set spoken_line = ${next.endCard.spokenText} where id = ${cardId} and workspace_id = ${ws}`;
            await recordScriptVersion(tx, ws, cardId, 'delivered_edit', { creativeId });
          }
          if (next.endCard.cta !== manifest.endCard.cta && p.storyboard_id) await tx`update storyboards set cta_text = ${next.endCard.cta} where id = ${p.storyboard_id} and workspace_id = ${ws}`;
          const hook = next.scenes[0];
          if (hook && editedIds.has(hook.sceneId) && p.storyboard_id) {
            const text = hook.spokenText ?? hook.overlayText;
            if (text) await tx`update storyboards set hook_text = ${text.slice(0, 90)} where id = ${p.storyboard_id} and workspace_id = ${ws}`;
          }
          await step(tx, ws, projectId, TEXT_EDIT_STEP, 'done', 'Your ad is updated');
        },
      });
      return creativeId ? 'recomposed' : 'unchanged';
    } catch (e) {
      const expected = e instanceof DomainError && ['GATE_BLOCKED', 'CONFLICT', 'INVALID', 'PAYMENT_REQUIRED'].includes(e.code);
      await withTenant(ws, (tx) => step(tx, ws, projectId, TEXT_EDIT_STEP, 'failed', expected ? (e as Error).message : 'We couldn’t update your ad just now. Nothing was charged — please try again.'));
      if (expected) return 'skipped';
      throw e;
    }
  };
  const r = await withJobLease(ws, recomposeLease(projectId), randomUUID(), 600, run);
  return r === LEASE_BUSY ? 'skipped' : r;
}

/** New voice clips for the changed spoken lines, and every line fitted back into its scene. */
async function revoice(ctx: TenantContext, projectId: string, p: Record<string, unknown>, base: CompositionManifest, next: CompositionManifest, spoken: Map<string, string | null>, dir: string): Promise<CompositionManifest> {
  if (!spoken.size) return next;
  const ws = ctx.workspaceId;
  const voice = base.voiceover?.voice ?? DEFAULT_VOICE;
  // Timeline windows: body scenes in order, then the end card.
  const windows = new Map<string, { startMs: number; endMs: number }>();
  let t0 = 0;
  for (const s of next.scenes) {
    windows.set(s.sceneId, { startMs: t0, endMs: t0 + s.durationMs });
    t0 += s.durationMs;
  }
  if (next.endCard.sceneId) windows.set(next.endCard.sceneId, { startMs: t0, endMs: t0 + next.endCard.durationMs });
  const old = new Map((base.voiceover?.segments ?? []).map((sg) => [sg.sceneId, sg]));
  const order = [...next.scenes.map((s) => ({ sceneId: s.sceneId, text: s.spokenText })), ...(next.endCard.sceneId ? [{ sceneId: next.endCard.sceneId, text: next.endCard.spokenText }] : [])];
  const unit = ((p.entitlement_unit as string | null) ?? (p.kind as string)) as Purpose;
  const purpose: Purpose = ['taste', 'standalone', 'creative_test'].includes(unit) ? unit : 'standalone';
  const speakers: { sceneId: string; text: string; clipAssetId: string; clipMs: number }[] = [];
  for (const [i, o] of order.entries()) {
    if (!o.text) continue;
    let clipAssetId: string;
    if (spoken.has(o.sceneId)) clipAssetId = await editClip(ctx, projectId, p.sku_id as string, o.sceneId, o.text, voice, purpose);
    else {
      const prev = old.get(o.sceneId);
      if (!prev) continue;
      clipAssetId = prev.clipAssetId;
    }
    const f = path.join(dir, `clip-${i}.mp3`);
    await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, clipAssetId)));
    speakers.push({ sceneId: o.sceneId, text: o.text, clipAssetId, clipMs: (await probe(f)).durationMs });
  }
  const schedule = scheduleVoice(speakers.map((sp) => ({ windowStartMs: windows.get(sp.sceneId)!.startMs, windowEndMs: windows.get(sp.sceneId)!.endMs, clipMs: sp.clipMs })), next.durationMs);
  if (schedule.overflowMs > VO_OVERFLOW_TOLERANCE_MS) throw new DomainError('INVALID', 'The new line is too long to fit its scene. Try a shorter line.');
  const segments: VoiceSegment[] = speakers.map((sp, i) => ({ sceneId: sp.sceneId, text: sp.text, clipAssetId: sp.clipAssetId, ...schedule.placed[i]! }));
  const captions = segments.flatMap((sg) => captionCues(sg.text, sg.startMs, sg.endMs));
  const disclosure = next.disclosure ? { ...next.disclosure, syntheticVoice: segments.length > 0, aiGenerated: next.disclosure.aiGenerated || segments.length > 0 } : next.disclosure;
  return { ...next, voiceover: segments.length ? { voice, segments } : null, captions, disclosure };
}

/** One edited spoken line's voice clip: reused when already voiced, else one short TTS call through the Cost Governor. */
async function editClip(ctx: TenantContext, projectId: string, skuId: string, sceneId: string, text: string, voice: string, purpose: Purpose): Promise<string> {
  const ws = ctx.workspaceId;
  const textHash = createHash('sha256').update(`${voice}\n${text}`).digest('hex');
  const [existing] = await withTenant(ws, (tx) => tx`select id from assets where workspace_id = ${ws} and kind = 'voiceover' and lineage->>'projectId' = ${projectId}
                                                      and lineage->>'sceneId' = ${sceneId} and lineage->>'textHash' = ${textHash} order by created_at desc limit 1`);
  if (existing) return existing.id as string;
  const auth = await withTenant(ws, async (tx) =>
    authorizeOrTakeOver(tx, ctx, { purpose, projectId, lines: [voiceLine(await productionRoutes(tx, ws), await loadRates(tx), text.length)], idempotencyKey: `edit-vo:${projectId}:${sceneId}:${textHash.slice(0, 16)}` }, 15),
  );
  try {
    const vo = await synthesizeVoice({ ctx, token: auth.token, task: 'tts.voiceover', subject: { type: 'scene', id: sceneId }, inputRefs: { projectId, sceneId, textHash, edit: true }, text, voice: voice as never });
    return await withTenant(ws, async (tx) => {
      const a = await saveAsset(tx, ws, { bytes: vo.bytes, mime: 'audio/mpeg', kind: 'voiceover', skuId, source: 'generated', lineage: { providerJobId: vo.jobId, provider: vo.provider, task: vo.task, projectId, sceneId, textHash, edit: true } });
      await linkJobOutput(tx, ws, vo.jobId, a.id);
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      return a.id;
    });
  } catch (e) {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
    throw e;
  }
}
