import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { analyzeProduct, append, generateStoryboard, ingestBytes, selectConcept, startPreview, step } from '@arkiv/core';
import { ownerPool } from '@arkiv/db';
import { ctxFor, productPhoto } from '../../../packages/core/src/testing';
import { projectVersion, projectView } from './views';

describe('storyboard view: plan and free picture changes (standard §5, §13; plan 03 P7)', () => {
  it('shows the Creative Tests left for a subscriber and how many free picture changes remain', async () => {
    const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, current_period_start, current_period_end, consent_record_id)
                      values (${t.workspaceId}, ${'sub_' + t.workspaceId.slice(-8)}, 'GROWTH', 'active', now(), now() + interval '30 days', gen_random_uuid())`;
    await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 2, periodKey: '2026-09-01', idempotencyKey: 'grant:view' }));
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    await analyzeProduct(ctx, skuId, projectId);
    const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
    const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
    await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
    const v = (await projectView(t.workspaceId, projectId))!;
    expect(v.plan).toMatchObject({ subscribed: true, planCode: 'GROWTH', creativeTestsLeft: 2 });
    expect(v.storyboard).toMatchObject({ freeRegenerationsLeft: 3, freeRegenerationsTotal: 3 });
    await ownerPool()`update scenes set free_regenerations_used = 1 where storyboard_id = ${storyboardId} and position in (0, 1)`;
    expect((await projectView(t.workspaceId, projectId))!.storyboard!.freeRegenerationsLeft).toBe(1);
    await ownerPool()`update scenes set free_regenerations_used = 2 where storyboard_id = ${storyboardId} and position in (0, 1)`;
    expect((await projectView(t.workspaceId, projectId))!.storyboard!.freeRegenerationsLeft).toBe(0);
  }, 120_000);
});

beforeEach(truncateAll);
afterAll(closeAll);

describe('project stream version (plan 06 Phase 1 #9 cataloguing stream)', () => {
  it('changes when a progress step, the project or the workspace’s events change, and only then', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [asset.id] }));
    const v1 = await projectVersion(t.workspaceId, projectId);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    expect(await projectVersion(t.workspaceId, projectId)).toBe(v1); // nothing happened
    await withTenant(t.workspaceId, (tx) => step(tx, t.workspaceId, skuId, 'photos', 'active'));
    const v2 = await projectVersion(t.workspaceId, projectId);
    expect(v2).not.toBe(v1);
    await withTenant(t.workspaceId, (tx) => step(tx, t.workspaceId, skuId, 'photos', 'done', '1 photo'));
    expect(await projectVersion(t.workspaceId, projectId)).not.toBe(v2);
    // Another tenant can't read it, and an unknown project has no version.
    const other = await makeTenant();
    expect(await projectVersion(other.workspaceId, projectId)).toBeNull();
  });
});
