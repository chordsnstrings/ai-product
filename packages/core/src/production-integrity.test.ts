import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { MockImage, MockLlm, MockTts, MockVideo, ProviderError, setProviders, type LlmJsonRequest, type LlmJsonResult } from '@arkiv/providers';
import { COST_LIMITS } from '@arkiv/shared';
import { analyzeProduct, startPreview } from './analysis';
import { approveClaim, proposeClaim } from './claims';
import type { CompositionManifest } from './composition';
import { authorize } from './cost-governor';
import { available, append } from './ledger';
import { generateVideo } from './model-gateway';
import { approveForProduction, blockedLines, cancelProduction, failProduction, finishAfterEdit, produceProject, reopenForEdit, resumableAfterEdit, retryProduction } from './production';
import { clearSettingsCache } from './settings';
import { customerReason } from './projects';
import { firstRenderAcceptance, repeatedFidelityFailures } from './qa-metrics';
import { recordAssetExport } from './exports';
import { emit } from './events';
import { editScene, generateStoryboard, selectConcept } from './storyboard';
import { ctxFor, productPhoto } from './testing';
import { ingestBytes } from './uploads';

/**
 * Production integrity (wp04): routed pricing and the 25% repair reserve, exact-product composites, per-scene
 * voice with captions, kill switch and fallback routes, render reuse on retry, Claim ID mapping and the
 * repeated-fidelity KPI.
 */
beforeEach(truncateAll);
afterAll(closeAll);

type Ready = Awaited<ReturnType<typeof storyboardReady>>;

async function storyboardReady(opts: { photo?: Buffer } = {}) {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, opts.photo ?? (await productPhoto()), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
  await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
  return { t, ctx, skuId, projectId, storyboardId };
}

async function approve(r: Ready) {
  await withTenant(r.t.workspaceId, async (tx) => {
    await append(tx, r.ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: `pay:${r.projectId}` });
    await approveForProduction(tx, r.ctx, r.projectId, 'taste');
  });
}

const produceAuth = async (projectId: string) =>
  (await ownerPool()`select id, status, estimate, max_cost_micros, spent_micros, expires_at > now() + interval '5 hours' as held from cost_authorizations
                     where project_id = ${projectId} and idempotency_key like 'produce:%' order by created_at`) as unknown as { id: string; status: string; estimate: { lines: { line: { kind: string; model?: string; retryReserve?: boolean } }[]; totalMicros: number }; held: boolean }[];

const manifestOf = async (projectId: string) =>
  ((await ownerPool()`select c.composition from projects p join creatives c on c.id = p.final_creative_id where p.id = ${projectId}`)[0]!.composition) as CompositionManifest;

describe('pricing on the routed model (§6, §37: arch-21)', () => {
  it('re-routing video.scene to another priced model changes the estimate and the recorded actual cost', async () => {
    await ownerPool()`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, status)
                      values ('byteplus', 'reroute-test-video', 1, 'per_second', ${ownerPool().json({ per_second_720p: 100_000, per_second_1080p: 200_000 })}, now() - interval '1 hour', 'published')`;
    const [orig] = await ownerPool()`select model from model_routes where task = 'video.scene'`;
    await ownerPool()`update model_routes set model = 'reroute-test-video' where task = 'video.scene'`;
    try {
      const r = await storyboardReady();
      await approve(r);
      expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
      const [a] = await produceAuth(r.projectId);
      const videos = a!.estimate.lines.filter((l) => l.line.kind === 'video');
      expect(videos.length).toBeGreaterThan(0);
      expect(videos.every((l) => l.line.model === 'reroute-test-video')).toBe(true);
      const jobs = await ownerPool()`select model, actual_micros from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'video.scene'`;
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs.map((j) => ({ model: j.model, actual: Number(j.actual_micros) }))).toEqual(jobs.map(() => ({ model: 'reroute-test-video', actual: 5 * 100_000 })));
    } finally {
      await ownerPool()`update model_routes set model = ${orig!.model as string} where task = 'video.scene'`;
      await ownerPool()`delete from provider_rate_tables where model = 'reroute-test-video'`;
    }
  }, 240_000);
});

