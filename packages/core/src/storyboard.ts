import { withTenant, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { compositeProduct, placeholderFrame } from '@arkiv/media';
import { assetBytes, saveAsset } from './assets';
import { assertCan } from './authz';
import { classifyClaim, scanCreativeText } from './compliance';
import type { TenantContext } from './context';
import { authorize, settle } from './cost-governor';
import { allowedClaimTexts, planStoryboard } from './creative-director';
import { emit } from './events';
import { recordFunnel } from './funnel';
import type { StoryboardPlan } from './intel-schemas';
import { generateImage } from './model-gateway';
import { issueTasteOffer } from './offers';
import { enqueue, Queues } from './outbox';
import { planSteps, step } from './progress';
import { transition } from './projects';
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
  await transition(tx, ctx, projectId, 'CONCEPT_SELECTED', { patch: { selected_concept_id: conceptId } });
  const [sb] = await tx`insert into storyboards (workspace_id, project_id, concept_id, status) values (${ctx.workspaceId}, ${projectId}, ${conceptId}, 'generating') returning id`;
  await tx`update storyboards set status = 'superseded' where project_id = ${projectId} and id <> ${sb!.id} and status in ('ready','generating')`;
  await tx`update projects set storyboard_id = ${sb!.id} where id = ${projectId}`;
  await planSteps(tx, ctx.workspaceId, sb!.id as string, STORYBOARD_STEPS);
  await enqueue(tx, ctx.workspaceId, Queues.generateStoryboard, { projectId, storyboardId: sb!.id, conceptId, actor: ctx.actor }, { singletonKey: `sb:${sb!.id}` });
  return { storyboardId: sb!.id as string, replayed: false };
}

async function productCutout(tx: Tx, skuId: string): Promise<Buffer | null> {
  const [fp] = await tx`select cutout_asset_id from visual_fingerprints where sku_id = ${skuId} and active`;
  if (!fp?.cutout_asset_id) return null;
  return assetBytes(tx, fp.cutout_asset_id as string);
}

