import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, FREE_EXPLORATION } from '@arkiv/shared';
import { compositeProduct, productionBackdrop } from '@arkiv/media';
import { assetBytes, saveAsset } from './assets';
import { assertCan } from './authz';
import { brandBrainFor } from './brand';
import { classifyClaim, isFirstPersonTestimonial, scanCreativeText, showsSyntheticPeople, SYNTHETIC_TESTIMONIAL_REASON, type LineMapping } from './compliance';
import { CLEAN_PHOTO_TIP, exactProductFrame, productImagery } from './composite';
import type { TenantContext } from './context';
import { cutoutState, segmentCutout, wantsSegmentation } from './cutout';
import { authorize, authorizeOrTakeOver, settle } from './cost-governor';
import { allowedClaimTexts, planStoryboard } from './creative-director';
import { emit } from './events';
import { projectVisitor, recordFunnel } from './funnel';
import type { StoryboardPlan } from './intel-schemas';
import { CUTOUT_TASK, generateImage, routedLines } from './model-gateway';
import { currentQuote, issueTasteOffer } from './offers';
import { enqueue, isFreeTier, priorityFor, queueFor, Queues } from './outbox';
import { planSteps, step } from './progress';
import { planStoryboardScenes, sceneClaimIds } from './production';
import { transition } from './projects';
import { qaClaims } from './qa';
import { ensureVariantImage, referenceAssetIds } from './sku-variants';
import { stockState } from './stock';
import { toDataUrl } from './vision';

const FRAME = { width: 1080, height: 1920 };
const MAX_GENERATED_FRAMES = 2;
const FREE_FRAME_REGENERATIONS = 3;

export const STORYBOARD_STEPS = [
  { key: 'plan', label: 'Writing the storyboard' },
  { key: 'claims', label: 'Checking every line against your claims' },
  { key: 'frames', label: 'Developing frames' },
];

