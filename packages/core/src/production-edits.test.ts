import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, startPreview } from './analysis';
import { approveClaim, proposeClaim } from './claims';
import { approveExperiment, createExperiment } from './experiments';
import { append, available, currentPeriodKey } from './ledger';
import { mockConcepts } from './mock-intel';
import { approveForProduction, archiveExperiment, blockedLines, finishAfterEdit, impliedFlags, produceProject, reopenForEdit } from './production';
import { editScene, generateStoryboard, selectConcept } from './storyboard';
import { toSrt, withTempDir } from '@arkiv/media';
import { assetBytes } from './assets';
import type { CompositionManifest } from './composition';
import { deliveryBundle, recordAssetExport } from './exports';
import { applyDeliveredTextEdit, composeFromManifest, requestTextEdit } from './recompose';
import { assertLineageComplete } from './qa';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';

/**
 * Production edits and gates (wp25): the claims gate before any spend, archiving a test cancels its production,
 * implied-claim flags as the compliance queue reads them.
 */
beforeEach(truncateAll);
afterAll(closeAll);

async function storyboardReady() {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
  await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
  return { t, ctx, skuId, projectId, storyboardId };
}

const videoJobs = async (workspaceId: string) => (await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${workspaceId} and task = 'video.scene'`)[0]!.n as number;

describe('claims gate before any spend (standard §25, Launch Gate 3: prod-14)', () => {
  it('a claim revoked after approval stops the ad before any render is paid for; the fixed line resumes to delivery', async () => {
    const r = await storyboardReady();
    const [scene] = await ownerPool()`select id from scenes where storyboard_id = ${r.storyboardId} and position = 1`;
    await ownerPool()`update scenes set spoken_line = 'Non-comedogenic.' where id = ${scene!.id}`;
    const claimId = await withTenant(r.t.workspaceId, async (tx) => {
      const c = await proposeClaim(tx, r.ctx, r.skuId, { wording: 'Non-comedogenic', origin: 'merchant' });
      await approveClaim(tx, r.ctx, c.id, { markets: ['US'], platforms: ['tiktok', 'meta', 'youtube', 'organic'] });
      await append(tx, r.ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: `pay:${r.projectId}` });
      await approveForProduction(tx, r.ctx, r.projectId, 'taste');
      return c.id;
    });
    await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, status, created_by, paid_at)
                      values (${r.t.workspaceId}, 'taste', ${r.projectId}, 19000000, 'paid', 'test', now())`;
    // Revoked between approval and production (e.g. its evidence was withdrawn).
    await ownerPool()`update claims set status = 'BLOCKED', block_reason = 'evidence withdrawn' where id = ${claimId}`;

    expect(await produceProject(r.ctx, r.projectId)).toBe('failed');
    const [p] = await ownerPool()`select state, failure_code, qa_report from projects where id = ${r.projectId}`;
    expect(p).toMatchObject({ state: 'BLOCKED_COMPLIANCE', failure_code: 'claims_blocked' });
    expect((p!.qa_report as { stage: string }).stage).toBe('pre_spend');
    expect(blockedLines(p!.qa_report).map((l) => l.line)).toContain('Non-comedogenic.');
    expect(await videoJobs(r.t.workspaceId)).toBe(0);
    expect((await ownerPool()`select count(*)::int as n from cost_authorizations where project_id = ${r.projectId} and idempotency_key like 'produce:%'`)[0]!.n).toBe(0);
    expect(await withTenant(r.t.workspaceId, (tx) => available(tx, 'taste'))).toBe(1);

    await withTenant(r.t.workspaceId, (tx) => reopenForEdit(tx, r.ctx, r.projectId));
    await withTenant(r.t.workspaceId, (tx) => editScene(tx, r.ctx, scene!.id as string, { spokenLine: 'Morning and night, after cleansing.' }));
    await withTenant(r.t.workspaceId, (tx) => finishAfterEdit(tx, r.ctx, r.projectId));
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    expect(await withTenant(r.t.workspaceId, (tx) => available(tx, 'taste'))).toBe(0);
  }, 240_000);

  it('a paused run whose line was revoked is blocked when it resumes, and its held reservation goes back', async () => {
    const r = await storyboardReady();
    await withTenant(r.t.workspaceId, async (tx) => {
      await append(tx, r.ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: `pay:${r.projectId}` });
      await approveForProduction(tx, r.ctx, r.projectId, 'taste');
    });
    // Renders paused (kill switch): the run reserves, then queues holding the customer's place.
    await ownerPool()`update feature_flags set enabled = true where key = 'kill.renders'`;
    try {
      expect(await produceProject(r.ctx, r.projectId)).toBe('paused');
    } finally {
      await ownerPool()`update feature_flags set enabled = false where key = 'kill.renders'`;
    }
    const [held] = await ownerPool()`select status from cost_authorizations where project_id = ${r.projectId} and idempotency_key like 'produce:%'`;
    expect(held!.status).toBe('active');
    await ownerPool()`update scenes set overlay_text = 'Cures acne overnight' where storyboard_id = ${r.storyboardId} and position = 1`;
    expect(await produceProject(r.ctx, r.projectId)).toBe('failed');
    const [p] = await ownerPool()`select state from projects where id = ${r.projectId}`;
    expect(p!.state).toBe('BLOCKED_COMPLIANCE');
    const [a] = await ownerPool()`select status from cost_authorizations where project_id = ${r.projectId} and idempotency_key like 'produce:%'`;
    expect(a!.status).toBe('released');
    expect(await videoJobs(r.t.workspaceId)).toBe(0);
    expect(await withTenant(r.t.workspaceId, (tx) => available(tx, 'taste'))).toBe(1);
  }, 240_000);
});