describe('QA repair reserve and technique switch (§5, §6, §25, §44: arch-22, prod-04)', () => {
  it('a 4-scene plan stays under the ceiling, repairs once from the reserve, then composites the exact product', async () => {
    const r = await storyboardReady();
    // Four generated-interaction scenes that each fail product QA once.
    await ownerPool()`update scenes set production_mode = 'GENERATIVE_INTERACTION', visual_plan = visual_plan || ' [[qa:fidelity]]'
                      where storyboard_id = ${r.storyboardId} and purpose <> 'cta'`;
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');

    const [a] = await produceAuth(r.projectId);
    expect(a!.estimate.totalMicros).toBeLessThanOrEqual(COST_LIMITS.CREATIVE_TEST_CEILING);
    const videos = a!.estimate.lines.filter((l) => l.line.kind === 'video');
    expect(videos).toHaveLength(4); // one render each (25% reserve inside each line), no second render per scene
    expect(videos.every((l) => l.line.retryReserve !== false)).toBe(true);

    const scenes = await ownerPool()`select s.id, s.position, array(select v.status from scene_versions v where v.scene_id = s.id and v.kind = 'render' order by v.version) as renders
                                     from scenes s where s.storyboard_id = ${r.storyboardId} and s.purpose <> 'cta' order by s.position`;
    // The reserve (25% of 20s = one 5s repair) funds the first scene's repair; the rest switch technique at once.
    expect(scenes.map((s) => s.renders)).toEqual([['qa_failed', 'accepted'], ['qa_failed'], ['qa_failed'], ['qa_failed']]);
    const [retries] = await ownerPool()`select count(*)::int as n from ledger_entries where workspace_id = ${r.t.workspaceId} and type = 'FREE_QA_RETRY'`;
    expect(retries!.n).toBe(1);

    // The switch is a real, QA-checked exact-product composite from the merchant's cut-out — not a generated frame.
    const [fp] = await ownerPool()`select cutout_asset_id from visual_fingerprints where sku_id = ${r.skuId} and active`;
    const fallbacks = await ownerPool()`select scene_id, technique, lineage, qa, status from scene_versions where workspace_id = ${r.t.workspaceId} and kind = 'frame' and lineage->>'fallback' = 'true'`;
    expect(fallbacks).toHaveLength(3);
    for (const f of fallbacks) {
      expect(f.technique).toBe('exact_product_composite');
      expect((f.lineage as Record<string, unknown>).cutoutAssetId).toBe(fp!.cutout_asset_id);
      expect((f.qa as { check: string; pass: boolean }[]).find((c) => c.check === 'product_fidelity')).toMatchObject({ pass: true });
    }
    const m = await manifestOf(r.projectId);
    expect(m.scenes.map((s) => [s.kind, s.technique])).toEqual([
      ['video', 'generative'],
      ['still', 'exact_product_composite'],
      ['still', 'exact_product_composite'],
      ['still', 'exact_product_composite'],
    ]);
    const spent = await ownerPool()`select spent_micros, max_cost_micros from cost_authorizations where id = ${a!.id}`;
    expect(Number(spent[0]!.spent_micros)).toBeLessThanOrEqual(Number(spent[0]!.max_cost_micros));
  }, 300_000);
});

