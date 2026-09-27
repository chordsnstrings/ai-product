import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, type Role } from '@arkiv/shared';

/**
 * HTTP-level role matrix (plan 06 Phase 4 "role matrix tests for every action"; plan 02 §1.1 "UI hiding is cosmetic;
 * the server always re-checks"). Every mutating API action is called as a Viewer and as a Member, with an Admin or
 * Owner as the control, through the real route handler, session → membership resolution and tenant transaction.
 * Only the cookie read is replaced: `currentUser()` returns the user under test.
 */
let who: { userId: string; workspaceId: string; signedInAt?: Date } | null = null;
vi.mock('@/lib/session', () => ({
  currentUser: async () =>
    who && { userId: who.userId, email: `${who.userId.slice(-6)}@example.com`, name: null, sessionId: 'test-session', lastWorkspaceId: who.workspaceId, createdAt: (who.signedInAt ?? new Date()).toISOString() },
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
  ['asset-attest', 'MEMBER', () => ({ assetId: u() })],
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

describe('forms with a resumably uploaded file (plan 06 Phase 1 D3)', () => {
  it('uses the quarantined upload in place of a posted file, once, and only in its own workspace', async () => {
    const { startMediaUpload, completeMediaUpload, storage } = await import('@arkiv/core');
    const { productPhoto, ctxFor } = await import('@arkiv/core/testing');
    const photo = await productPhoto();
    const ctx = ctxFor(t.workspaceId, users.OWNER);
    const up = await withTenant(t.workspaceId, (tx) => startMediaUpload(tx, ctx, { mime: 'image/jpeg', bytes: photo.length, filename: 'mood.jpg' }));
    await storage().put(new URL(up.parts[0]!.url).searchParams.get('key')!, photo, 'image/jpeg');
    await withTenant(t.workspaceId, (tx) => completeMediaUpload(tx, ctx, up.uploadId));
    const send = () => call('MEMBER', `/api/w/${t.slug}/brand-reference`, workspacePost, { slug: t.slug, action: 'brand-reference' }, form({ brandId: t.brandId, fileUploadId: up.uploadId })());
    expect(await send()).toBe(200);
    const [a] = await ownerPool()`select kind, origin from assets where workspace_id = ${t.workspaceId} and kind = 'brand_reference'`;
    expect(a!.origin).toMatchObject({ filename: 'mood.jpg' });
    expect((await ownerPool()`select status from uploads where id = ${up.uploadId}`)[0]!.status).toBe('accepted');
    expect(await send()).toBe(409); // used already
    // Another workspace's member can't name it.
    const other = await makeTenant();
    who = { userId: other.userId, workspaceId: other.workspaceId };
    const f = form({ brandId: other.brandId, fileUploadId: up.uploadId })();
    const res = await workspacePost(new Request(`http://localhost/api/w/${other.slug}/brand-reference`, { method: 'POST', body: f }), { params: Promise.resolve({ slug: other.slug, action: 'brand-reference' }) } as never);
    expect(res.status).toBe(404);
  });
});

describe('importing a past ad (standard §19)', () => {
  it('stores its media as a historical creative, not as creator footage for new productions', async () => {
    const { productPhoto } = await import('@arkiv/core/testing');
    const f = form({ skuId, copy: 'The serum that sold out twice', rights: 'attested', creatorHandle: '@glowwithsam', sourceUrl: 'https://www.tiktok.com/@glowwithsam/video/1' })();
    f.set('file', new File([new Uint8Array(await productPhoto())], 'old-ad.jpg', { type: 'image/jpeg' }));
    expect(await call('MEMBER', `/api/w/${t.slug}/import-creative`, workspacePost, { slug: t.slug, action: 'import-creative' }, f)).toBe(200);
    const [cr] = await ownerPool()`select final_asset_ids from creatives where workspace_id = ${t.workspaceId} and platform_refs->>'copy' = 'The serum that sold out twice'`;
    const [a] = await ownerPool()`select kind, origin, rights_attested_by, rights_attested_at from assets where id = ${(cr!.final_asset_ids as string[])[0]!}`;
    expect(a!.kind).toBe('historical_creative');
    // §40: the merchant's rights attestation, and the footage's origin, are kept.
    expect(a).toMatchObject({ rights_attested_by: users.MEMBER, origin: { filename: 'old-ad.jpg', creatorHandle: '@glowwithsam', sourceUrl: 'https://www.tiktok.com/@glowwithsam/video/1' } });
    expect(a!.rights_attested_at).not.toBeNull();
    const [c] = await ownerPool()`select user_id, text_snapshot, context from consent_records where workspace_id = ${t.workspaceId} and kind = 'rights_attestation'`;
    expect(c).toMatchObject({ user_id: users.MEMBER, context: { assetId: (cr!.final_asset_ids as string[])[0]! } });
    expect(c!.text_snapshot).toMatch(/permission/);
  });

  it('refuses footage without a rights attestation (§40); copy alone needs none', async () => {
    const { productPhoto } = await import('@arkiv/core/testing');
    const f = form({ skuId, copy: 'An ad with borrowed footage' })();
    f.set('file', new File([new Uint8Array(await productPhoto())], 'ugc.jpg', { type: 'image/jpeg' }));
    expect(await call('MEMBER', `/api/w/${t.slug}/import-creative`, workspacePost, { slug: t.slug, action: 'import-creative' }, f)).toBe(422);
    expect(await ownerPool()`select 1 from creatives where workspace_id = ${t.workspaceId} and platform_refs->>'copy' = 'An ad with borrowed footage'`).toHaveLength(0);
    expect(await call('MEMBER', `/api/w/${t.slug}/import-creative`, workspacePost, { slug: t.slug, action: 'import-creative' }, form({ skuId, copy: 'Copy only, no video' })())).toBe(200);
  });

  it('an older import can be attested afterwards', async () => {
    const { productPhoto, ctxFor } = await import('@arkiv/core/testing');
    const { ingestBytes } = await import('@arkiv/core');
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctxFor(t.workspaceId, users.OWNER), await productPhoto(), 'historical_creative', skuId));
    expect(await call('MEMBER', `/api/w/${t.slug}/asset-attest`, workspacePost, { slug: t.slug, action: 'asset-attest' }, { assetId: asset.id })).toBe(200);
    const [a] = await ownerPool()`select rights_attested_by from assets where id = ${asset.id}`;
    expect(a!.rights_attested_by).toBe(users.MEMBER);
  });
});

describe('offer context facts (plan 03 A4)', () => {
  it('stores subscription and bundle availability as yes/no, and refuses anything else', async () => {
    const post = (value: string) => call('MEMBER', `/api/w/${t.slug}/fact`, workspacePost, { slug: t.slug, action: 'fact' }, { skuId, key: 'subscription_available', value });
    expect(await post('Yes')).toBe(200);
    const [f] = await ownerPool()`select value_json, state from product_facts where sku_id = ${skuId} and normalized_key = 'subscription_available' and status <> 'SUPERSEDED' order by observed_at desc limit 1`;
    expect(f).toMatchObject({ value_json: true, state: 'DECIDED' });
    expect(await post('sometimes')).toBe(422);
  });
});

describe('step-up confirmation (plan 02 M14)', () => {
  it('disconnecting an integration, exporting and changing the Owner need a sign-in from the last 10 minutes', async () => {
    const post = async (action: string, payload: unknown, signedInAt: Date) => {
      who = { userId: users.OWNER, workspaceId: t.workspaceId, signedInAt };
      const res = await workspacePost(
        new Request(`http://localhost/api/w/${t.slug}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `k-${u()}` }, body: JSON.stringify(payload) }),
        { params: Promise.resolve({ slug: t.slug, action }) } as never,
      );
      return { status: res.status, body: (await res.json()) as { details?: { stepUp?: boolean } } };
    };
    const old = new Date(Date.now() - 30 * 60_000);
    for (const [action, payload] of [['integration-disconnect', { id: u() }], ['export', {}], ['transfer', { userId: users.ADMIN }]] as const) {
      const r = await post(action, payload, old);
      expect(r.status, action).toBe(403);
      expect(r.body.details?.stepUp, action).toBe(true);
    }
    // Nothing happened while the confirmation was missing.
    expect(await ownerPool()`select 1 from outbox where workspace_id = ${t.workspaceId} and queue = 'export-workspace'`).toHaveLength(0);
    expect((await ownerPool()`select role from memberships where user_id = ${users.OWNER} and workspace_id = ${t.workspaceId}`)[0]!.role).toBe('OWNER');
    // Freshly signed in: the export goes through; an unknown integration is a plain 404, not a step-up.
    expect((await post('export', {}, new Date())).status).toBe(200);
    expect((await post('integration-disconnect', { id: u() }, new Date())).status).toBe(404);
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
  ['edit-text', () => ({ cta: 'Shop now' })],
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