/** Select a concept (requires an account: storyboard is behind the save gate, standard §8). */
export async function selectConcept(tx: Tx, ctx: TenantContext, projectId: string, conceptId: string) {
  assertCan(ctx, 'sku.edit');
  if (ctx.workspaceState === 'PROVISIONAL') throw new DomainError('FORBIDDEN', 'Save your work to see the storyboard.', { needsAccount: true });
  const [c] = await tx`select id, sku_id from concepts where id = ${conceptId} and project_id = ${projectId}`;
  if (!c) throw new DomainError('NOT_FOUND', 'Concept not found');
  const [p] = await tx`select state, storyboard_id, selected_concept_id from projects where id = ${projectId} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  if (p.selected_concept_id === conceptId && p.storyboard_id) return { storyboardId: p.storyboard_id as string, replayed: true };
  if (['STORYBOARD_APPROVED', 'RENDER_RESERVED', 'RENDERING', 'QA_RUNNING', 'COMPOSING', 'PLATFORM_VARIANTS', 'FINAL_QA', 'COMPLETE'].includes(p.state as string))
    throw new DomainError('CONFLICT', 'This ad is already in production.');
  if (isFreeTier(ctx)) {
    // Each chosen concept draws a new storyboard: bounded per product before a purchase (standard §5).
    const [n] = await tx`select count(*)::int as n from storyboards sb join projects pr on pr.id = sb.project_id where pr.sku_id = ${c.sku_id}`;
    if (n!.n >= FREE_EXPLORATION.STORYBOARDS_PER_SKU) {
      throw new DomainError('PAYMENT_REQUIRED', 'Produce this one to keep exploring — you’ve drawn all the free storyboards for this product.', { freeLimit: 'storyboards' });
    }
  }
  await transition(tx, ctx, projectId, 'CONCEPT_SELECTED', { patch: { selected_concept_id: conceptId } });
  const [sb] = await tx`insert into storyboards (workspace_id, project_id, concept_id, status) values (${ctx.workspaceId}, ${projectId}, ${conceptId}, 'generating') returning id`;
  await tx`update storyboards set status = 'superseded' where project_id = ${projectId} and id <> ${sb!.id} and status in ('ready','generating')`;
  await tx`update projects set storyboard_id = ${sb!.id} where id = ${projectId}`;
  await planSteps(tx, ctx.workspaceId, sb!.id as string, STORYBOARD_STEPS);
  await enqueue(tx, ctx.workspaceId, queueFor(Queues.generateStoryboard, ctx), { projectId, storyboardId: sb!.id, conceptId, actor: ctx.actor }, { singletonKey: `sb:${sb!.id}`, priority: priorityFor(ctx) });
  return { storyboardId: sb!.id as string, replayed: false };
}

async function referenceDataUrls(tx: Tx, skuId: string, projectId: string | null): Promise<string[]> {
  const ids = await referenceAssetIds(tx, skuId, projectId);
  return Promise.all(ids.map(async (id) => toDataUrl(await assetBytes(tx, id))));
}

function framePrompt(scene: StoryboardPlan['scenes'][number], productName: string) {
  return [
    `Vertical 9:16 skincare advertising frame. ${scene.visualPlan}`,
    scene.productBehavior ? `Product: ${productName} — ${scene.productBehavior}. Keep the product exactly as in the reference images: same label text, shape, closure and colour.` : '',
    'Soft natural light, warm neutral palette, clean composition. No text, no watermark, no logos other than the product label.',
    scene.showsHumanSkin ? 'Real, natural-looking adult skin with visible texture; do not retouch or show before/after changes.' : '',
  ].filter(Boolean).join(' ');
}

/** Worker: plan + claims check + frames. Issues the Taste offer only once the storyboard is truly ready. */
export async function generateStoryboard(ctx: TenantContext, projectId: string, storyboardId: string, conceptId: string) {
  const ws = ctx.workspaceId;
  const { skuId, productName, status } = await withTenant(ws, async (tx) => {
    const [p] = await tx`select p.sku_id, s.name, sb.status from projects p join skus s on s.id = p.sku_id
                         join storyboards sb on sb.id = ${storyboardId} where p.id = ${projectId}`;
    if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
    return { skuId: p.sku_id as string, productName: p.name as string, status: p.status as string };
  });
  if (status !== 'generating') return; // superseded or already done

  // The frames are where the product cut-out is first used: a photo keying couldn't cut out cleanly gets one
  // background-removal try here, priced into this storyboard's authorization (plan 06 Phase 1 #6).
  const { auth, segment } = await withTenant(ws, async (tx) => {
    const segment = wantsSegmentation(await cutoutState(tx, skuId));
    const auth = await authorize(tx, ctx, {
      purpose: 'storyboard',
      projectId,
      skuId,
      lines: await routedLines(tx, ws, [
        { task: 'creative_director.storyboard', kind: 'llm', inputTokens: 5_000, outputTokens: 2_500 },
        { task: 'image.storyboard_frame', kind: 'image', images: MAX_GENERATED_FRAMES },
        ...(segment ? [{ task: CUTOUT_TASK, kind: 'image' as const, images: 1 }] : []),
      ]),
      idempotencyKey: `storyboard:${storyboardId}`,
    });
    return { auth, segment };
  });
  try {
    await withTenant(ws, (tx) => step(tx, ws, storyboardId, 'plan', 'active'));
    const { plan, promptVersion, model, brandBrainVersionId } = await planStoryboard({ ctx, token: auth.token, skuId, projectId, conceptId });
    await withTenant(ws, async (tx) => {
      // The Production Planner decides each scene's medium (and records why) before any frame is drawn (§23).
      const planned = await planStoryboardScenes(tx, ws, skuId, plan.scenes, { cutoutWillBeTried: segment });
      await step(tx, ws, storyboardId, 'plan', 'done', `${plan.scenes.length} scenes · 15 seconds`);
      await step(tx, ws, storyboardId, 'claims', 'done', 'Every line uses approved or neutral wording');
      await tx`update storyboards set hook_text = ${plan.hook}, cta_text = ${plan.cta}, total_ms = 15000, brand_brain_version_id = ${brandBrainVersionId} where id = ${storyboardId}`;
      await tx`delete from scenes where storyboard_id = ${storyboardId}`;
      for (const [i, s] of plan.scenes.entries()) {
        const p = planned[i]!;
        await tx`insert into scenes (workspace_id, storyboard_id, position, purpose, duration_ms, visual_plan, product_behavior,
                   spoken_line, overlay_text, production_mode, shows_human_skin, planner_reason, estimate_micros)
                 values (${ws}, ${storyboardId}, ${i}, ${s.purpose}, ${s.durationMs}, ${s.visualPlan}, ${s.productBehavior},
                   ${s.spokenLine}, ${s.overlayText}, ${p.mode}, ${s.showsHumanSkin}, ${p.reason}, ${p.estimateMicros})`;
      }
      await tx`update storyboards set status = 'generating' where id = ${storyboardId}`;
      await step(tx, ws, storyboardId, 'frames', 'active');
      void promptVersion;
      void model;
    });

    // Each scene records the Claim IDs its lines use (§24), mapped against the Claims Vault.
    await withTenant(ws, async (tx) => {
      const rows = await tx`select id, spoken_line, overlay_text from scenes where storyboard_id = ${storyboardId}`;
      const names = [productName, (await brandBrainFor(tx, skuId))?.name ?? null];
      const lines = rows.flatMap((r) => [r.spoken_line, r.overlay_text]).filter(Boolean) as string[];
      const mapping = (qaClaims(lines, await allowedClaimTexts(tx, skuId), { names }).data as { mapping: LineMapping[] }).mapping;
      for (const r of rows) await tx`update scenes set claim_ids = ${sceneClaimIds([r.spoken_line as string | null, r.overlay_text as string | null], mapping)}::uuid[] where id = ${r.id}`;
    });

    // Frames: exact product composites where possible; at most 2 generated frames (COGS, §6).
    const scenes = await withTenant(ws, (tx) => tx`select * from scenes where storyboard_id = ${storyboardId} order by position`);
    const [pv] = await withTenant(ws, (tx) => tx`select sku_variant_id from projects where id = ${projectId}`);
    if (pv?.sku_variant_id) await ensureVariantImage(ctx, pv.sku_variant_id as string);
    if (segment) await segmentCutout({ ctx, token: auth.token, skuId });
    const { imagery, refs } = await withTenant(ws, async (tx) => ({ imagery: await productImagery(tx, skuId), refs: await referenceDataUrls(tx, skuId, projectId) }));
    const cut = imagery.cutout?.keyed ? imagery.cutout : null;
    let generated = 0;
    for (const s of scenes) {
      let bytes: Buffer;
      let technique: string;
      let lineage: Record<string, unknown> = {};
      let jobModel: string | null = null;
      // A hybrid is a generated setting *plus the exact product*: without a clean cut-out it would show only the
      // generated (unchecked) product, so it falls back to the exact-product frame instead.
      const wantsGen = (s.production_mode === 'GENERATIVE_INTERACTION' || (s.production_mode === 'HYBRID' && !!cut)) && generated < MAX_GENERATED_FRAMES;
      if (wantsGen) {
        const img = await generateImage({
          ctx,
          token: auth.token,
          task: 'image.storyboard_frame',
          subject: { type: 'scene', id: s.id as string },
          prompt: framePrompt({ purpose: s.purpose, durationMs: s.duration_ms, visualPlan: s.visual_plan, productBehavior: s.product_behavior, spokenLine: s.spoken_line, overlayText: s.overlay_text, productionMode: s.production_mode, showsHumanSkin: !!s.shows_human_skin }, productName),
          references: refs,
          ...FRAME,
          mockLabel: `${s.purpose} · ${s.visual_plan}`.slice(0, 90),
        });
        generated++;
        // A hybrid places the exact product from the clean cut-out onto the generated setting.
        bytes = s.production_mode === 'HYBRID' && cut ? await compositeProduct(img.bytes, cut.bytes, '9x16', { scale: 0.38, anchor: 'lower', shadow: true }) : img.bytes;
        technique = s.production_mode === 'HYBRID' && cut ? 'generated_bg+exact_product' : 'generated';
        lineage = { providerJobId: img.jobId, ...(cut && technique === 'generated_bg+exact_product' ? { cutoutAssetId: cut.assetId } : {}) };
        jobModel = img.modelVersion;
      } else {
        // Strict product composite (§23): the exact product on a clean production backdrop — or, when the photo
        // couldn't be cut out, the photo itself. Never a debug placeholder.
        const fb = await exactProductFrame(imagery, { purpose: s.purpose as string });
        bytes = fb?.bytes ?? (await productionBackdrop('9x16', imagery.palette));
        technique = fb?.technique ?? 'backdrop';
        lineage = fb?.lineage ?? {};
      }
      await withTenant(ws, async (tx) => {
        const a = await saveAsset(tx, ws, { bytes, mime: 'image/png', kind: 'storyboard_frame', skuId, source: 'generated', lineage: { sceneId: s.id, technique, ...lineage } });
        const [v] = await tx`insert into scene_versions (workspace_id, scene_id, version, kind, asset_id, technique, model, status, lineage)
                             values (${ws}, ${s.id}, 1, 'frame', ${a.id}, ${technique}, ${jobModel}, 'succeeded', ${tx.json(lineage as never)})
                             on conflict (workspace_id, scene_id, kind, version) do update set asset_id = excluded.asset_id, technique = excluded.technique, lineage = excluded.lineage
                             returning id`;
        await tx`update scenes set current_version_id = ${v!.id} where id = ${s.id}`;
      });
    }
    await withTenant(ws, async (tx) => {
      await step(tx, ws, storyboardId, 'frames', 'done', imagery.cutout && !imagery.cutout.keyed ? `${scenes.length} frames. ${CLEAN_PHOTO_TIP}` : `${scenes.length} frames`);
      // Superseded meanwhile (another concept chosen, or the storyboard a checkout paid for restored): the frames
      // are kept, but this storyboard no longer becomes the project's.
      const [done] = await tx`update storyboards set status = 'ready' where id = ${storyboardId} and status = 'generating' returning id`;
      if (!done) {
        await settle(tx, ctx, auth.authorizationId, 'consumed');
        return;
      }
      await transition(tx, ctx, projectId, 'STORYBOARD_READY');
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      // Standard §5: the 60-minute Taste window starts only now — and §42: not for a product the store has out of
      // stock until the merchant says the ad is for a waitlist or launch (the window then starts when they do).
      const quote = (await stockState(tx, skuId)).needsIntent ? await currentQuote(tx) : await issueTasteOffer(tx, ctx, projectId);
      await emit(tx, ctx, 'STORYBOARD_READY', { type: 'project', id: projectId }, { storyboardId });
      // The offer this storyboard is priced with (definition · experiment variant): the funnel's offer slice (plan 05 §4).
      const [offer] = quote.offerId ? await tx`select variant from offers where id = ${quote.offerId} and workspace_id = ${ws}` : [];
      await recordFunnel('STORYBOARD_READY', { workspaceId: ws, visitorId: await projectVisitor(tx, ws, projectId), props: { offer: quote.definitionCode ?? (quote.kind === 'taste' ? 'taste' : 'standalone'), offerVariant: (offer?.variant as string) ?? null } }, tx);
    });
  } catch (e) {
    await withTenant(ws, async (tx) => {
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      await tx`update storyboards set status = 'failed' where id = ${storyboardId}`;
      await step(tx, ws, storyboardId, 'frames', 'failed', e instanceof DomainError && e.code === 'GATE_BLOCKED' ? e.message : 'Something went wrong. We’re retrying.');
    });
    throw e;
  }
}

/**
 * Structured scene edit (plan 03 A3). Text/CTA/overlay edits are free and never regenerate footage (§13).
 * Every edited line is re-checked against the Claims Vault before it is saved.
 */
export async function editScene(
  tx: Tx,
  ctx: TenantContext,
  sceneId: string,
  patch: { spokenLine?: string | null; overlayText?: string | null; durationMs?: number },
) {
  assertCan(ctx, 'sku.edit');
  const [s] = await tx`select s.*, sb.project_id, sb.status as sb_status, sb.hook_text, p.sku_id from scenes s join storyboards sb on sb.id = s.storyboard_id
                       join projects p on p.id = sb.project_id where s.id = ${sceneId} for update of s`;
  if (!s) throw new DomainError('NOT_FOUND', 'Scene not found');
  if (s.locked) throw new DomainError('CONFLICT', 'Unlock this scene to edit it.');
  if (s.sb_status === 'approved') throw new DomainError('CONFLICT', 'This storyboard is approved for production.');
  const lines = [patch.spokenLine, patch.overlayText].filter((l): l is string => !!l && !!l.trim());
  if (lines.length) {
    const [sku] = await tx`select name from skus where id = ${s.sku_id}`;
    const scan = scanCreativeText(lines, await allowedClaimTexts(tx, s.sku_id as string), { names: [sku?.name as string | undefined, (await brandBrainFor(tx, s.sku_id as string))?.name] });
    if (!scan.ok) {
      const v = scan.violations[0]!;
      throw new DomainError('GATE_BLOCKED', `“${v.text}” can’t be used: ${v.reason}`, { alternative: v.alternative ?? classifyClaim(v.text).matched[0]?.alternative });
    }
    // §40: a scene with an AI-generated person never speaks as a customer.
    const testimonial = lines.find((l) => isFirstPersonTestimonial(l));
    if (testimonial && showsSyntheticPeople(s)) throw new DomainError('GATE_BLOCKED', `“${testimonial}” can’t be used here. ${SYNTHETIC_TESTIMONIAL_REASON}`, { testimonial });
    // Every product-effect statement needs an approved claim (§25 check 3) — or production would stop on it later.
    if (scan.unmapped.length) {
      throw new DomainError('GATE_BLOCKED', `“${scan.unmapped[0]}” makes a product claim that isn’t approved yet. Add it to your Claims Vault with evidence, or describe the look or feel instead.`, { unmapped: scan.unmapped });
    }
  }
  await tx`update scenes set
             spoken_line = ${patch.spokenLine === undefined ? s.spoken_line : patch.spokenLine},
             overlay_text = ${patch.overlayText === undefined ? s.overlay_text : patch.overlayText},
             duration_ms = ${patch.durationMs ?? s.duration_ms}
           where id = ${sceneId}`;
  // The storyboard's hook is the opening scene's line: editing that line edits the hook too, so a blocked hook can
  // be fixed from its scene and hook variants keep recognising a spoken hook.
  if (Number(s.position) === 0 && s.hook_text) {
    const hook = patch.spokenLine !== undefined && s.spoken_line === s.hook_text ? patch.spokenLine : patch.overlayText !== undefined && s.overlay_text === s.hook_text ? patch.overlayText : undefined;
    if (hook && hook.trim()) await tx`update storyboards set hook_text = ${hook.trim().slice(0, 90)} where id = ${s.storyboard_id}`;
  }
  return { billable: false };
}

export async function setSceneLock(tx: Tx, ctx: TenantContext, sceneId: string, locked: boolean) {
  assertCan(ctx, 'sku.edit');
  await tx`update scenes set locked = ${locked} where id = ${sceneId}`;
}

/** Progress key for one requested frame version (subject: the scene). */
export const frameStepKey = (version: number) => `frame.v${version}`;
const FRAME_REQUEST_STALE_MINUTES = 10;

/** Free changes a storyboard has used, plus changes in flight (optionally only those a worker is drawing). */
async function freeChangesTaken(tx: Tx, storyboardId: string, opts: { statuses: readonly string[]; except?: { sceneId: string; key: string } }) {
  const [u] = await tx`select coalesce(sum(free_regenerations_used), 0)::int as used,
                              (select count(*)::int from progress_steps ps join scenes x on x.id = ps.subject_id and x.workspace_id = ps.workspace_id
                               where x.storyboard_id = ${storyboardId} and ps.step_key like 'frame.v%' and ps.status = any(${opts.statuses as string[]})
                                 and not (ps.subject_id = ${opts.except?.sceneId ?? null}::uuid and ps.step_key = ${opts.except?.key ?? ''})
                                 and ps.started_at > now() - make_interval(mins => ${FRAME_REQUEST_STALE_MINUTES})) as inflight
                       from scenes where storyboard_id = ${storyboardId}`;
  return Number(u!.used) + Number(u!.inflight);
}

const FREE_CHANGES_USED = 'You’ve used the free frame changes. Your ad can still be adjusted after production.';

/**
 * "Change picture" (pre-purchase: 3 free per storyboard). Validates and enqueues in one transaction; the frame
 * is drawn by the `regenerate-frame` job (§34). Locked scenes are never regenerated (§13). In-flight requests
 * count against the free allowance, and requests are serialized per storyboard (row lock), so parallel clicks —
 * on one scene or on several — cannot exceed it.
 */
export async function requestFrameRegeneration(tx: Tx, ctx: TenantContext, sceneId: string, instruction: string) {
  assertCan(ctx, 'sku.edit');
  const text = instruction.trim();
  if (!text) throw new DomainError('INVALID', 'Describe the change you want.');
  const [s] = await tx`select s.id, s.locked, sb.id as sb_id, sb.status as sb_status from scenes s join storyboards sb on sb.id = s.storyboard_id
                       where s.id = ${sceneId} for update of s`;
  if (!s) throw new DomainError('NOT_FOUND', 'Scene not found');
  // Every change on this storyboard counts against one allowance: take the storyboard lock before counting.
  await tx`select id from storyboards where id = ${s.sb_id} for update`;
  if (s.locked) throw new DomainError('CONFLICT', 'This scene is locked.');
  if (s.sb_status === 'approved') throw new DomainError('CONFLICT', 'This storyboard is approved for production.');
  const [v] = await tx`select coalesce(max(version), 0) + 1 as v from scene_versions where scene_id = ${sceneId} and kind = 'frame'`;
  const version = Number(v!.v);
  const [inflight] = await tx`select step_key from progress_steps where subject_id = ${sceneId} and step_key = ${frameStepKey(version)}
                              and status in ('pending','active') and started_at > now() - make_interval(mins => ${FRAME_REQUEST_STALE_MINUTES})`;
  if (inflight) return { sceneId, version, replayed: true };
  if ((await freeChangesTaken(tx, s.sb_id as string, { statuses: ['pending', 'active'] })) >= FREE_FRAME_REGENERATIONS) throw new DomainError('PAYMENT_REQUIRED', FREE_CHANGES_USED);
  const c = classifyClaim(text);
  if (c.status === 'BLOCKED') throw new DomainError('GATE_BLOCKED', c.matched[0]!.reason);
  await tx`insert into progress_steps (workspace_id, subject_id, step_key, label, status, started_at, position)
           values (${ctx.workspaceId}, ${sceneId}, ${frameStepKey(version)}, 'Redrawing this frame', 'pending', now(), 0)
           on conflict (workspace_id, subject_id, step_key) do update set status = 'pending', detail = null, started_at = now(), completed_at = null`;
  await enqueue(tx, ctx.workspaceId, queueFor(Queues.regenerateFrame, ctx), { sceneId, version, instruction: text.slice(0, 200), actor: ctx.actor },
    { singletonKey: `frame:${sceneId}:${version}`, priority: priorityFor(ctx) });
  return { sceneId, version, replayed: false };
}

/**
 * Worker (`regenerate-frame`): draw one requested frame version under its own authorization keyed
 * `frame:<scene>:<version>`. Idempotent per version; the free allowance is counted only on success.
 */
export async function regenerateFrame(ctx: TenantContext, sceneId: string, instruction: string, version: number): Promise<'done' | 'skipped'> {
  const ws = ctx.workspaceId;
  const key = frameStepKey(version);
  const info = await withTenant(ws, async (tx) => {
    const [s] = await tx`select s.*, sb.project_id, sb.id as sb_id, sb.status as sb_status, p.sku_id, sk.name from scenes s join storyboards sb on sb.id = s.storyboard_id
                         join projects p on p.id = sb.project_id join skus sk on sk.id = p.sku_id where s.id = ${sceneId}`;
    if (!s) throw new DomainError('NOT_FOUND', 'Scene not found');
    const [done] = await tx`select 1 from scene_versions where scene_id = ${sceneId} and kind = 'frame' and version = ${version}`;
    const imagery = done ? null : await productImagery(tx, s.sku_id as string);
    return { s, done: !!done, cut: imagery?.cutout?.keyed ? imagery.cutout : null, refs: done ? [] : await referenceDataUrls(tx, s.sku_id as string, s.project_id as string) };
  });
  if (info.done) {
    await withTenant(ws, (tx) => step(tx, ws, sceneId, key, 'done'));
    return 'done';
  }
  if (info.s.locked || info.s.sb_status === 'approved') {
    // Locked or approved after the request was made: never redraw (§13).
    await withTenant(ws, (tx) => step(tx, ws, sceneId, key, 'skipped', info.s.locked ? 'This scene is locked.' : 'This storyboard is approved for production.'));
    return 'skipped';
  }
  let auth: Awaited<ReturnType<typeof authorize>>;
  try {
    auth = await withTenant(ws, async (tx) => {
      // Before any spend, claim the free change under the storyboard lock: changes already made plus changes
      // another worker is drawing right now. A request that outlived its queue slot (stale, so no longer counted
      // at request time) can't push the storyboard past its allowance when its job finally runs.
      await tx`select id from storyboards where id = ${info.s.sb_id} for update`;
      if ((await freeChangesTaken(tx, info.s.sb_id as string, { statuses: ['active'], except: { sceneId, key } })) >= FREE_FRAME_REGENERATIONS) {
        throw new DomainError('PAYMENT_REQUIRED', FREE_CHANGES_USED);
      }
      const a = await authorizeOrTakeOver(
        tx,
        ctx,
        { purpose: 'storyboard', projectId: info.s.project_id as string, skuId: info.s.sku_id as string, lines: await routedLines(tx, ws, [{ task: 'image.storyboard_frame', kind: 'image', images: 1 }]), idempotencyKey: `frame:${sceneId}:${version}` },
        FRAME_REQUEST_STALE_MINUTES,
      );
      await step(tx, ws, sceneId, key, 'active');
      // The claim is live from now (not from when the request was queued), so it counts for its whole draw.
      await tx`update progress_steps set started_at = now() where workspace_id = ${ws} and subject_id = ${sceneId} and step_key = ${key}`;
      return a;
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'CONFLICT') return 'skipped';
    await withTenant(ws, (tx) => step(tx, ws, sceneId, key, 'failed', frameFailure(e)));
    if (e instanceof DomainError && e.code === 'PAYMENT_REQUIRED') return 'skipped';
    throw e;
  }
  try {
    const img = await generateImage({
      ctx,
      token: auth.token,
      task: 'image.storyboard_frame',
      subject: { type: 'scene', id: sceneId },
      prompt: `${framePrompt({ purpose: info.s.purpose, durationMs: info.s.duration_ms, visualPlan: `${info.s.visual_plan}. Change: ${instruction}`, productBehavior: info.s.product_behavior, spokenLine: null, overlayText: null, productionMode: info.s.production_mode, showsHumanSkin: !!info.s.shows_human_skin }, info.s.name as string)}`,
      references: info.refs,
      ...FRAME,
      mockLabel: `${info.s.purpose} · ${instruction}`.slice(0, 90),
    });
    const composite = !!info.cut && info.s.production_mode !== 'GENERATIVE_INTERACTION';
    const bytes = composite ? await compositeProduct(img.bytes, info.cut!.bytes, '9x16', { scale: 0.4, anchor: 'lower', shadow: true }) : img.bytes;
    const lineage = { providerJobId: img.jobId, instruction, ...(composite ? { cutoutAssetId: info.cut!.assetId } : {}) };
    await withTenant(ws, async (tx) => {
      const a = await saveAsset(tx, ws, { bytes, mime: 'image/png', kind: 'storyboard_frame', skuId: info.s.sku_id as string, source: 'generated', lineage: { sceneId, ...lineage } });
      const [v] = await tx`insert into scene_versions (workspace_id, scene_id, version, kind, asset_id, technique, model, status, lineage)
                           values (${ws}, ${sceneId}, ${version}, 'frame', ${a.id}, ${composite ? 'generated_bg+exact_product' : 'generated'}, ${img.modelVersion}, 'succeeded', ${tx.json(lineage as never)}) returning id`;
      await tx`update scenes set current_version_id = ${v!.id}, free_regenerations_used = free_regenerations_used + 1,
                 visual_plan = ${`${info.s.visual_plan}. ${instruction}`.slice(0, 300)} where id = ${sceneId}`;
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      await step(tx, ws, sceneId, key, 'done');
    });
    return 'done';
  } catch (e) {
    await withTenant(ws, async (tx) => {
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      await step(tx, ws, sceneId, key, 'failed', frameFailure(e));
    });
    throw e;
  }
}

function frameFailure(e: unknown): string {
  if (e instanceof DomainError && (e.code === 'GATE_BLOCKED' || e.code === 'UNAVAILABLE' || e.code === 'PAYMENT_REQUIRED')) return e.message;
  return 'We couldn’t redraw this frame just now. Your free changes weren’t used — please try again.';
}

export async function storyboardView(tx: Tx, storyboardId: string) {
  const [sb] = await tx`select * from storyboards where id = ${storyboardId}`;
  if (!sb) throw new DomainError('NOT_FOUND', 'Storyboard not found');
  const scenes = await tx`select s.*, v.asset_id as frame_asset_id from scenes s left join scene_versions v on v.id = s.current_version_id
                          where s.storyboard_id = ${storyboardId} order by s.position`;
  return { storyboard: sb, scenes };
}