describe('renders kill switch (§44 "preserve reservation": prod-10)', () => {
  it('reserves the place, pauses without dispatching, and resumes once the switch is off', async () => {
    const r = await storyboardReady();
    await approve(r);
    await ownerPool()`update feature_flags set enabled = true where key = 'kill.renders'`;
    expect(await produceProject(r.ctx, r.projectId)).toBe('paused');
    const [p] = await ownerPool()`select state, outage from projects where id = ${r.projectId}`;
    expect(p!.state).toBe('NEEDS_USER_ACTION');
    expect((p!.outage as { task: string }).task).toBe('renders');
    const [a] = await produceAuth(r.projectId);
    expect(a).toMatchObject({ status: 'active', held: true });
    expect(await withTenant(r.t.workspaceId, (tx) => available(tx, 'taste'))).toBe(0); // the place is held
    const [jobs] = await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'video.scene'`;
    expect(jobs!.n).toBe(0);
    // The gateway refuses renders too, whoever holds a token.
    const other = await withTenant(r.t.workspaceId, (tx) => authorize(tx, r.ctx, { purpose: 'creative_test', lines: [{ kind: 'media', outputs: 1 }], idempotencyKey: 'kill-probe', reserveWhileRendersPaused: true }));
    await expect(generateVideo({ ctx: r.ctx, token: other.token, task: 'video.scene', prompt: 'x', references: [], seconds: 5, resolution: '720p', ratio: '9:16' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    await ownerPool()`update feature_flags set enabled = false where key = 'kill.renders'`;
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    const [n] = await ownerPool()`select count(*) filter (where type = 'CREDIT_RESERVED')::int as reserved, count(*) filter (where type = 'CREDIT_CONSUMED')::int as consumed
                                  from ledger_entries where workspace_id = ${r.t.workspaceId}`;
    expect(n).toMatchObject({ reserved: 1, consumed: 1 });
    expect(await produceAuth(r.projectId)).toHaveLength(1);
  }, 240_000);

  it('keeps the outage clock across resume attempts, so an outage that never recovers ends and returns the credit', async () => {
    const r = await storyboardReady();
    await ownerPool()`update scenes set visual_plan = visual_plan || ' [[fail:render]]' where storyboard_id = ${r.storyboardId} and production_mode = 'GENERATIVE_INTERACTION'`;
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('paused');
    // A resume attempt that meets the same outage continues the same episode (attempts accumulate for backoff).
    expect(await produceProject(r.ctx, r.projectId)).toBe('paused');
    const [p1] = await ownerPool()`select outage from projects where id = ${r.projectId}`;
    expect((p1!.outage as { attempts: number }).attempts).toBe(2);
    // Six hours on, the next attempt gives up: PROVIDER_FAILED, entitlement returned.
    await ownerPool()`update projects set outage = jsonb_set(outage, '{since}', to_jsonb((now() - interval '7 hours')::text)) where id = ${r.projectId}`;
    expect(await produceProject(r.ctx, r.projectId)).toBe('failed');
    const [p2] = await ownerPool()`select state, outage from projects where id = ${r.projectId}`;
    expect(p2).toMatchObject({ state: 'PROVIDER_FAILED', outage: null });
    expect(await withTenant(r.t.workspaceId, (tx) => available(tx, 'taste'))).toBe(1);
  }, 240_000);
});

describe('voice per scene, captions from speech, approved TTS fallback (§25 check 4, §34: prod-27, prod-29)', () => {
  it('voices each spoken line in its scene, captions what is said, and uses the fallback route when the primary circuit is open', async () => {
    const r = await storyboardReady();
    await approve(r);
    await ownerPool()`update model_routes set circuit_open = true where task = 'tts.voiceover'`;
    try {
      expect(await produceProject(r.ctx, r.projectId)).toBe('complete'); // not paused: an approved fallback exists
    } finally {
      await ownerPool()`update model_routes set circuit_open = false where task = 'tts.voiceover'`;
    }
    const spoken = await ownerPool()`select id, spoken_line from scenes where storyboard_id = ${r.storyboardId} and coalesce(spoken_line, '') <> '' order by position`;
    const tts = await ownerPool()`select task, provider, subject_id from provider_jobs where workspace_id = ${r.t.workspaceId} and task like 'tts.%' order by created_at`;
    const [fb] = await ownerPool()`select provider from model_routes where task = 'tts.voiceover_fallback'`;
    expect(tts.map((j) => j.subject_id)).toEqual(spoken.map((s) => s.id)); // one line per scene
    expect(tts.every((j) => j.task === 'tts.voiceover_fallback' && j.provider === fb!.provider)).toBe(true);

    const m = await manifestOf(r.projectId);
    const segs = m.voiceover!.segments;
    expect(segs.map((s) => s.text)).toEqual(spoken.map((s) => (s.spoken_line as string).trim()));
    // Each line starts inside its own scene's window and lines never overlap.
    let t = 0;
    const windows = new Map(m.scenes.map((s) => { const w = [t, t + s.durationMs]; t += s.durationMs; return [s.sceneId, w] as const; }));
    for (const [i, s] of segs.entries()) {
      const w = windows.get(s.sceneId) ?? [t, t + m.endCard.durationMs];
      expect(s.startMs).toBeGreaterThanOrEqual(w[0]!);
      expect(s.startMs).toBeLessThan(w[1]!);
      if (i) expect(s.startMs).toBeGreaterThanOrEqual(segs[i - 1]!.endMs);
    }
    const exports = await ownerPool()`select lineage from assets where workspace_id = ${r.t.workspaceId} and kind = 'final_export'`;
    expect(exports).toHaveLength(3);
    for (const e of exports) {
      const srt = (e.lineage as { srt: string }).srt;
      for (const s of spoken) for (const word of (s.spoken_line as string).split(/\s+/)) expect(srt).toContain(word);
    }
  }, 240_000);
});

async function busyPhoto(): Promise<Buffer> {
  // A product shot on a busy, noisy background: border keying is unreliable, so no clean cut-out exists.
  const noise = await sharp({ create: { width: 1000, height: 1250, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 90 } } }).png().toBuffer();
  const product = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1250">
    <rect x="330" y="360" width="340" height="620" rx="36" fill="#C9A27E"/><rect x="360" y="560" width="280" height="200" fill="#FFFFFF"/></svg>`);
  return sharp(noise).composite([{ input: product }]).jpeg({ quality: 90 }).toBuffer();
}

describe('strict product composites (§23: prod-02) and Claim IDs per scene (§25 check 3, §24: prod-18)', () => {
  it('composites the exact product on a clean backdrop, then on a QA-checked generated setting; scenes record their Claim IDs', async () => {
    const r = await storyboardReady();
    const [fp] = await ownerPool()`select cutout_asset_id from visual_fingerprints where sku_id = ${r.skuId} and active`;
    const frames = await ownerPool()`select s.purpose, v.technique, v.lineage from scenes s join scene_versions v on v.id = s.current_version_id
                                     where s.storyboard_id = ${r.storyboardId} and s.production_mode = 'STRICT_COMPOSITE' order by s.position`;
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const f of frames) {
      expect(f.technique).toBe('exact_product_composite');
      expect(f.lineage).toMatchObject({ cutoutAssetId: fp!.cutout_asset_id, backdrop: 'production' });
    }
    // A scene line that uses an approved claim.
    const claimId = await withTenant(r.t.workspaceId, async (tx) => {
      const c = await proposeClaim(tx, r.ctx, r.skuId, { wording: 'Non-comedogenic', origin: 'merchant' });
      await approveClaim(tx, r.ctx, c.id, { markets: ['US'], platforms: ['TIKTOK', 'META'] });
      return c.id;
    });
    const [routine] = await ownerPool()`update scenes set spoken_line = 'Non-comedogenic.' where storyboard_id = ${r.storyboardId} and purpose = 'routine' returning id`;
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');

    const [plates] = await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'image.environment_plate'`;
    const strictBody = await ownerPool()`select id from scenes where storyboard_id = ${r.storyboardId} and production_mode = 'STRICT_COMPOSITE' and purpose <> 'cta'`;
    expect(plates!.n).toBe(strictBody.length);
    const m = await manifestOf(r.projectId);
    for (const s of strictBody) {
      const entry = m.scenes.find((x) => x.sceneId === s.id)!;
      expect(entry.technique).toBe('exact_product_composite');
      const [v] = await ownerPool()`select lineage from scene_versions where id = ${entry.versionId}`;
      expect(v!.lineage).toMatchObject({ projectId: r.projectId, cutoutAssetId: fp!.cutout_asset_id });
      expect((v!.lineage as { plateAssetId?: string }).plateAssetId).toBeTruthy();
    }
    const [sc] = await ownerPool()`select claim_ids from scenes where id = ${routine!.id}`;
    expect(sc!.claim_ids).toEqual([claimId]);
    expect(m.scenes.find((s) => s.sceneId === routine!.id)!.claimIds).toEqual([claimId]);
    const [p] = await ownerPool()`select qa_report from projects where id = ${r.projectId}`;
    const claims = (p!.qa_report as { checks: { check: string; data?: { mapping?: { claimId: string | null }[]; claimsUsed?: number } }[] }).checks.find((c) => c.check === 'claims')!;
    expect(claims.data!.claimsUsed).toBe(1);
    expect(claims.data!.mapping!.some((x) => x.claimId === claimId)).toBe(true);
  }, 240_000);

  it('never composites an unkeyed cut-out: the photo is shown as is, with a clean-photo tip', async () => {
    const r = await storyboardReady({ photo: await busyPhoto() });
    const [cut] = await ownerPool()`select a.lineage->>'keyed' as keyed from visual_fingerprints f join assets a on a.id = f.cutout_asset_id where f.sku_id = ${r.skuId} and f.active`;
    expect(cut!.keyed).toBe('false');
    const frames = await ownerPool()`select v.technique from scenes s join scene_versions v on v.id = s.current_version_id
                                     where s.storyboard_id = ${r.storyboardId} and s.production_mode = 'STRICT_COMPOSITE'`;
    expect(frames.every((f) => f.technique === 'reference_photo')).toBe(true);
    const [step] = await ownerPool()`select detail from progress_steps where subject_id = ${r.storyboardId} and step_key = 'frames'`;
    expect(step!.detail).toMatch(/plain background/);
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    const [plates] = await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'image.environment_plate'`;
    expect(plates!.n).toBe(0);
  }, 240_000);

  it('a product claim with no approved Claim ID is refused in the editor and blocks production', async () => {
    const r = await storyboardReady();
    const [s] = await ownerPool()`select id from scenes where storyboard_id = ${r.storyboardId} and purpose = 'routine'`;
    await expect(withTenant(r.t.workspaceId, (tx) => editScene(tx, r.ctx, s!.id as string, { spokenLine: 'It hydrates all day.' }))).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    await ownerPool()`update scenes set spoken_line = 'It hydrates all day.' where id = ${s!.id}`; // bypassing the editor
    await approve(r);
    await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, stripe_checkout_session_id, status, created_by, paid_at)
                      values (${r.t.workspaceId}, 'taste', ${r.projectId}, 19000000, ${'cs_' + r.projectId}, 'paid', 'test', now())`;
    await produceProject(r.ctx, r.projectId);
    const [p] = await ownerPool()`select state, failure_reason, failure_code, qa_report from projects where id = ${r.projectId}`;
    expect(p!.state).toBe('BLOCKED_COMPLIANCE');
    // The customer sees mapped copy and the line itself (with why), never the raw check detail (surf-33).
    expect(p!.failure_code).toBe('claims_blocked');
    expect(customerReason(p!)).toBe('A line needs changing before we can finish your ad.');
    const blocked = blockedLines(p!.qa_report);
    expect(blocked.map((b) => b.line)).toEqual(['It hydrates all day.']);
    expect(blocked[0]!.reason).toMatch(/Claims Vault/);
    expect(blocked[0]!.platforms.length).toBeGreaterThan(0);
    expect(await withTenant(r.t.workspaceId, (tx) => available(tx, 'taste'))).toBe(1);
    const renders = async () => (await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'video.scene'`)[0]!.n as number;
    const rendered = await renders();

    // A way forward (surf-35): back to the storyboard, fix the line, finish — no new checkout, same credit.
    await expect(withTenant(r.t.workspaceId, (tx) => finishAfterEdit(tx, r.ctx, r.projectId))).rejects.toMatchObject({ code: 'CONFLICT' });
    const reopened = await withTenant(r.t.workspaceId, (tx) => reopenForEdit(tx, r.ctx, r.projectId));
    expect(reopened).toMatchObject({ storyboardId: r.storyboardId, replayed: false });
    expect(reopened.lines.map((l) => l.line)).toEqual(['It hydrates all day.']);
    expect(await withTenant(r.t.workspaceId, (tx) => reopenForEdit(tx, r.ctx, r.projectId))).toMatchObject({ replayed: true });
    const [again] = await ownerPool()`select p.state, sb.status, sb.approved_at from projects p join storyboards sb on sb.id = p.storyboard_id where p.id = ${r.projectId}`;
    expect(again).toMatchObject({ state: 'STORYBOARD_READY', status: 'ready' });
    expect(again!.approved_at).toBeTruthy();
    expect(await withTenant(r.t.workspaceId, (tx) => resumableAfterEdit(tx, r.t.workspaceId, r.projectId))).toBe(true);
    // Finishing without fixing the line is refused before any spend.
    await expect(withTenant(r.t.workspaceId, (tx) => finishAfterEdit(tx, r.ctx, r.projectId))).rejects.toMatchObject({ code: 'GATE_BLOCKED', message: expect.stringMatching(/It hydrates all day/) });
    await withTenant(r.t.workspaceId, (tx) => editScene(tx, r.ctx, s!.id as string, { spokenLine: 'Morning and night, after cleansing.' }));
    expect(await withTenant(r.t.workspaceId, (tx) => finishAfterEdit(tx, r.ctx, r.projectId))).toMatchObject({ replayed: false });
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    await withTenant(r.t.workspaceId, async (tx) => {
      expect(await available(tx, 'taste')).toBe(0);
      const [n] = await tx`select count(*) filter (where type = 'CREDIT_CONSUMED')::int as consumed, count(*) filter (where type = 'CREDIT_RELEASED')::int as released from ledger_entries`;
      expect(n).toMatchObject({ consumed: 1, released: 1 });
      const [pu] = await tx`select count(*)::int as n from purchases where project_id = ${r.projectId}`;
      expect(pu!.n).toBe(1); // no second checkout
    });
    expect(await renders()).toBe(rendered); // accepted renders were reused: fixing words costs no new footage
  }, 240_000);

  it('a claims block before any storyboard approval has nothing to reopen', async () => {
    const r = await storyboardReady();
    await ownerPool()`update projects set state = 'BLOCKED_COMPLIANCE' where id = ${r.projectId}`;
    await expect(withTenant(r.t.workspaceId, (tx) => reopenForEdit(tx, r.ctx, r.projectId))).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 120_000);
});