describe('archiving a test cancels its production (standard §25 cancellation before dispatch: prod-11)', () => {
  it('archive before dispatch: the produce job ends, the Creative Test comes back, the experiment is archived', async () => {
    const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const skuId = await makeSku(t.workspaceId);
    const proposal = mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;
    const r = await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 2, periodKey: await currentPeriodKey(tx, t.workspaceId), idempotencyKey: 'grant:archive' });
      return createExperiment(tx, ctx, { skuId, proposal });
    });
    const [c] = await ownerPool()`select selected_concept_id from projects where id = ${r.projectId}`;
    await generateStoryboard(ctx, r.projectId, r.storyboardId, c!.selected_concept_id as string);
    await withTenant(t.workspaceId, (tx) => approveExperiment(tx, ctx, r.experimentId));
    const [approved] = await ownerPool()`select state from projects where id = ${r.projectId}`;
    expect(approved!.state).toBe('STORYBOARD_APPROVED');

    const out = await withTenant(t.workspaceId, (tx) => archiveExperiment(tx, ctx, r.experimentId));
    expect(out.cancelled).toEqual([expect.objectContaining({ projectId: r.projectId, status: 'cancelled' })]);
    const [p] = await ownerPool()`select state from projects where id = ${r.projectId}`;
    expect(p!.state).toBe('CANCELLED');
    const [e] = await ownerPool()`select state from experiments where id = ${r.experimentId}`;
    expect(e!.state).toBe('ARCHIVED');
    // The queued produce job finds a cancelled project and spends nothing.
    expect(await produceProject(ctx, r.projectId)).toBe('skipped');
    expect(await videoJobs(t.workspaceId)).toBe(0);
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(2);
  }, 120_000);
});

describe('implied-claim flags (standard §25.3: prod-19)', () => {
  it('lists deterministic and reviewer flags as one array for the compliance queue', () => {
    const flags = impliedFlags({
      check: 'claims',
      pass: false,
      hard: true,
      detail: 'x',
      data: { deterministic: [{ text: 'Acne gone in 3 days', claim: 'a skin condition that disappears' }], impliedClaims: [{ claim: 'Looks like a clinic', basis: 'visual', severity: 'review', scene: 2 }] },
    });
    expect(flags).toEqual([
      { claim: 'a skin condition that disappears', basis: 'text', severity: 'block', scene: null, text: 'Acne gone in 3 days' },
      { claim: 'Looks like a clinic', basis: 'visual', severity: 'review', scene: 2 },
    ]);
  });
});

async function delivered() {
  const r = await storyboardReady();
  await withTenant(r.t.workspaceId, async (tx) => {
    await append(tx, r.ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: `pay:${r.projectId}` });
    await approveForProduction(tx, r.ctx, r.projectId, 'taste');
  });
  expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
  const [c] = await ownerPool()`select c.id, c.composition, c.captions_asset_id from projects p join creatives c on c.id = p.final_creative_id where p.id = ${r.projectId}`;
  return { ...r, creativeId: c!.id as string, manifest: c!.composition as CompositionManifest, captionsAssetId: c!.captions_asset_id as string | null };
}

