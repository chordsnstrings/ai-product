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