describe('retry reuses accepted renders (§35: prod-08)', () => {
  it('a failed production retried after its renders were accepted neither prices nor renders them again', async () => {
    const r = await storyboardReady();
    await ownerPool()`update scenes set spoken_line = 'Tap to try it. [[fail:server]]' where storyboard_id = ${r.storyboardId} and purpose = 'cta'`;
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('paused'); // voice outage after the scenes were rendered
    const renders = async () => (await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'video.scene'`)[0]!.n as number;
    const before = await renders();
    expect(before).toBeGreaterThan(0);
    await withTenant(r.t.workspaceId, (tx) => failProduction(tx, r.ctx, r.projectId, 'outage did not recover in time'));
    await ownerPool()`update scenes set spoken_line = 'Tap to try it.' where storyboard_id = ${r.storyboardId} and purpose = 'cta'`;
    await withTenant(r.t.workspaceId, (tx) => retryProduction(tx, r.ctx, r.projectId));
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    expect(await renders()).toBe(before);
    const auths = await produceAuth(r.projectId);
    expect(auths).toHaveLength(2);
    expect(auths[1]!.estimate.lines.filter((l) => l.line.kind === 'video')).toHaveLength(0);
  }, 240_000);
});

describe('paid output is kept before QA (standard §39: arch-17)', () => {
  /** A QA inspector that errors (not an outage) the first time it judges the demonstration render. */
  class QaErrorsOnce extends MockLlm {
    thrown = false;
    override async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
      const text = req.content.map((c) => (c.type === 'image' ? '' : c.text)).join(' ');
      if (req.task === 'qa.fidelity' && /hand releases/i.test(text) && !this.thrown) {
        this.thrown = true;
        throw new ProviderError('anthropic', 'malformed inspection', false, 'invalid');
      }
      return super.json(req);
    }
  }
  afterEach(() => setProviders(undefined));

  it('a render whose QA errored is stored, and a retry judges it instead of paying for another', async () => {
    setProviders({ llm: new QaErrorsOnce(), image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    const r = await storyboardReady();
    await approve(r);
    await expect(produceProject(r.ctx, r.projectId)).rejects.toThrow(/malformed inspection/);
    expect((await ownerPool()`select state from projects where id = ${r.projectId}`)[0]!.state).toBe('PROVIDER_FAILED');
    const renders = async () => ownerPool()`select id, output_asset_id from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'video.scene' order by created_at`;
    const before = await renders();
    expect(before).toHaveLength(1);
    // The render was copied into our storage the moment it came back, before the inspection failed.
    expect(before[0]!.output_asset_id).toBeTruthy();
    const [kept] = await ownerPool()`select kind, lineage from assets where id = ${before[0]!.output_asset_id}`;
    expect(kept).toMatchObject({ kind: 'scene_render', lineage: { providerJobId: before[0]!.id } });
    await withTenant(r.t.workspaceId, (tx) => retryProduction(tx, r.ctx, r.projectId));
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    expect(await renders()).toHaveLength(1); // judged, not rendered again
    const [v] = await ownerPool()`select status from scene_versions where workspace_id = ${r.t.workspaceId} and kind = 'render' and asset_id = ${before[0]!.output_asset_id}`;
    expect(v!.status).toBe('accepted');
  }, 240_000);
});

describe('cancelling a running production (standard §38, §46: arch-11)', () => {
  afterEach(async () => {
    setProviders(undefined);
    await ownerPool()`delete from platform_settings where key = 'production.cancel_release_max_spend_bps'`;
    clearSettingsCache();
  });

  it('is recorded while a run works, and the run stops at its next checkpoint and settles it', async () => {
    setProviders({ llm: new MockLlm(), image: new MockImage(), video: new MockVideo(1500), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });
    // Staff policy: up to 100% of the estimate spent, a cancel still returns the credit.
    await ownerPool()`insert into platform_settings (key, value) values ('production.cancel_release_max_spend_bps', '10000') on conflict (key) do update set value = excluded.value`;
    clearSettingsCache();
    const r = await storyboardReady();
    await approve(r);
    const run = produceProject(r.ctx, r.projectId);
    for (let i = 0; i < 400; i++) {
      if ((await ownerPool()`select 1 from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'video.scene'`).length) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    const c = await withTenant(r.t.workspaceId, (tx) => cancelProduction(tx, r.ctx, r.projectId, { reason: 'wrong shade' }));
    expect(c.status).toBe('cancelling');
    expect(c.decision).toMatchObject({ outcome: 'release', dispatched: true });
    expect(await run).toBe('cancelled');
    await withTenant(r.t.workspaceId, async (tx) => {
      const [p] = await tx`select state from projects where id = ${r.projectId}`;
      expect(p!.state).toBe('CANCELLED');
      expect(await available(tx, 'taste')).toBe(1); // released under the policy
      expect((await tx`select count(*)::int as n from assets where kind = 'final_export'`)[0]!.n).toBe(0);
      const steps = await tx`select status, detail from progress_steps where subject_id = ${r.projectId} and status = 'skipped'`;
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every((s) => s.detail === 'Cancelled by you')).toBe(true);
      // Nothing more was spent after the checkpoint: one render, then stop.
      expect((await tx`select count(*)::int as n from provider_jobs where task = 'video.scene'`)[0]!.n).toBe(1);
    });
    // A late duplicate delivery of the production job does nothing.
    expect(await produceProject(r.ctx, r.projectId)).toBe('skipped');
  }, 240_000);
});

describe('whole-creative QA (standard §43 implied claims, §44/§48 continuity: edge-43-04, edge-44-04)', () => {
  it('a finished ad whose pictures imply a medical result is blocked like a blocked line, and nothing is charged', async () => {
    const r = await storyboardReady();
    // The claim is carried by what the scene shows, not by any line (the mock reviewer reads the marker).
    await ownerPool()`update scenes set visual_plan = visual_plan || ' [[qa:implied]]' where storyboard_id = ${r.storyboardId} and purpose = 'routine'`;
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('failed');
    await withTenant(r.t.workspaceId, async (tx) => {
      const [p] = await tx`select state, failure_code, qa_report from projects where id = ${r.projectId}`;
      expect(p).toMatchObject({ state: 'BLOCKED_COMPLIANCE', failure_code: 'claims_blocked' });
      const report = p!.qa_report as { impliedClaims: { impliedClaims: { basis: string; severity: string }[] }; checks: { check: string; pass: boolean; detail: string }[] };
      expect(report.impliedClaims.impliedClaims).toEqual([expect.objectContaining({ basis: 'combined', severity: 'block' })]);
      expect(report.checks.find((c) => c.check === 'claims' && !c.pass)!.detail).toMatch(/^Implied claim: Scene \d+: The pictures imply/);
      expect(await available(tx, 'taste')).toBe(1); // released: the customer is not charged for a blocked ad
      const [job] = await tx`select task, status from provider_jobs where task = 'qa.implied_claims'`;
      expect(job).toMatchObject({ status: 'succeeded' });
    });
    // The blocked implication is listed for the merchant to change, like a blocked line.
    const [p] = await ownerPool()`select qa_report from projects where id = ${r.projectId}`;
    expect(blockedLines(p!.qa_report).map((l) => l.reason)).toContain('Implied claim carried by the pictures or the whole ad');
  }, 240_000);

  it('a clean ad passes the implied-claim scan', async () => {
    const r = await storyboardReady();
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    const [p] = await ownerPool()`select qa_report from projects where id = ${r.projectId}`;
    expect((p!.qa_report as { checks: { check: string; pass: boolean; detail: string }[] }).checks).toContainEqual(expect.objectContaining({ check: 'claims', pass: true, detail: expect.stringMatching(/implied claims \(words and pictures\)/) }));
  }, 240_000);

  it('a generated person who changes between scenes switches that scene to the exact product, without retries', async () => {
    const r = await storyboardReady();
    const [first, second] = await ownerPool()`select id from scenes where storyboard_id = ${r.storyboardId} and purpose not in ('cta', 'product_reveal') order by position limit 2`;
    await ownerPool()`update scenes set production_mode = 'GENERATIVE_INTERACTION', shows_human_skin = true where id in ${ownerPool()([first!.id, second!.id])}`;
    await ownerPool()`update scenes set visual_plan = visual_plan || ' [[qa:continuity]]' where id = ${second!.id}`;
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    const m = await manifestOf(r.projectId);
    expect(m.scenes.find((s) => s.sceneId === first!.id)).toMatchObject({ kind: 'video', technique: 'generative' });
    expect(m.scenes.find((s) => s.sceneId === second!.id)).toMatchObject({ kind: 'still', technique: 'exact_product_composite' });
    const [p] = await ownerPool()`select qa_report from projects where id = ${r.projectId}`;
    const cont = (p!.qa_report as { checks: { check: string; detail: string; data?: { inconsistentSceneIds?: string[] } }[] }).checks.find((c) => /^Continuity/.test(c.detail));
    expect(cont).toMatchObject({ check: 'visual', data: { inconsistentSceneIds: [second!.id] } });
    // No extra render was paid for: one render per generated scene.
    const renders = await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'video.scene'`;
    expect(renders[0]!.n).toBe(2);
    expect((await ownerPool()`select count(*)::int as n from provider_jobs where workspace_id = ${r.t.workspaceId} and task = 'qa.continuity'`)[0]!.n).toBe(1);
  }, 240_000);
});

describe('repeated product-fidelity failure KPI (standard §10: biz-21)', () => {
  it('counts paid projects with a scene that failed product fidelity hard twice', async () => {
    const r = await storyboardReady();
    await ownerPool()`update scenes set visual_plan = visual_plan || ' [[qa:fidelity_always]]' where storyboard_id = ${r.storyboardId} and production_mode = 'GENERATIVE_INTERACTION'`;
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    const events = await ownerPool()`select payload from events where workspace_id = ${r.t.workspaceId} and type = 'QA_FAILED'`;
    expect(events).toHaveLength(2);
    expect(events.every((e) => (e.payload as { hardFail: boolean; projectId: string }).hardFail === true && (e.payload as { projectId: string }).projectId === r.projectId)).toBe(true);
    expect(await withAdmin((tx) => repeatedFidelityFailures(tx, 7))).toEqual({ paid: 1, repeated: 1, rate: 1 });
    await ownerPool()`update workspaces set is_test = true where id = ${r.t.workspaceId}`;
    expect((await withAdmin((tx) => repeatedFidelityFailures(tx, 7))).paid).toBe(0);
  }, 240_000);
});

describe('first-render acceptance (Appendix C; exp-38)', () => {
  it('counts paid ads exported without a customer-requested regeneration', async () => {
    const r = await storyboardReady();
    await approve(r);
    expect(await produceProject(r.ctx, r.projectId)).toBe('complete');
    // Delivered, not exported yet: not accepted.
    expect(await withAdmin((tx) => firstRenderAcceptance(tx, 7))).toEqual({ delivered: 1, accepted: 0, rate: 0 });
    const [a] = await ownerPool()`select id from assets where workspace_id = ${r.t.workspaceId} and kind = 'final_export' and lineage->>'projectId' = ${r.projectId} limit 1`;
    await withTenant(r.t.workspaceId, (tx) => recordAssetExport(tx, r.ctx, a!.id as string, r.projectId));
    expect(await withAdmin((tx) => firstRenderAcceptance(tx, 7))).toEqual({ delivered: 1, accepted: 1, rate: 1 });
    const regen = (by: 'user' | 'staff') =>
      withTenant(r.t.workspaceId, (tx) => emit(tx, r.ctx, 'CREATIVE_REGENERATION_REQUESTED', { type: 'project', id: r.projectId }, { by, from: 'PROVIDER_FAILED', reason: null }, { projectId: r.projectId, skuId: r.skuId }));
    // A staff (or system) retry is not the customer's: still accepted first time.
    await regen('staff');
    expect((await withAdmin((tx) => firstRenderAcceptance(tx, 7))).accepted).toBe(1);
    await regen('user');
    expect(await withAdmin((tx) => firstRenderAcceptance(tx, 7))).toEqual({ delivered: 1, accepted: 0, rate: 0 });
    await ownerPool()`update workspaces set is_test = true where id = ${r.t.workspaceId}`;
    expect((await withAdmin((tx) => firstRenderAcceptance(tx, 7))).delivered).toBe(0);
  }, 240_000);

  it("a customer's retry of a failed paid production is recorded as their regeneration request", async () => {
    const r = await storyboardReady();
    await approve(r);
    await withTenant(r.t.workspaceId, (tx) => failProduction(tx, r.ctx, r.projectId, 'test: render failed QA'));
    await withTenant(r.t.workspaceId, (tx) => retryProduction(tx, r.ctx, r.projectId));
    const events = await ownerPool()`select payload, refs from events where workspace_id = ${r.t.workspaceId} and type = 'CREATIVE_REGENERATION_REQUESTED'`;
    expect(events).toEqual([expect.objectContaining({ payload: { by: 'user', from: 'PROVIDER_FAILED', reason: 'quality_failed' }, refs: expect.objectContaining({ projectId: r.projectId, skuId: r.skuId }) })]);
  }, 120_000);
});
