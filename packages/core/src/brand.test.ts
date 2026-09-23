import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, startPreview } from './analysis';
import { brandBrainHistory, updateBrandBrain } from './brand';
import { buildContext } from './creative-director';
import { ingestBytes } from './uploads';
import { ctxFor, productPhoto } from './testing';

/** §15: Brand Brain edits are versioned records with provenance, not an overwritten JSON blob. */
beforeEach(truncateAll);
afterAll(closeAll);

describe('Brand Brain versions', () => {
  it('every brand starts at version 1 and each save adds an immutable version with a diff and a brand event', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const [v1] = await ownerPool()`select v.version, b.current_version_id = v.id as current from brand_brain_versions v join brands b on b.id = v.brand_id where v.workspace_id = ${t.workspaceId}`;
    expect(v1).toMatchObject({ version: 1, current: true });

    const r = await withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { name: 'Test Brand', tone: 'calm, clinical', market: 'gb' }, 'new tone'));
    expect(r).toMatchObject({ version: 2, changed: true });
    await withTenant(t.workspaceId, async (tx) => {
      const [b] = await tx`select brain, current_version_id from brands where id = ${r.brandId}`;
      expect(b!.brain).toMatchObject({ tone: 'calm, clinical', market: 'GB' });
      expect(b!.current_version_id).toBe(r.versionId);
      const history = await brandBrainHistory(tx, r.brandId);
      expect(history.map((h) => h.version)).toEqual([2, 1]);
      expect(history[0]!.diff).toMatchObject({ tone: { from: null, to: 'calm, clinical' }, market: { from: 'US', to: 'GB' } });
      expect(history[0]!.reason).toBe('new tone');
      expect(history[0]!.created_by).toBe(`user:${t.userId}`);
      const [e] = await tx`select type, payload from events where subject_id = ${r.brandId}`;
      expect(e!.type).toBe('BRAND_BRAIN_VERSIONED');
      expect((e!.payload as { version: number }).version).toBe(2);
      expect(await tx`select 1 from events where type = 'PRODUCT_FACT_CHANGED'`).toHaveLength(0);
    });

    // Saving the same values again is not a new version; history can never be edited.
    expect(await withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { name: 'Test Brand', tone: 'calm, clinical', market: 'GB' }))).toMatchObject({ version: 2, changed: false });
    await expect(ownerPool()`update brand_brain_versions set brain = '{}' where brand_id = ${r.brandId}`).rejects.toThrow(/append-only/);
  });

  it('Viewers cannot edit the Brand Brain', async () => {
    const t = await makeTenant();
    await expect(withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctxFor(t.workspaceId, t.userId, 'VIEWER'), { name: 'X' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('generation uses the Brand Brain and records which version it used', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const r = await withTenant(t.workspaceId, (tx) => updateBrandBrain(tx, ctx, { name: 'Test Brand', tone: 'quiet luxury', prohibited: 'no before/after' }));
    const skuId = await makeSku(t.workspaceId);
    const packet = await withTenant(t.workspaceId, (tx) => buildContext(tx, skuId));
    expect(packet.packet.brand).toMatchObject({ tone: 'quiet luxury', neverShowOrSay: 'no before/after', market: 'US' });
    expect(packet.brandBrainVersionId).toBe(r.versionId);

    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const p = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    await analyzeProduct(ctx, p.skuId, p.projectId);
    const concepts = await ownerPool()`select brand_brain_version_id from concepts where project_id = ${p.projectId}`;
    expect(concepts.length).toBeGreaterThan(0);
    expect(new Set(concepts.map((c) => c.brand_brain_version_id))).toEqual(new Set([r.versionId]));
  }, 60_000);
});