async function referenceDataUrls(tx: Tx, skuId: string): Promise<string[]> {
  const [fp] = await tx`select reference_asset_ids from visual_fingerprints where sku_id = ${skuId} and active`;
  const ids = ((fp?.reference_asset_ids as string[]) ?? []).slice(0, 2);
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

  const auth = await withTenant(ws, (tx) =>
    authorize(tx, ctx, {
      purpose: 'storyboard',
      projectId,
      lines: [
        { kind: 'llm', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 5_000, outputTokens: 2_500 },
        { kind: 'image', provider: 'byteplus', model: 'seedream-5-0-pro', images: MAX_GENERATED_FRAMES },
      ],
      idempotencyKey: `storyboard:${storyboardId}`,
    }),
  );
  try {
    await withTenant(ws, (tx) => step(tx, ws, storyboardId, 'plan', 'active'));
    const { plan, promptVersion, model } = await planStoryboard({ ctx, token: auth.token, skuId, projectId, conceptId });
    await withTenant(ws, async (tx) => {
      await step(tx, ws, storyboardId, 'plan', 'done', `${plan.scenes.length} scenes · 15 seconds`);
      await step(tx, ws, storyboardId, 'claims', 'done', 'Every line uses approved or neutral wording');
      await tx`update storyboards set hook_text = ${plan.hook}, cta_text = ${plan.cta}, total_ms = 15000 where id = ${storyboardId}`;
      await tx`delete from scenes where storyboard_id = ${storyboardId}`;
      for (const [i, s] of plan.scenes.entries()) {
        await tx`insert into scenes (workspace_id, storyboard_id, position, purpose, duration_ms, visual_plan, product_behavior,
                   spoken_line, overlay_text, production_mode)
                 values (${ws}, ${storyboardId}, ${i}, ${s.purpose}, ${s.durationMs}, ${s.visualPlan}, ${s.productBehavior},
                   ${s.spokenLine}, ${s.overlayText}, ${s.productionMode})`;
      }
      await tx`update storyboards set status = 'generating' where id = ${storyboardId}`;
      await step(tx, ws, storyboardId, 'frames', 'active');
      void promptVersion;
      void model;
    });

    // Frames: exact product composites where possible; at most 2 generated frames (COGS, §6).
    const scenes = await withTenant(ws, (tx) => tx`select * from scenes where storyboard_id = ${storyboardId} order by position`);
    const { cut, refs } = await withTenant(ws, async (tx) => ({ cut: await productCutout(tx, skuId), refs: await referenceDataUrls(tx, skuId) }));
    let generated = 0;
    for (const s of scenes) {
      let bytes: Buffer;
      let technique: string;
      let jobModel: string | null = null;
      const wantsGen = (s.production_mode === 'GENERATIVE_INTERACTION' || s.production_mode === 'HYBRID') && generated < MAX_GENERATED_FRAMES;
      if (wantsGen) {
        const img = await generateImage({
          ctx,
          token: auth.token,
          task: 'image.storyboard_frame',
          subject: { type: 'scene', id: s.id as string },
          prompt: framePrompt({ purpose: s.purpose, durationMs: s.duration_ms, visualPlan: s.visual_plan, productBehavior: s.product_behavior, spokenLine: s.spoken_line, overlayText: s.overlay_text, productionMode: s.production_mode, showsHumanSkin: false }, productName),
          references: refs,
          ...FRAME,
          mockLabel: `${s.purpose} · ${s.visual_plan}`.slice(0, 90),
        });
        generated++;
        bytes = s.production_mode === 'HYBRID' && cut ? await compositeProduct(img.bytes, cut, '9x16', { scale: 0.38, anchor: 'lower' }) : img.bytes;
        technique = s.production_mode === 'HYBRID' ? 'generated_bg+exact_product' : 'generated';
        jobModel = img.modelVersion;
      } else {
        const bg = await placeholderFrame('', '9x16', s.position as number);
        bytes = cut ? await compositeProduct(bg, cut, '9x16', { scale: s.purpose === 'cta' ? 0.3 : 0.5 }) : bg;
        technique = 'exact_product_composite';
      }
      await withTenant(ws, async (tx) => {
        const a = await saveAsset(tx, ws, { bytes, mime: 'image/png', kind: 'storyboard_frame', skuId, source: 'generated', lineage: { sceneId: s.id, technique } });
        const [v] = await tx`insert into scene_versions (workspace_id, scene_id, version, kind, asset_id, technique, model, status)
                             values (${ws}, ${s.id}, 1, 'frame', ${a.id}, ${technique}, ${jobModel}, 'succeeded')
                             on conflict (workspace_id, scene_id, kind, version) do update set asset_id = excluded.asset_id
                             returning id`;
        await tx`update scenes set current_version_id = ${v!.id} where id = ${s.id}`;
      });
    }
    await withTenant(ws, async (tx) => {
      await step(tx, ws, storyboardId, 'frames', 'done', `${scenes.length} frames`);
      await tx`update storyboards set status = 'ready' where id = ${storyboardId}`;
      await transition(tx, ctx, projectId, 'STORYBOARD_READY');
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      // Standard §5: the 60-minute Taste window starts only now.
      await issueTasteOffer(tx, ctx, projectId);
      await emit(tx, ctx, 'STORYBOARD_READY', { type: 'project', id: projectId }, { storyboardId });
      await recordFunnel('STORYBOARD_READY', { workspaceId: ws }, tx);
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
  const [s] = await tx`select s.*, sb.project_id, sb.status as sb_status, p.sku_id from scenes s join storyboards sb on sb.id = s.storyboard_id
                       join projects p on p.id = sb.project_id where s.id = ${sceneId} for update of s`;
  if (!s) throw new DomainError('NOT_FOUND', 'Scene not found');
  if (s.locked) throw new DomainError('CONFLICT', 'Unlock this scene to edit it.');
  if (s.sb_status === 'approved') throw new DomainError('CONFLICT', 'This storyboard is approved for production.');
  const lines = [patch.spokenLine, patch.overlayText].filter((l): l is string => !!l && !!l.trim());
  if (lines.length) {
    const scan = scanCreativeText(lines, await allowedClaimTexts(tx, s.sku_id as string));
    if (!scan.ok) {
      const v = scan.violations[0]!;
      throw new DomainError('GATE_BLOCKED', `“${v.text}” can’t be used: ${v.reason}`, { alternative: v.alternative ?? classifyClaim(v.text).matched[0]?.alternative });
    }
  }
  await tx`update scenes set
             spoken_line = ${patch.spokenLine === undefined ? s.spoken_line : patch.spokenLine},
             overlay_text = ${patch.overlayText === undefined ? s.overlay_text : patch.overlayText},
             duration_ms = ${patch.durationMs ?? s.duration_ms}
           where id = ${sceneId}`;
  return { billable: false };
}

export async function setSceneLock(tx: Tx, ctx: TenantContext, sceneId: string, locked: boolean) {
  assertCan(ctx, 'sku.edit');
  await tx`update scenes set locked = ${locked} where id = ${sceneId}`;
}

/** Regenerate one frame (pre-purchase: 3 free per storyboard). Locked scenes are never regenerated (§13). */
export async function regenerateFrame(ctx: TenantContext, sceneId: string, instruction: string) {
  const ws = ctx.workspaceId;
  const info = await withTenant(ws, async (tx) => {
    assertCan(ctx, 'sku.edit');
    const [s] = await tx`select s.*, sb.project_id, sb.id as sb_id, p.sku_id, sk.name from scenes s join storyboards sb on sb.id = s.storyboard_id
                         join projects p on p.id = sb.project_id join skus sk on sk.id = p.sku_id where s.id = ${sceneId}`;
    if (!s) throw new DomainError('NOT_FOUND', 'Scene not found');
    if (s.locked) throw new DomainError('CONFLICT', 'This scene is locked.');
    const [u] = await tx`select coalesce(sum(free_regenerations_used), 0)::int as n from scenes where storyboard_id = ${s.sb_id}`;
    if (u!.n >= FREE_FRAME_REGENERATIONS) throw new DomainError('PAYMENT_REQUIRED', 'You’ve used the free frame changes. Your ad can still be adjusted after production.');
    const c = classifyClaim(instruction);
    if (c.status === 'BLOCKED') throw new DomainError('GATE_BLOCKED', c.matched[0]!.reason);
    const [v] = await tx`select coalesce(max(version), 0) + 1 as v from scene_versions where scene_id = ${sceneId} and kind = 'frame'`;
    return { s, nextVersion: Number(v!.v), cut: await productCutout(tx, s.sku_id as string), refs: await referenceDataUrls(tx, s.sku_id as string) };
  });
  const auth = await withTenant(ws, (tx) =>
    authorize(tx, ctx, { purpose: 'storyboard', projectId: info.s.project_id as string, lines: [{ kind: 'image', provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 }], idempotencyKey: `frame:${sceneId}:${info.nextVersion}` }),
  );
  try {
    const img = await generateImage({
      ctx,
      token: auth.token,
      task: 'image.storyboard_frame',
      subject: { type: 'scene', id: sceneId },
      prompt: `${framePrompt({ purpose: info.s.purpose, durationMs: info.s.duration_ms, visualPlan: `${info.s.visual_plan}. Change: ${instruction}`, productBehavior: info.s.product_behavior, spokenLine: null, overlayText: null, productionMode: info.s.production_mode, showsHumanSkin: false }, info.s.name as string)}`,
      references: info.refs,
      ...FRAME,
      mockLabel: `${info.s.purpose} · ${instruction}`.slice(0, 90),
    });
    const bytes = info.cut && info.s.production_mode !== 'GENERATIVE_INTERACTION' ? await compositeProduct(img.bytes, info.cut, '9x16', { scale: 0.4, anchor: 'lower' }) : img.bytes;
    return await withTenant(ws, async (tx) => {
      const a = await saveAsset(tx, ws, { bytes, mime: 'image/png', kind: 'storyboard_frame', skuId: info.s.sku_id as string, source: 'generated', lineage: { sceneId, instruction } });
      const [v] = await tx`insert into scene_versions (workspace_id, scene_id, version, kind, asset_id, technique, model, status)
                           values (${ws}, ${sceneId}, ${info.nextVersion}, 'frame', ${a.id}, 'generated', ${img.modelVersion}, 'succeeded') returning id`;
      await tx`update scenes set current_version_id = ${v!.id}, free_regenerations_used = free_regenerations_used + 1,
                 visual_plan = ${`${info.s.visual_plan}. ${instruction}`.slice(0, 300)} where id = ${sceneId}`;
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      return { sceneVersionId: v!.id as string, assetId: a.id };
    });
  } catch (e) {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
    throw e;
  }
}

export async function storyboardView(tx: Tx, storyboardId: string) {
  const [sb] = await tx`select * from storyboards where id = ${storyboardId}`;
  if (!sb) throw new DomainError('NOT_FOUND', 'Storyboard not found');
  const scenes = await tx`select s.*, v.asset_id as frame_asset_id from scenes s left join scene_versions v on v.id = s.current_version_id
                          where s.storyboard_id = ${storyboardId} order by s.position`;
  return { storyboard: sb, scenes };
}
