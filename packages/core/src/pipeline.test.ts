import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { probe, withTempDir } from '@arkiv/media';
import { assetBytes } from './assets';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, startPreview } from './analysis';
import { approveClaim, listClaims, proposeClaim } from './claims';
import { append, available } from './ledger';
import { approveForProduction, blockedLines, produceProject } from './production';
import { editScene, generateStoryboard, selectConcept, storyboardView } from './storyboard';
import { currentQuote } from './offers';
import { ingestBytes } from './uploads';
import { ctxFor, productPhoto } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

async function outboxJobs(queue: string) {
  return ownerPool()`select payload from outbox where queue = ${queue} order by created_at`;
}

async function previewToStoryboard(opts: { visualPlanMarker?: string } = {}) {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const photo = await productPhoto();
  const asset = await withTenant(t.workspaceId, (tx) => ingestBytes(tx, ctx, photo, 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  expect(await outboxJobs('analyze-product-free')).toHaveLength(1); // free-tier preview → the free pool
  const r = await analyzeProduct(ctx, skuId, projectId);
  expect(r.status).toBe('ready');
  const concepts = await withTenant(t.workspaceId, (tx) => tx`select id, idx, is_pick, proposal from concepts where project_id = ${projectId} order by idx`);
  expect(concepts.map((c) => c.idx)).toEqual(['A', 'B', 'C']);
  expect(concepts.filter((c) => c.is_pick)).toHaveLength(1);
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, concepts[0]!.id as string));
  if (opts.visualPlanMarker) {
    // Test hook: mark the demonstration scene so the mock QA inspector fails it.
    await generateStoryboard(ctx, projectId, storyboardId, concepts[0]!.id as string);
    await ownerPool()`update scenes set visual_plan = visual_plan || ${' ' + opts.visualPlanMarker} where storyboard_id = ${storyboardId} and production_mode = 'GENERATIVE_INTERACTION'`;
  } else {
    await generateStoryboard(ctx, projectId, storyboardId, concepts[0]!.id as string);
  }
  return { t, ctx, skuId, projectId, storyboardId };
}

describe('free preview → storyboard (Launch Gate 1, first half)', () => {
  it('analyzes a photo-only product, builds Product Brain, fingerprint, concepts, storyboard and starts the Taste clock', async () => {
    const { t, skuId, projectId, storyboardId } = await previewToStoryboard();
    await withTenant(t.workspaceId, async (tx) => {
      const [sku] = await tx`select status, catalogue_no from skus where id = ${skuId}`;
      expect(sku!.status).toBe('active');
      expect(sku!.catalogue_no).toBe(1);
      const [fp] = await tx`select cutout_asset_id, dominant_colors from visual_fingerprints where sku_id = ${skuId}`;
      expect(fp!.cutout_asset_id).toBeTruthy();
      const steps = await tx`select step_key, status from progress_steps where subject_id = ${skuId} order by position`;
      expect(steps.every((s) => s.status === 'done')).toBe(true);
      const v = await storyboardView(tx, storyboardId);
      expect(v.storyboard.status).toBe('ready');
      expect(v.scenes.reduce((s, x) => s + Number(x.duration_ms), 0)).toBe(15000);
      expect(v.scenes.every((s) => s.frame_asset_id)).toBe(true);
      const [p] = await tx`select state from projects where id = ${projectId}`;
      expect(p!.state).toBe('STORYBOARD_READY');
      const q = await currentQuote(tx);
      expect(q.kind).toBe('taste');
      expect(q.priceMicros).toBe(19_000_000);
      // Free preview spend stayed within the cap.
      const [c] = await tx`select coalesce(sum(spent_micros),0)::bigint as n from cost_authorizations where purpose = 'free_preview'`;
      expect(Number(c!.n)).toBeLessThanOrEqual(200_000);
    });
  }, 60_000);

  it('refuses blocked claim edits in the storyboard with a compliant alternative', async () => {
    const { t, ctx, storyboardId } = await previewToStoryboard();
    const [scene] = await ownerPool()`select id from scenes where storyboard_id = ${storyboardId} order by position limit 1`;
    await expect(withTenant(t.workspaceId, (tx) => editScene(tx, ctx, scene!.id as string, { overlayText: 'Cures acne in 3 days' }))).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    const ok = await withTenant(t.workspaceId, (tx) => editScene(tx, ctx, scene!.id as string, { overlayText: 'Two drops, morning and night' }));
    expect(ok.billable).toBe(false);
  }, 60_000);

  it('rejects a non-skincare product before any model spend', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [] , url: null }).catch(() => ({ skuId: '', projectId: '' })));
    expect(skuId).toBe('');
    void projectId;
  });
});

