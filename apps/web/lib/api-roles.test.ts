import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, type Role } from '@arkiv/shared';

/**
 * HTTP-level role matrix (plan 06 Phase 4 "role matrix tests for every action"; plan 02 §1.1 "UI hiding is cosmetic;
 * the server always re-checks"). Every mutating API action is called as a Viewer and as a Member, with an Admin or
 * Owner as the control, through the real route handler, session → membership resolution and tenant transaction.
 * Only the cookie read is replaced: `currentUser()` returns the user under test.
 */
let who: { userId: string; workspaceId: string } | null = null;
vi.mock('@/lib/session', () => ({
  currentUser: async () =>
    who && { userId: who.userId, email: `${who.userId.slice(-6)}@example.com`, name: null, sessionId: 'test-session', lastWorkspaceId: who.workspaceId },
  provisionalToken: async () => null,
}));

const { POST: workspacePost } = await import('../app/api/w/[slug]/[action]/route');
const { POST: projectPost } = await import('../app/api/projects/[id]/[action]/route');
const { POST: scenePost } = await import('../app/api/scenes/[id]/[action]/route');

const u = () => newId();
let t: Awaited<ReturnType<typeof makeTenant>>;
let skuId: string;
let projectId: string;
const users = {} as Record<Role, string>;

beforeAll(async () => {
  await truncateAll();
  t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
  users.OWNER = t.userId;
  for (const role of ['ADMIN', 'MEMBER', 'VIEWER'] as const) {
    const [row] = await ownerPool()`insert into users (email) values (${`${role.toLowerCase()}-${u().slice(-8)}@example.com`}) returning id`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${row!.id}, ${role})`;
    users[role] = row!.id as string;
  }
  skuId = await makeSku(t.workspaceId);
  projectId = u();
  await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit)
                    values (${projectId}, ${t.workspaceId}, ${skuId}, 'taste', 'PROVIDER_FAILED', 'test', 'taste')`;
});
afterAll(closeAll);

