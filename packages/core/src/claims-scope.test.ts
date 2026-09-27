import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { normalizeClaimPlatforms, normalizeMarkets } from '@arkiv/shared';
import { analyzeProduct, startPreview } from './analysis';
import { AD_PLATFORMS, approveClaim, proposeClaim, renderableClaims } from './claims';
import { allowedClaimTexts, buildContext } from './creative-director';
import { append } from './ledger';
import { approveForProduction, blockedLines, produceProject } from './production';
import { generateStoryboard, selectConcept } from './storyboard';
import { ingestBytes } from './uploads';
import { ctxFor, productPhoto } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

describe('claim scope values (§17)', () => {
  it('normalises merchant shorthands to canonical platform codes and refuses unknown ones', () => {
    expect(normalizeClaimPlatforms(['meta', 'tiktok'])).toEqual(['TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_FEED']);
    expect(normalizeClaimPlatforms(['TIKTOK', 'youtube', 'Organic'])).toEqual(['TIKTOK', 'YOUTUBE', 'ORGANIC']);
    expect(() => normalizeClaimPlatforms(['myspace'])).toThrow(/Unknown platform/);
    expect(normalizeMarkets(['us', ' gb '])).toEqual(['US', 'GB']);
    expect(() => normalizeMarkets(['united states'])).toThrow(/Unknown market/);
  });
});

describe('approved claims become renderable (regression: lowercase scope never matched)', () => {
  it('stores the web approval payload canonically and matches every export platform', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await withTenant(t.workspaceId, async (tx) => {
      const c = await proposeClaim(tx, ctx, skuId, { wording: 'Non-comedogenic', origin: 'merchant' });
      // Exactly what the claims page posts: lowercase legacy shorthands work too.
      const approved = await approveClaim(tx, ctx, c.id, { markets: ['us'], platforms: ['meta', 'tiktok'] });
      expect(approved.allowedPlatforms).toEqual(['TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_FEED']);
      expect(approved.allowedMarkets).toEqual(['US']);
      for (const p of AD_PLATFORMS) expect((await renderableClaims(tx, skuId, { platforms: [p] })).map((x) => x.id), p).toEqual([c.id]);
      expect((await allowedClaimTexts(tx, skuId)).map((x) => x.wording)).toEqual(['Non-comedogenic']);
      // Packet items carry their id, so proposals can cite the claim as rationale (§38).
      expect((await buildContext(tx, skuId)).packet.claims.APPROVED).toEqual([{ id: c.id, wording: 'Non-comedogenic' }]);
    });
  });

  it('a TikTok-only approval is not usable for Feed exports and is not offered to the planner as approved', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await withTenant(t.workspaceId, async (tx) => {
      const c = await proposeClaim(tx, ctx, skuId, { wording: 'Non-comedogenic', origin: 'merchant' });
      await approveClaim(tx, ctx, c.id, { markets: ['US'], platforms: ['TIKTOK'] });
      expect(await renderableClaims(tx, skuId, { platforms: ['TIKTOK'] })).toHaveLength(1);
      expect(await renderableClaims(tx, skuId, { platforms: ['FACEBOOK_FEED'] })).toHaveLength(0);
      const packet = (await buildContext(tx, skuId)).packet;
      expect(packet.claims.APPROVED).toEqual([]);
      expect(packet.claims.NEEDS_REVIEW_DO_NOT_USE).toContain('Non-comedogenic');
    });
  });

  it('US approval does not imply another market (§43): the brand market decides', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await ownerPool()`update brands set brain = jsonb_set(brain, '{market}', '"GB"') where workspace_id = ${t.workspaceId}`;
    await withTenant(t.workspaceId, async (tx) => {
      const c = await proposeClaim(tx, ctx, skuId, { wording: 'Non-comedogenic', origin: 'merchant' });
      await approveClaim(tx, ctx, c.id, { markets: ['US'], platforms: ['TIKTOK', 'META'] });
      expect(await allowedClaimTexts(tx, skuId)).toEqual([]);
      await approveClaim(tx, ctx, c.id, { markets: ['US', 'GB'], platforms: ['TIKTOK', 'META'] });
      expect(await allowedClaimTexts(tx, skuId)).toHaveLength(1);
    });
  });

  it('tolerates legacy lowercase rows written before normalisation', async () => {
    const t = await makeTenant();
    const skuId = await makeSku(t.workspaceId);
    await ownerPool()`insert into claims (workspace_id, sku_id, canonical_meaning, preferred_wording, claim_category, risk_level, status, origin, allowed_platforms, allowed_markets)
                      values (${t.workspaceId}, ${skuId}, 'x', 'Fragrance-free', 'formulation', 'low', 'VERIFIED', 'merchant', '{tiktok,instagram_reels,facebook_feed}', '{us}')`;
    expect(await withTenant(t.workspaceId, (tx) => allowedClaimTexts(tx, skuId))).toHaveLength(1);
  });
});

describe('production claims QA uses the real export platforms', () => {
  async function storyboardWithLine(line: string) {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    await analyzeProduct(ctx, skuId, projectId);
    const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
    const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
    await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
    await ownerPool()`update scenes set spoken_line = ${line} where storyboard_id = ${storyboardId} and position = 1`;
    await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: `pay:${projectId}` }));
    return { t, ctx, skuId, projectId };
  }

  it('a claim approved through the web payload renders; the same claim scoped to TikTok only is blocked for Feed', async () => {
    const ok = await storyboardWithLine('Non-comedogenic.');
    await withTenant(ok.t.workspaceId, async (tx) => {
      const c = await proposeClaim(tx, ok.ctx, ok.skuId, { wording: 'Non-comedogenic', origin: 'merchant' });
      await approveClaim(tx, ok.ctx, c.id, { markets: ['US'], platforms: ['tiktok', 'meta', 'youtube', 'organic'] });
      await approveForProduction(tx, ok.ctx, ok.projectId, 'taste');
    });
    expect(await produceProject(ok.ctx, ok.projectId)).toBe('complete');

    const narrow = await storyboardWithLine('Non-comedogenic.');
    await withTenant(narrow.t.workspaceId, async (tx) => {
      const c = await proposeClaim(tx, narrow.ctx, narrow.skuId, { wording: 'Non-comedogenic', origin: 'merchant' });
      await approveClaim(tx, narrow.ctx, c.id, { markets: ['US'], platforms: ['TIKTOK'] });
      await approveForProduction(tx, narrow.ctx, narrow.projectId, 'taste');
    });
    await produceProject(narrow.ctx, narrow.projectId);
    const [p] = await ownerPool()`select state, failure_code, qa_report from projects where id = ${narrow.projectId}`;
    expect(p!.state).toBe('BLOCKED_COMPLIANCE');
    expect(p!.failure_code).toBe('claims_blocked');
    // The blocked line is shown to the merchant with the platform it can't run on — Feed, not TikTok.
    const blocked = blockedLines(p!.qa_report);
    expect(blocked.some((b) => /Non-comedogenic/.test(b.line))).toBe(true);
    const platforms = blocked.flatMap((b) => b.platforms);
    expect(platforms).toContain('Facebook/Instagram feed');
    expect(platforms).not.toContain('TikTok');
  }, 240_000);
});
