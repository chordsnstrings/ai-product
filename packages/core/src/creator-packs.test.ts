import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, globalTx, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, startPreview } from './analysis';
import { proposeClaim } from './claims';
import { acceptCreatorFootage, createCreatorPack, CREATOR_SAFE_ZONE, listCreatorFootage, listCreatorPacks, openCreatorPack, revokeCreatorPack, uploadCreatorFootage } from './creator-packs';
import { createExperiment } from './experiments';
import { mockConcepts } from './mock-intel';
import { generateStoryboard } from './storyboard';
import { ctxFor, eventContractProblems, productPhoto } from './testing';
import { ingestBytes } from './uploads';

/** Creator Packs (standard §26; gates-36): content, expiry, revocation, claims and tenant isolation. */
beforeEach(truncateAll);
afterAll(closeAll);

async function experimentReady() {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId: preview } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, preview);
  const proposal = mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;
  const { experimentId, projectId, storyboardId } = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal, slot: 'EXPAND' }));
  const [concept] = await ownerPool()`select selected_concept_id from projects where id = ${projectId}`;
  await generateStoryboard(ctx, projectId, storyboardId, concept!.selected_concept_id as string);
  return { t, ctx, skuId, experimentId, storyboardId };
}

describe('Creator Packs', () => {
  it('briefs a creator from the experiment without any blocked or unapproved claim, and lists what must not be said', async () => {
    const r = await experimentReady();
    // A blocked claim in the vault, and a storyboard line that makes it.
    await withTenant(r.t.workspaceId, (tx) => proposeClaim(tx, r.ctx, r.skuId, { wording: 'Cures acne overnight', origin: 'merchant' }));
    await ownerPool()`update scenes set spoken_line = 'Cures acne overnight.' where storyboard_id = ${r.storyboardId} and purpose = 'routine'`;
    const pack = await withTenant(r.t.workspaceId, (tx) => createCreatorPack(tx, r.ctx, r.experimentId));
    expect(pack.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const opened = await globalTx((tx) => openCreatorPack(tx, pack.token));
    const c = opened!.content;
    expect(c.hooks.length).toBeGreaterThan(0);
    expect(c.hooks.length).toBeLessThanOrEqual(3);
    expect(c.firstShot.length).toBeGreaterThan(5);
    expect(c.productVisibleBySec).toBeLessThanOrEqual(3);
    expect(c.requiredShots.length).toBeGreaterThan(2);
    expect(c.framing.join(' ')).toMatch(/9:16/);
    // The safe-zone note matches what platform QA checks (and what the page's diagram draws).
    expect(c.framing.join(' ')).toContain(`bottom ${Math.round(CREATOR_SAFE_ZONE.bottom * 100)}%`);
    // Nothing the brief tells the creator to say carries the blocked claim; it is listed as forbidden instead.
    const said = [...c.hooks, ...c.requiredShots.flatMap((s) => [s.say, s.onScreen]), c.voiceover, c.cta].filter(Boolean).join(' ');
    expect(said).not.toMatch(/cures acne/i);
    expect(c.forbiddenClaims).toContain('Cures acne overnight');
    // Only the hash is stored; the pack is an experiment's usage event (§49).
    expect((await ownerPool()`select share_token_hash from creator_packs`)[0]!.share_token_hash).not.toBe(pack.token);
    expect((await ownerPool()`select payload, refs from events where type = 'CREATOR_PACK_CREATED'`)[0]).toMatchObject({ refs: { experimentId: r.experimentId, skuId: r.skuId } });
    expect(await eventContractProblems(r.t.workspaceId)).toEqual([]);
  }, 120_000);

  it('counts views, takes footage back with a rights attestation, and stops working when revoked or expired', async () => {
    const r = await experimentReady();
    const pack = await withTenant(r.t.workspaceId, (tx) => createCreatorPack(tx, r.ctx, r.experimentId));
    await globalTx((tx) => openCreatorPack(tx, pack.token));
    await globalTx((tx) => openCreatorPack(tx, pack.token));
    await expect(uploadCreatorFootage(pack.token, { bytes: await productPhoto('CREATOR TAKE'), filename: 'take1.jpg' }, { name: 'Sam Creator', rightsAttested: false })).rejects.toMatchObject({ code: 'INVALID' });
    const up = await uploadCreatorFootage(pack.token, { bytes: await productPhoto('CREATOR TAKE'), filename: 'take1.jpg' }, { name: 'Sam Creator', rightsAttested: true });
    const [a] = await ownerPool()`select workspace_id, sku_id, kind, origin, rights_attested_at from assets where id = ${up.assetId}`;
    expect(a).toMatchObject({ workspace_id: r.t.workspaceId, sku_id: r.skuId, kind: 'creator_footage' });
    expect(a!.rights_attested_at).not.toBeNull();
    expect(a!.origin).toMatchObject({ creatorPackId: pack.id, experimentId: r.experimentId, rights: { attested: true, by: 'Sam Creator' } });
    const [listed] = await withTenant(r.t.workspaceId, (tx) => listCreatorPacks(tx, r.experimentId));
    expect(listed).toMatchObject({ views: 2, uploads: 1 });

    await withTenant(r.t.workspaceId, (tx) => revokeCreatorPack(tx, r.ctx, pack.id));
    expect(await globalTx((tx) => openCreatorPack(tx, pack.token))).toBeNull();
    await expect(uploadCreatorFootage(pack.token, { bytes: await productPhoto(), filename: 'x.jpg' }, { name: 'Sam', rightsAttested: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const second = await withTenant(r.t.workspaceId, (tx) => createCreatorPack(tx, r.ctx, r.experimentId));
    expect(await globalTx((tx) => openCreatorPack(tx, second.token))).not.toBeNull();
    await ownerPool()`update creator_packs set expires_at = now() - interval '1 minute' where id = ${second.id}`;
    expect(await globalTx((tx) => openCreatorPack(tx, second.token))).toBeNull();
    expect(await globalTx((tx) => openCreatorPack(tx, 'not-a-real-token-at-all-000'))).toBeNull();
  }, 120_000);

  it('an owner takes creator footage into the experiment: attested, a creator variant, and a genome job (§26)', async () => {
    const r = await experimentReady();
    const pack = await withTenant(r.t.workspaceId, (tx) => createCreatorPack(tx, r.ctx, r.experimentId));
    const up = await uploadCreatorFootage(pack.token, { bytes: await productPhoto('CREATOR TAKE'), filename: 'take1.jpg' }, { name: 'Sam Creator', rightsAttested: true });
    const [listed] = await withTenant(r.t.workspaceId, (tx) => listCreatorFootage(tx, r.experimentId));
    expect(listed).toMatchObject({ id: up.assetId, creator: 'Sam Creator', creativeId: null, inReview: false });
    // A member can brief a creator but not take footage into a test (a rights decision).
    const member = ctxFor(r.t.workspaceId, r.t.userId, 'MEMBER', 'ACTIVE_PAID');
    await expect(withTenant(r.t.workspaceId, (tx) => acceptCreatorFootage(tx, member, up.assetId))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Another workspace can't reach it.
    const other = await makeTenant();
    await expect(withTenant(other.workspaceId, (tx) => acceptCreatorFootage(tx, ctxFor(other.workspaceId, other.userId), up.assetId))).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const a = await withTenant(r.t.workspaceId, (tx) => acceptCreatorFootage(tx, r.ctx, up.assetId));
    expect(a.replayed).toBe(false);
    const [asset] = await ownerPool()`select rights_attested_by from assets where id = ${up.assetId}`;
    expect(asset!.rights_attested_by).toBe(r.t.userId);
    const [cr] = await ownerPool()`select origin, sku_id, final_asset_ids from creatives where id = ${a.creativeId}`;
    expect(cr).toMatchObject({ origin: 'creator', sku_id: r.skuId, final_asset_ids: [up.assetId] });
    const [v] = await ownerPool()`select experiment_id, creative_id, role, code, genes from variants where id = ${a.variantId}`;
    expect(v).toMatchObject({ experiment_id: r.experimentId, creative_id: a.creativeId, role: 'variant' });
    expect(v!.genes).toMatchObject({ treatment: 'CREATOR' });
    const codes = await ownerPool()`select code from variants where experiment_id = ${r.experimentId}`;
    expect(new Set(codes.map((c) => c.code)).size).toBe(codes.length);
    const [job] = await ownerPool()`select payload from outbox where queue = 'extract-genome' and payload->>'creativeId' = ${a.creativeId}`;
    expect(job).toBeTruthy();
    expect((await ownerPool()`select refs from events where type = 'CREATOR_FOOTAGE_ACCEPTED'`)[0]).toMatchObject({ refs: { experimentId: r.experimentId, skuId: r.skuId } });
    // Accepting again is a no-op.
    expect(await withTenant(r.t.workspaceId, (tx) => acceptCreatorFootage(tx, r.ctx, up.assetId))).toMatchObject({ creativeId: a.creativeId, variantId: a.variantId, replayed: true });
    expect((await withTenant(r.t.workspaceId, (tx) => listCreatorFootage(tx, r.experimentId)))[0]!.creativeId).toBe(a.creativeId);
    expect(await eventContractProblems(r.t.workspaceId)).toEqual([]);
  }, 120_000);

  it('a pack is reachable only by its own token, and never through another tenant', async () => {
    const a = await experimentReady();
    const b = await makeTenant();
    const pack = await withTenant(a.t.workspaceId, (tx) => createCreatorPack(tx, a.ctx, a.experimentId));
    // Another workspace sees no packs through the app role, and can't revoke this one.
    expect(await withTenant(b.workspaceId, (tx) => tx`select id from creator_packs`)).toEqual([]);
    await expect(withTenant(b.workspaceId, (tx) => revokeCreatorPack(tx, ctxFor(b.workspaceId, b.userId), pack.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The token opens exactly its own pack.
    expect((await globalTx((tx) => openCreatorPack(tx, pack.token)))!.workspaceId).toBe(a.t.workspaceId);
    // The app role can't read creator_packs outside a tenant (fails closed), only through the token lookup.
    await expect(globalTx((tx) => tx`select id from creator_packs`)).rejects.toThrow(/tenant context/);
  }, 120_000);
});