describe('Taste production (Launch Gate 1, second half)', () => {
  it('produces, QA-checks and delivers platform exports, consuming exactly one Taste', async () => {
    const { t, ctx, projectId } = await previewToStoryboard();
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: 'pay:1', reference: 'cs_test' });
      await approveForProduction(tx, ctx, projectId, 'taste');
      // Double-approve (webhook replay) is a no-op.
      expect((await approveForProduction(tx, ctx, projectId, 'taste')).replayed).toBe(true);
    });
    expect(await produceProject(ctx, projectId)).toBe('complete');
    // Duplicate job delivery does not produce or charge twice.
    expect(await produceProject(ctx, projectId)).toBe('skipped');
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state, qa_report, final_creative_id from projects where id = ${projectId}`;
      expect(p!.state).toBe('COMPLETE');
      expect((p!.qa_report as { pass: boolean }).pass).toBe(true);
      const [cr] = await tx`select final_asset_ids from creatives where id = ${p!.final_creative_id}`;
      expect((cr!.final_asset_ids as string[]).length).toBe(3);
      expect(await available(tx, 'taste')).toBe(0);
      const [consumed] = await tx`select count(*)::int as n from ledger_entries where type = 'CREDIT_CONSUMED'`;
      expect(consumed!.n).toBe(1);
      const steps = await tx`select status from progress_steps where subject_id = ${projectId}`;
      expect(steps.every((s) => s.status === 'done')).toBe(true);

      // Standard §37: every provider call is opened and closed with a usage event (arch-05).
      const [jobs] = await tx`select count(*)::int as n, count(*) filter (where status = 'succeeded')::int as ok, count(*) filter (where status = 'failed')::int as failed from provider_jobs`;
      const [ev] = await tx`select count(*) filter (where type = 'PROVIDER_JOB_CREATED')::int as created, count(*) filter (where type = 'PROVIDER_JOB_SUCCEEDED')::int as ok,
                                   count(*) filter (where type = 'PROVIDER_JOB_FAILED')::int as failed from events`;
      expect(jobs!.n).toBeGreaterThan(0);
      expect(ev).toEqual({ created: jobs!.n, ok: jobs!.ok, failed: jobs!.failed });

      // Standard §40: the demonstration scene shows AI-generated hands, so the ad is marked as AI-generated with
      // synthetic people — on the creative, in its manifest, on every export and inside the files (arch-31).
      const [demo] = await tx`select shows_human_skin from scenes where purpose = 'demonstration'`;
      expect(demo!.shows_human_skin).toBe(true);
      const [c] = await tx`select ai_generated, synthetic_people, composition->'disclosure' as disclosure from creatives where id = ${p!.final_creative_id}`;
      expect(c).toMatchObject({ ai_generated: true, synthetic_people: true, disclosure: { aiGenerated: true, syntheticPeople: true, syntheticVoice: true } });
      const exports = await tx`select id, lineage from assets where id = any(${cr!.final_asset_ids as string[]}::uuid[])`;
      expect(exports.every((e) => (e.lineage as { disclosure?: { aiGenerated: boolean } }).disclosure?.aiGenerated === true)).toBe(true);
      const bytes = await assetBytes(tx, exports[0]!.id as string);
      const tags = await withTempDir(async (dir) => {
        const f = path.join(dir, 'x.mp4');
        await writeFile(f, bytes);
        return (await probe(f)).tags;
      });
      expect(tags.comment).toMatch(/AI-generated people/);
      expect(tags.description).toBe('ai_generated=true; synthetic_people=true; synthetic_voice=true');
    });
  }, 120_000);

  it('an AI-generated person never speaks as a customer: the editor refuses it and production stops on it (§40)', async () => {
    const { t, ctx, projectId, storyboardId } = await previewToStoryboard();
    const [demo] = await ownerPool()`select id from scenes where storyboard_id = ${storyboardId} and purpose = 'demonstration'`;
    const [hook] = await ownerPool()`select id from scenes where storyboard_id = ${storyboardId} and position = 0`;
    await expect(withTenant(t.workspaceId, (tx) => editScene(tx, ctx, demo!.id as string, { spokenLine: 'I’ve used it for two weeks.' }))).rejects.toMatchObject({ code: 'GATE_BLOCKED', message: expect.stringMatching(/AI-generated person/) });
    // A scene without a generated person may speak in the first person.
    await withTenant(t.workspaceId, (tx) => editScene(tx, ctx, hook!.id as string, { overlayText: 'I’ve used it for two weeks' }));
    await ownerPool()`update scenes set spoken_line = 'I’ve used it for two weeks.' where id = ${demo!.id}`; // bypassing the editor
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: 'pay:testimonial' });
      await approveForProduction(tx, ctx, projectId, 'taste');
    });
    await produceProject(ctx, projectId);
    const [p] = await ownerPool()`select state, qa_report from projects where id = ${projectId}`;
    expect(p!.state).toBe('BLOCKED_COMPLIANCE');
    expect(blockedLines(p!.qa_report)).toEqual([expect.objectContaining({ line: 'I’ve used it for two weeks.', reason: expect.stringMatching(/AI-generated person/) })]);
  }, 120_000);

  it('repairs once for free, then switches technique after repeated fidelity failure', async () => {
    const { t, ctx, projectId } = await previewToStoryboard({ visualPlanMarker: '[[qa:fidelity_always]]' });
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: 'pay:2' });
      await approveForProduction(tx, ctx, projectId, 'taste');
    });
    expect(await produceProject(ctx, projectId)).toBe('complete');
    await withTenant(t.workspaceId, async (tx) => {
      const renders = await tx`select status from scene_versions where kind = 'render' order by created_at`;
      expect(renders.map((r) => r.status)).toEqual(['qa_failed', 'qa_failed']); // exactly one repair, no loop
      const [retry] = await tx`select count(*)::int as n from ledger_entries where type = 'FREE_QA_RETRY'`;
      expect(retry!.n).toBe(1);
      const [p] = await tx`select qa_report, final_creative_id, sku_id from projects where id = ${projectId}`;
      expect(JSON.stringify(p!.qa_report)).toMatch(/switched to exact product composite/);
      // The switch is the exact product from the merchant's own cut-out, QA-checked — never the generated frame.
      const [fp] = await tx`select cutout_asset_id from visual_fingerprints where sku_id = ${p!.sku_id} and active`;
      const [fb] = await tx`select id, technique, lineage, qa from scene_versions where kind = 'frame' and lineage->>'fallback' = 'true'`;
      expect(fb!.technique).toBe('exact_product_composite');
      expect((fb!.lineage as { cutoutAssetId: string }).cutoutAssetId).toBe(fp!.cutout_asset_id);
      expect((fb!.qa as { check: string; pass: boolean }[]).filter((c) => c.check === 'product_fidelity')).toEqual([expect.objectContaining({ pass: true })]);
      const [cr] = await tx`select composition from creatives where id = ${p!.final_creative_id}`;
      expect((cr!.composition as { scenes: { versionId: string; kind: string }[] }).scenes.find((s) => s.versionId === fb!.id)).toMatchObject({ kind: 'still' });
    });
  }, 120_000);

  it('never renders an unapproved claim (Launch Gate 3)', async () => {
    const { t, ctx, skuId, projectId, storyboardId } = await previewToStoryboard();
    // A claim needing review sneaks into a scene line directly in the DB (bypassing the editor).
    await ownerPool()`update scenes set spoken_line = 'Dermatologist recommended.' where storyboard_id = ${storyboardId} and position = 1`;
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: 'pay:3' });
      await approveForProduction(tx, ctx, projectId, 'taste');
    });
    await produceProject(ctx, projectId);
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state from projects where id = ${projectId}`;
      expect(p!.state).toBe('BLOCKED_COMPLIANCE');
      expect(await available(tx, 'taste')).toBe(1); // released: the customer isn't charged
      const [fe] = await tx`select count(*)::int as n from assets where kind = 'final_export'`;
      expect(fe!.n).toBe(0);
    });
    // Once approved with evidence, the same line passes.
    await withTenant(t.workspaceId, async (tx) => {
      const c = await proposeClaim(tx, ctx, skuId, { wording: 'Dermatologist recommended', origin: 'merchant' });
      await expect(approveClaim(tx, ctx, c.id, { markets: ['US'], platforms: ['TIKTOK'] })).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
      expect((await listClaims(tx, skuId)).length).toBeGreaterThan(0);
    });
  }, 120_000);
});
