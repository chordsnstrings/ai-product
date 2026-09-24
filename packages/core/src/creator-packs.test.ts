import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, globalTx, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, startPreview } from './analysis';
import { proposeClaim } from './claims';
import { createCreatorPack, listCreatorPacks, openCreatorPack, revokeCreatorPack, uploadCreatorFootage } from './creator-packs';
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
