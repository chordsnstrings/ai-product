import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant, type Tx } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, type Role, type WorkspaceState } from '@arkiv/shared';
import { requestConcepts } from './analysis';
import { can } from './authz';
import { attachEvidence } from './claims';
import type { TenantContext } from './context';
import { linkAdToVariant, markConfounder, setExperimentState } from './experiments';
import { importHistoricalCreative } from './genome';
import { cancelDeletion, requestExport, scheduleDeletion } from './lifecycle';
import { retryProduction } from './production';
import { confirmFact, decideFact } from './product-truth';
import { dismissRecommendation } from './recommendations';
import { requestFrameRegeneration, setSceneLock } from './storyboard';
import { productPhoto } from './testing';
import { createUpload, ingestBytes } from './uploads';
import { changeRole, removeMember } from './workspaces';

beforeEach(truncateAll);
afterAll(closeAll);

const ctxOf = (workspaceId: string, userId: string, role: Role, state: WorkspaceState): TenantContext => ({
  workspaceId,
  workspaceState: state,
  role,
  actor: { kind: 'user', id: userId },
  requestId: 'test',
});

async function addMember(workspaceId: string, role: Role) {
  const [u] = await ownerPool()`insert into users (email) values (${`m-${newId().slice(-10)}@example.com`}) returning id`;
  await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${u!.id}, ${role})`;
  return u!.id as string;
}

/**
 * Plan 02 §1.1 + tenancy-04: every mutating domain function re-checks the role and the workspace state on the
 * server. A Viewer, or anyone in a held (LOCKED) workspace, gets FORBIDDEN before anything is written.
 */
describe('domain mutations refuse Viewers and held workspaces', () => {
  const any = '00000000-0000-4000-8000-000000000000';
  const calls: [string, (tx: Tx, ctx: TenantContext, f: { skuId: string; projectId: string }) => Promise<unknown>][] = [
    ['dismissRecommendation', (tx, ctx) => dismissRecommendation(tx, ctx, any, 'not now')],
    ['linkAdToVariant', (tx, ctx) => linkAdToVariant(tx, ctx, 'meta', 'ad_123', any)],
    ['setExperimentState', (tx, ctx) => setExperimentState(tx, ctx, any, 'GATHERING_SIGNAL', 'merchant marked as running')],
    ['markConfounder', (tx, ctx) => markConfounder(tx, ctx, { kind: 'stockout', startsAt: '2026-09-01' })],
    ['attachEvidence', (tx, ctx) => attachEvidence(tx, ctx, any, { type: 'lab_test' })],
    ['importHistoricalCreative', (tx, ctx, f) => importHistoricalCreative(tx, ctx, { skuId: f.skuId, copy: 'An old ad' })],
    ['ingestBytes', async (tx, ctx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null)],
    ['createUpload', (tx, ctx) => createUpload(tx, ctx, 'product_photo', 'image/jpeg', 1000)],
    ['decideFact', (tx, ctx, f) => decideFact(tx, ctx, f.skuId, 'size', { text: '50 ml' })],
    ['confirmFact', (tx, ctx) => confirmFact(tx, ctx, any)],
    ['requestConcepts', (tx, ctx, f) => requestConcepts(tx, ctx, f.projectId)],
    ['requestFrameRegeneration', (tx, ctx) => requestFrameRegeneration(tx, ctx, any, 'warmer light')],
    ['setSceneLock', (tx, ctx) => setSceneLock(tx, ctx, any, true)],
    ['retryProduction', (tx, ctx, f) => retryProduction(tx, ctx, f.projectId)],
    ['scheduleDeletion', (tx, ctx) => scheduleDeletion(tx, ctx)],
  ];

  it('export stays available to the Owner of a held workspace, never to a Viewer', async () => {
    const t = await makeTenant({ state: 'LOCKED' });
    const viewerId = await addMember(t.workspaceId, 'VIEWER');
    await expect(withTenant(t.workspaceId, (tx) => requestExport(tx, ctxOf(t.workspaceId, viewerId, 'VIEWER', 'ACTIVE_PAID')))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await withTenant(t.workspaceId, (tx) => requestExport(tx, ctxOf(t.workspaceId, t.userId, 'OWNER', 'LOCKED')));
  });

  for (const [name, call] of calls) {
    it(name, async () => {
      const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
      const skuId = await makeSku(t.workspaceId);
      const projectId = newId();
      await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit)
                        values (${projectId}, ${t.workspaceId}, ${skuId}, 'taste', 'PROVIDER_FAILED', 'test', 'taste')`;
      const viewerId = await addMember(t.workspaceId, 'VIEWER');
      const before = (await ownerPool()`select count(*)::int as n from events`)[0]!.n;
      const viewer = ctxOf(t.workspaceId, viewerId, 'VIEWER', 'ACTIVE_PAID');
      const lockedOwner = ctxOf(t.workspaceId, t.userId, 'OWNER', 'LOCKED');
      await expect(withTenant(t.workspaceId, (tx) => call(tx, viewer, { skuId, projectId })), `${name} as viewer`).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(withTenant(t.workspaceId, (tx) => call(tx, lockedOwner, { skuId, projectId })), `${name} while locked`).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await ownerPool()`select count(*)::int as n from events`)[0]!.n).toBe(before);
    });
  }

  it('system transitions (results, variants) are not blocked by the user check', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const skuId = await makeSku(t.workspaceId);
    const [e] = await ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, primary_metric, mode, state, created_by)
                                  values (${t.workspaceId}, ${skuId}, 'h', 'hook', 'ctr', 'CONTROLLED', 'READY_TO_RUN', 'test') returning id`;
    const moved = await withTenant(t.workspaceId, (tx) => setExperimentState(tx, { workspaceId: t.workspaceId, actor: { kind: 'system', id: 'job' } }, e!.id as string, 'GATHERING_SIGNAL'));
    expect(moved).toBe(true);
  });
});

describe('scheduled deletion can be cancelled by the Owner (plan 02 §2, §7)', () => {
  it('cancels from PURGE_SCHEDULED and restores the previous state', async () => {
    const t = await makeTenant({ state: 'ACTIVE_FREE' });
    await withTenant(t.workspaceId, (tx) => scheduleDeletion(tx, ctxOf(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE')));
    const [w1] = await ownerPool()`select state, purge_at, state_before_purge from workspaces where id = ${t.workspaceId}`;
    expect(w1!.state).toBe('PURGE_SCHEDULED');
    expect(w1!.purge_at).not.toBeNull();
    expect(w1!.state_before_purge).toBe('ACTIVE_FREE');
    // The next request resolves the workspace as PURGE_SCHEDULED; the Owner's undo must still be allowed.
    const scheduled = ctxOf(t.workspaceId, t.userId, 'OWNER', 'PURGE_SCHEDULED');
    expect(await withTenant(t.workspaceId, (tx) => cancelDeletion(tx, scheduled))).toBe('ACTIVE_FREE');
    const [w2] = await ownerPool()`select state, purge_at, state_before_purge from workspaces where id = ${t.workspaceId}`;
    expect(w2).toMatchObject({ state: 'ACTIVE_FREE', purge_at: null, state_before_purge: null });
  });

  it('a lapsed paid workspace comes back as CANCELLED, never as paid without a subscription', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    await withTenant(t.workspaceId, (tx) => scheduleDeletion(tx, ctxOf(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID')));
    expect(await withTenant(t.workspaceId, (tx) => cancelDeletion(tx, ctxOf(t.workspaceId, t.userId, 'OWNER', 'PURGE_SCHEDULED')))).toBe('CANCELLED');
  });

  it('only the Owner may cancel, and only while deletion is scheduled', async () => {
    const t = await makeTenant({ state: 'PURGE_SCHEDULED' });
    const adminId = await addMember(t.workspaceId, 'ADMIN');
    await expect(withTenant(t.workspaceId, (tx) => cancelDeletion(tx, ctxOf(t.workspaceId, adminId, 'ADMIN', 'PURGE_SCHEDULED')))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(can({ role: 'OWNER', workspaceState: 'ACTIVE_FREE' }, 'workspace.cancel_deletion')).toBe(false);
    expect(can({ role: 'OWNER', workspaceState: 'PURGE_SCHEDULED' }, 'workspace.cancel_deletion')).toBe(true);
    // Scheduling is still a normal write: blocked once scheduled.
    expect(can({ role: 'OWNER', workspaceState: 'PURGE_SCHEDULED' }, 'workspace.delete')).toBe(false);
  });
});

describe('member management matrix (plan 02 §1.1: Admin ✓ except Owners)', () => {
  it('an Admin can demote and remove another Admin', async () => {
    const t = await makeTenant({ plan: 'SCALE', state: 'ACTIVE_PAID' });
    const a1 = await addMember(t.workspaceId, 'ADMIN');
    const a2 = await addMember(t.workspaceId, 'ADMIN');
    const admin = ctxOf(t.workspaceId, a1, 'ADMIN', 'ACTIVE_PAID');
    await withTenant(t.workspaceId, (tx) => changeRole(tx, admin, a2, 'MEMBER'));
    expect((await ownerPool()`select role from memberships where user_id = ${a2}`)[0]!.role).toBe('MEMBER');
    await withTenant(t.workspaceId, (tx) => changeRole(tx, admin, a2, 'ADMIN'));
    await withTenant(t.workspaceId, (tx) => removeMember(tx, admin, a2));
    expect(await ownerPool()`select 1 from memberships where user_id = ${a2}`).toHaveLength(0);
  });

  it('an Admin cannot demote or remove an Owner, or make anyone Owner', async () => {
    const t = await makeTenant({ plan: 'SCALE', state: 'ACTIVE_PAID' });
    const a1 = await addMember(t.workspaceId, 'ADMIN');
    const m1 = await addMember(t.workspaceId, 'MEMBER');
    const admin = ctxOf(t.workspaceId, a1, 'ADMIN', 'ACTIVE_PAID');
    await expect(withTenant(t.workspaceId, (tx) => changeRole(tx, admin, t.userId, 'ADMIN'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(withTenant(t.workspaceId, (tx) => removeMember(tx, admin, t.userId))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(withTenant(t.workspaceId, (tx) => changeRole(tx, admin, m1, 'OWNER'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a Member cannot manage anyone', async () => {
    const t = await makeTenant({ plan: 'SCALE', state: 'ACTIVE_PAID' });
    const m1 = await addMember(t.workspaceId, 'MEMBER');
    const v1 = await addMember(t.workspaceId, 'VIEWER');
    await expect(withTenant(t.workspaceId, (tx) => changeRole(tx, ctxOf(t.workspaceId, m1, 'MEMBER', 'ACTIVE_PAID'), v1, 'MEMBER'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
