import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, startPreview } from './analysis';
import { ingestBytes } from './uploads';
import { append } from './ledger';
import { bonusHookDue, validateOfferBonus } from './offers';
import { approveForProduction, produceProject } from './production';
import { generateStoryboard, selectConcept } from './storyboard';
import { ctxFor, productPhoto } from './testing';
import { produceHookVariants } from './variants';

/** Standard §7 "every offer has … bonus entitlements"; §8 "any low-COGS bonus such as an alternate opening hook". */
async function restore() {
  await ownerPool()`update offer_definitions set bonus = '{}' where code = 'TASTE_19'`;
  await ownerPool()`update feature_flags set enabled = false, rules = '{}' where key = 'offer.taste_bonus_hook'`;
}
beforeEach(async () => {
  await truncateAll();
  await restore();
  await ownerPool()`update offer_definitions set bonus = '{"alternateHook": 1}' where code = 'TASTE_19'`;
});
afterEach(restore);
afterAll(closeAll);

async function storyboardReady() {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const concepts = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx`;
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, concepts[0]!.id as string));
  await generateStoryboard(ctx, projectId, storyboardId, concepts[0]!.id as string);
  return { t, ctx, projectId };
}

describe('offer bonus: an alternate opening hook', () => {
  it('is offered only where its rollout flag is on (what is shown is what is delivered)', async () => {
    const off = await storyboardReady();
    const [o1] = await ownerPool()`select bonus from offers where workspace_id = ${off.t.workspaceId}`;
    expect(o1!.bonus).toEqual({});
    await ownerPool()`update feature_flags set enabled = true, rules = '{"pct": 100}' where key = 'offer.taste_bonus_hook'`;
    const on = await storyboardReady();
    const [o2] = await ownerPool()`select bonus from offers where workspace_id = ${on.t.workspaceId}`;
    expect(o2!.bonus).toEqual({ alternateHook: 1 });
  }, 90_000);

  it('is made after the paid ad, from the concept’s next hook, and delivered as a version of it — once', async () => {
    await ownerPool()`update feature_flags set enabled = true, rules = '{"pct": 100}' where key = 'offer.taste_bonus_hook'`;
    const { t, ctx, projectId } = await storyboardReady();
    const [offer] = await ownerPool()`select id from offers where workspace_id = ${t.workspaceId}`;
    await ownerPool()`insert into purchases (workspace_id, kind, offer_id, project_id, amount_micros, stripe_checkout_session_id, status, paid_at, created_by)
                      values (${t.workspaceId}, 'taste', ${offer!.id}, ${projectId}, 19000000, 'cs_bonus', 'paid', now(), 'user:x')`;
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: 'pay:bonus', reference: 'cs_bonus' });
      await approveForProduction(tx, ctx, projectId, 'taste');
    });
    expect(await produceProject(ctx, projectId)).toBe('complete');
    const [job] = await ownerPool()`select payload from outbox where workspace_id = ${t.workspaceId} and queue = 'hook-variants'`;
    expect(job!.payload).toMatchObject({ projectId, bonus: true });
    expect(await withTenant(t.workspaceId, (tx) => bonusHookDue(tx, projectId))).toBe(true);

    expect(await produceHookVariants(ctx, projectId)).toBe(1);
    const [p] = await ownerPool()`select final_creative_id, bonus_hook_creative_id, bonus_hook_failed_at from projects where id = ${projectId}`;
    expect(p!.bonus_hook_creative_id).toBeTruthy();
    expect(p!.bonus_hook_failed_at).toBeNull();
    const [cr] = await ownerPool()`select parent_creative_id, final_asset_ids, genome from creatives where id = ${p!.bonus_hook_creative_id}`;
    expect(cr!.parent_creative_id).toBe(p!.final_creative_id);
    expect((cr!.final_asset_ids as string[]).length).toBe(3); // every export the master has
    const [sb] = await ownerPool()`select hook_text from storyboards where project_id = ${projectId} and status = 'approved'`;
    expect((cr!.genome as { hookText: string }).hookText).not.toBe(sb?.hook_text);
    const [ev] = await ownerPool()`select payload from events where workspace_id = ${t.workspaceId} and type = 'CREATIVE_VERSIONED' and subject_id = ${p!.bonus_hook_creative_id}`;
    expect(ev!.payload).toMatchObject({ parentCreativeId: p!.final_creative_id, projectId });
    // Delivered: nothing more is owed, and a second run changes nothing.
    expect(await withTenant(t.workspaceId, (tx) => bonusHookDue(tx, projectId))).toBe(false);
    expect(await produceHookVariants(ctx, projectId)).toBe(0);
  }, 240_000);

  it('staff can only save bonuses the engine delivers', () => {
    expect(() => validateOfferBonus({ alternateHook: 1 }, 'TASTE')).not.toThrow();
    expect(() => validateOfferBonus({ extraCredits: 3 }, 'TASTE')).toThrow(/Unknown bonus/);
    expect(() => validateOfferBonus({ alternateHook: 2 }, 'TASTE')).toThrow(/0 or 1/);
    expect(() => validateOfferBonus({ alternateHook: 1 }, 'STANDALONE')).toThrow(/Taste offer/);
  });
});