describe('delivered ad: SRT, reproducible composition, text edits (plan 06 Phase 3 #6, standard §24/§25: prod-28, prod-33, prod-12)', () => {
  it('stores the SRT as its own downloadable asset, and recomposing the manifest reproduces the timeline', async () => {
    const r = await delivered();
    expect(r.captionsAssetId).toBeTruthy();
    const [a] = await ownerPool()`select kind, mime from assets where id = ${r.captionsAssetId}`;
    expect(a).toMatchObject({ kind: 'captions', mime: 'application/x-subrip' });
    const srt = (await withTenant(r.t.workspaceId, (tx) => assetBytes(tx, r.captionsAssetId!))).toString('utf8');
    expect(srt).toBe(toSrt(r.manifest.captions));
    // Each export points at it, the SRT isn't a video export, and downloading it is recorded against the project.
    const exportsLineage = await ownerPool()`select lineage->>'captionsAssetId' as c from assets where kind = 'final_export' and lineage->>'projectId' = ${r.projectId}`;
    expect(exportsLineage.every((e) => e.c === r.captionsAssetId)).toBe(true);
    expect(await withTenant(r.t.workspaceId, (tx) => recordAssetExport(tx, r.ctx, r.captionsAssetId!, r.projectId))).toMatchObject({ aspect: null });
    const bundle = await withTenant(r.t.workspaceId, (tx) => deliveryBundle(tx, r.ctx, r.projectId));
    expect(bundle!.files).toBe(r.manifest.aspects.length + 1);
    // §24: the composition is reproducible from its manifest (scene versions, voice clips, cues, end card).
    const outs = await withTempDir((dir) => composeFromManifest(r.t.workspaceId, r.manifest, dir));
    expect(outs.map((o) => o.aspect)).toEqual(r.manifest.aspects);
    expect(outs.every((o) => o.durationMs === r.manifest.durationMs)).toBe(true);
    expect(outs[0]!.srt).toBe(srt);
    // §25.7 lineage: each export names its authorization, rates, scene versions, models, claims, voice and composer.
    const [ex] = await ownerPool()`select id, lineage->'provenance' as pv from assets where kind = 'final_export' and lineage->>'projectId' = ${r.projectId} limit 1`;
    expect(ex!.pv).toMatchObject({ authorizationId: expect.any(String), sceneVersionIds: r.manifest.scenes.map((s) => s.versionId), composer: expect.stringMatching(/^composer@/) });
    expect(Object.keys((ex!.pv as { rateTableVersions: object }).rateTableVersions).length).toBeGreaterThan(0);
    for (const g of (ex!.pv as { generated: { model: string | null; promptVersion: string | null }[] }).generated) expect(g).toMatchObject({ model: expect.any(String), promptVersion: expect.any(String) });
    const [rep] = await ownerPool()`select qa_report from projects where id = ${r.projectId}`;
    expect((rep!.qa_report as { checks: { detail: string }[] }).checks.some((c) => /^Lineage complete/.test(c.detail))).toBe(true);
    await withTenant(r.t.workspaceId, async (tx) => {
      expect(await assertLineageComplete(tx, ex!.id as string, { spoken: true })).toMatchObject({ pass: true });
      // An asset with no provenance (here: the SRT) can't be accounted for: a hard failure.
      expect(await assertLineageComplete(tx, r.captionsAssetId!, { spoken: true })).toMatchObject({ pass: false, hard: true, detail: expect.stringMatching(/provenance/) });
    });
    // Every scene has its script version 1 from the storyboard.
    const scripts = await ownerPool()`select v.lineage->>'source' as source from scene_versions v join scenes s on s.id = v.scene_id where s.storyboard_id = ${r.storyboardId} and v.kind = 'script'`;
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((x) => x.source === 'storyboard')).toBe(true);
  }, 300_000);

  it('edits the words of a delivered ad without a render or a credit, and refuses a blocked line up front', async () => {
    const r = await delivered();
    const body = r.manifest.scenes;
    const spokenScene = body.find((s) => s.spokenText)!;
    const overlayScene = body.find((s) => s.sceneId !== spokenScene.sceneId) ?? body[0]!;
    // A line the claim rules refuse never queues.
    await expect(withTenant(r.t.workspaceId, (tx) => requestTextEdit(tx, r.ctx, r.projectId, { scenes: [{ sceneId: overlayScene.sceneId, overlayText: 'Cures acne overnight' }] }))).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    const viewer = { ...r.ctx, role: 'VIEWER' as const };
    await expect(withTenant(r.t.workspaceId, (tx) => requestTextEdit(tx, viewer, r.projectId, { cta: 'Shop the serum' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const edits = { scenes: [{ sceneId: overlayScene.sceneId, overlayText: 'Morning and night' }, { sceneId: spokenScene.sceneId, spokenLine: 'Smooth it on after cleansing.' }], cta: 'Shop the serum' };
    const tts = async () => (await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${r.t.workspaceId} and task like 'tts.%'`)[0]!.n as number;
    const ttsBefore = await tts();
    const videoBefore = await videoJobs(r.t.workspaceId);
    expect(await withTenant(r.t.workspaceId, (tx) => requestTextEdit(tx, r.ctx, r.projectId, edits))).toEqual({ queued: true, revoiced: 1 });
    const [job] = await ownerPool()`select payload as data from outbox where queue = 'recompose-project' and payload->>'projectId' = ${r.projectId} order by created_at desc limit 1`;
    expect((job!.data as { edits: unknown }).edits).toEqual(edits);
    // A second request while the first waits is refused (one edit at a time).
    await expect(withTenant(r.t.workspaceId, (tx) => requestTextEdit(tx, r.ctx, r.projectId, { cta: 'Buy now' }))).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await applyDeliveredTextEdit(r.ctx, r.projectId, edits, r.creativeId)).toBe('recomposed');
    const [p] = await ownerPool()`select p.final_creative_id, c.parent_creative_id, c.composition, c.captions_asset_id from projects p join creatives c on c.id = p.final_creative_id where p.id = ${r.projectId}`;
    expect(p!.final_creative_id).not.toBe(r.creativeId);
    expect(p!.parent_creative_id).toBe(r.creativeId);
    const m = p!.composition as CompositionManifest;
    expect(m.scenes.find((s) => s.sceneId === overlayScene.sceneId)!.overlayText).toBe('Morning and night');
    expect(m.scenes.find((s) => s.sceneId === spokenScene.sceneId)!.spokenText).toBe('Smooth it on after cleansing.');
    expect(m.endCard.cta).toBe('Shop the serum');
    // Same footage: every scene keeps its asset; captions follow the new spoken line.
    expect(m.scenes.map((s) => s.assetId)).toEqual(r.manifest.scenes.map((s) => s.assetId));
    expect(m.captions.map((c) => c.text).join(' ')).toContain('Smooth it on');
    const srt = (await withTenant(r.t.workspaceId, (tx) => assetBytes(tx, p!.captions_asset_id as string))).toString('utf8');
    expect(srt).toContain('Smooth it on');
    // One short voice line for the changed line, no render, no credit.
    expect(await tts()).toBe(ttsBefore + 1);
    expect(await videoJobs(r.t.workspaceId)).toBe(videoBefore);
    expect(await withTenant(r.t.workspaceId, (tx) => available(tx, 'taste'))).toBe(0);
    const [entries] = await ownerPool()`select count(*)::int as n from ledger_entries where project_id = ${r.projectId} and type = 'CREDIT_CONSUMED'`;
    expect(entries!.n).toBe(1);
    // The storyboard follows, each edited scene with a new script version (§24).
    const [sc] = await ownerPool()`select overlay_text from scenes where id = ${overlayScene.sceneId}`;
    expect(sc!.overlay_text).toBe('Morning and night');
    const edited = await ownerPool()`select scene_id from scene_versions where kind = 'script' and lineage->>'source' = 'delivered_edit'`;
    expect(edited.map((e) => e.scene_id).sort()).toEqual([overlayScene.sceneId, spokenScene.sceneId].sort());
    const [st] = await ownerPool()`select status from progress_steps where subject_id = ${r.projectId} and step_key = 'text_edit'`;
    expect(st!.status).toBe('done');
    // A stale edit (the ad changed since it was asked for) is not applied onto the new version.
    expect(await applyDeliveredTextEdit(r.ctx, r.projectId, { cta: 'Buy now' }, r.creativeId)).toBe('unchanged');
  }, 300_000);
});