async function call(role: Role, url: string, handler: typeof workspacePost, params: Record<string, string>, payload?: unknown): Promise<number> {
  who = { userId: users[role], workspaceId: t.workspaceId };
  const init: RequestInit = { method: 'POST', headers: { 'idempotency-key': `k-${u()}` } };
  if (payload instanceof FormData) init.body = payload;
  else {
    init.body = JSON.stringify(payload ?? {});
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await handler(new Request(`http://localhost${url}`, init), { params: Promise.resolve(params) } as never);
  return res.status;
}

type Row = [action: string, minRole: 'MEMBER' | 'ADMIN' | 'OWNER', payload: () => unknown];
const form = (entries: Record<string, string>) => () => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

// Plan 02 §1.1: create/approve → Member+; claims, integrations, members → Admin+; billing, delete, transfer, export → Owner.
const WORKSPACE_ACTIONS: Row[] = [
  ['rec-accept', 'MEMBER', () => ({ id: u() })],
  ['rec-dismiss', 'MEMBER', () => ({ id: u(), reason: 'not now' })],
  ['rec-refresh', 'MEMBER', () => ({})],
  ['experiment-approve', 'MEMBER', () => ({ experimentId: u(), quoteId: u() })],
  ['creator-pack', 'MEMBER', () => ({ experimentId: u() })],
  ['creator-footage-accept', 'ADMIN', () => ({ assetId: u() })],
  ['creator-pack-revoke', 'MEMBER', () => ({ id: u() })],
  ['experiment-archive', 'MEMBER', () => ({ experimentId: u() })],
  ['experiment-live', 'MEMBER', () => ({ experimentId: u() })],
  ['link-ad', 'MEMBER', () => ({ platform: 'meta', adId: 'ad_123', variantId: u() })],
  ['confounder', 'MEMBER', () => ({ kind: 'stockout', startsAt: '2026-09-01' })],
  ['confounder-decide', 'MEMBER', () => ({ id: u(), decision: 'dismiss' })],
  ['fact', 'MEMBER', () => ({ skuId, key: 'size', value: '50 ml' })],
  ['stock-intent', 'MEMBER', () => ({ skuId, intent: null })],
  ['fact-confirm', 'MEMBER', () => ({ skuId, factIds: [u()] })],
  ['asset-delete', 'MEMBER', () => ({ assetId: u() })],
  ['fact-accept-source', 'MEMBER', () => ({ skuId, factId: u() })],
  ['claim-propose', 'MEMBER', () => ({ skuId, wording: 'Hydrates for 24 hours' })],
  ['claim-approve', 'ADMIN', () => ({ claimId: u(), markets: ['US'], platforms: ['META'] })],
  ['reviews', 'MEMBER', () => ({ skuId, text: 'Love it, my skin feels great.\n\nWould buy again, lovely texture.' })],
  ['invite', 'ADMIN', () => ({ email: 'new@example.com', role: 'MEMBER' })],
  ['invite-revoke', 'ADMIN', () => ({ id: u() })],
  ['member-role', 'ADMIN', () => ({ userId: users.ADMIN, role: 'VIEWER' })],
  ['member-remove', 'ADMIN', () => ({ userId: users.ADMIN })],
  ['transfer', 'OWNER', () => ({ userId: u() })],
  ['subscribe', 'OWNER', () => ({ plan: 'SCALE', agreed: true })],
  ['cancel', 'OWNER', () => ({})],
  ['uncancel', 'OWNER', () => ({})],
  ['change-plan', 'OWNER', () => ({ plan: 'SCALE' })],
  ['portal', 'OWNER', () => ({})],
  ['integration-disconnect', 'ADMIN', () => ({ id: u() })],
  ['integration-sync', 'ADMIN', () => ({ id: u() })],
  ['integration-select', 'ADMIN', () => ({ pendingId: u(), accountIds: ['act_1'] })],
  ['shop-transfer-request', 'ADMIN', () => ({ proof: 'not-a-real-proof-token' })],
  ['shop-transfer-decide', 'ADMIN', () => ({ id: u(), decision: 'reject' })],
  ['integration-demo', 'ADMIN', () => ({ provider: 'meta' })],
  ['brand', 'MEMBER', () => ({ name: 'New name' })],
  ['brand-create', 'ADMIN', () => ({ name: 'Second brand' })],
  ['brand-logo', 'MEMBER', () => form({ brandId: t.brandId })()],
  ['brand-reference', 'MEMBER', () => form({ brandId: t.brandId })()],
  ['brand-reference-remove', 'MEMBER', () => ({ brandId: t.brandId, assetId: u() })],
  ['sku-brand', 'MEMBER', () => ({ skuId, brandId: t.brandId })],
  ['approve-views', 'MEMBER', () => ({ skuId, assetIds: [] })],
  ['packaging-refresh', 'MEMBER', () => form({ skuId })()],
  ['rename', 'OWNER', () => ({ name: 'Renamed' })],
  ['export', 'OWNER', () => ({})],
  ['delete', 'OWNER', () => ({ confirm: 'wrong-slug' })],
  ['performance-csv', 'ADMIN', form({ platform: 'meta' })],
  ['evidence', 'MEMBER', form({ claimId: '00000000-0000-4000-8000-000000000000', type: 'lab_test', applicability: 'product_specific', location: 'https://example.com/lab.pdf' })],
  ['import-creative', 'MEMBER', () => form({ skuId, copy: 'An old ad that worked' })()],
];

const RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
const allowed = (role: Role, min: Row[1]) => RANK[role] >= RANK[min];

describe('workspace API actions enforce the role matrix (plan 02 §1.1)', () => {
  for (const [action, min, payload] of WORKSPACE_ACTIONS) {
    it(action, async () => {
      for (const role of ['VIEWER', 'MEMBER', 'ADMIN'] as const) {
        if (allowed(role, min)) continue;
        const status = await call(role, `/api/w/${t.slug}/${action}`, workspacePost, { slug: t.slug, action }, payload());
        expect(status, `${action} as ${role}`).toBe(403);
      }
    });
  }

  it('the harness really authenticates: an allowed role is not refused', async () => {
    expect(await call('MEMBER', `/api/w/${t.slug}/fact`, workspacePost, { slug: t.slug, action: 'fact' }, { skuId, key: 'size', value: '50 ml' })).toBe(200);
    expect(await call('ADMIN', `/api/w/${t.slug}/invite-revoke`, workspacePost, { slug: t.slug, action: 'invite-revoke' }, { id: u() })).toBe(200);
    expect(await call('OWNER', `/api/w/${t.slug}/rename`, workspacePost, { slug: t.slug, action: 'rename' }, { name: 'Renamed' })).toBe(200);
  });
});

// Every project action except "watched" (playing the finished ad) changes the project: Member and up.
const PROJECT_ACTIONS: [string, () => unknown][] = [
  ['concepts', () => ({})],
  ['select', () => ({ conceptId: u() })],
  ['checkout', () => ({})],
  ['produce-with-test', () => ({})],
  ['fact', () => ({ key: 'size', value: '50 ml' })],
  ['confirm', () => ({ factIds: [] })],
  ['fact-accept-source', () => ({ factId: u() })],
  ['retry', () => ({})],
  ['reopen', () => ({})],
  ['cancel', () => ({})],
  ['recompose', () => ({})],
  ['finish', () => ({})],
  ['variant', () => ({ variantId: null })],
  ['not-right', () => ({ reason: 'style' })],
  ['produce-free', () => ({})],
  ['photos', () => new FormData()],
  ['select-product', () => ({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 })],
  ['choose-product', () => ({ url: 'https://shop.example/products/a' })],
  ['duplicate', () => ({ choice: 'keep' })],
  ['storyboard-retry', () => ({})],
  ['retry-analysis', () => ({})],
];

describe('project and scene API actions refuse Viewers', () => {
  for (const [action, payload] of PROJECT_ACTIONS) {
    it(`project ${action}`, async () => {
      expect(await call('VIEWER', `/api/projects/${projectId}/${action}`, projectPost as never, { id: projectId, action }, payload())).toBe(403);
    });
  }
  it('a Viewer can still record that they watched the ad (not a 403)', async () => {
    expect(await call('VIEWER', `/api/projects/${projectId}/watched`, projectPost as never, { id: projectId, action: 'watched' }, { assetId: u(), seconds: 3 })).not.toBe(403);
  });
  for (const action of ['edit', 'lock', 'regenerate']) {
    it(`scene ${action}`, async () => {
      const sceneId = u();
      expect(await call('VIEWER', `/api/scenes/${sceneId}/${action}`, scenePost as never, { id: sceneId, action }, { projectId, locked: true, instruction: 'warmer', overlayText: 'x' })).toBe(403);
    });
  }
});
