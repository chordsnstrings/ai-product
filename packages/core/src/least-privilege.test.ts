import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, globalTx, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, resetEnvCache } from '@arkiv/shared';
import { claimsCheckedLast7Days, landingAssetProblems, publicExampleUrls } from './landing';
import { purgeWorkspace } from './lifecycle';
import { storage } from './storage';
import { createProvisionalWorkspace, deletedUserActor, deleteUser, moveProvisionalSkus } from './workspaces';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

beforeEach(truncateAll);
afterEach(() => {
  delete process.env.DB_ROLES;
  resetEnvCache();
});
afterAll(closeAll);

/** Run `fn` as the customer web process runs: only the app database role may be opened. */
async function asWebProcess<T>(fn: () => Promise<T>): Promise<T> {
  process.env.DB_ROLES = 'app';
  resetEnvCache();
  try {
    return await fn();
  } finally {
    delete process.env.DB_ROLES;
    resetEnvCache();
  }
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (n === 'node_modules' || n === '.next') return [];
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('the customer app holds only app_rw (plan 02 §3 layer 2)', () => {
  it('refuses any other role in a process limited by DB_ROLES', async () => {
    await asWebProcess(async () => {
      await expect(withSystem((tx) => tx`select 1`)).rejects.toThrow(/may not use the system database role/);
      await expect(globalTx((tx) => tx`select 1 as ok`)).resolves.toEqual([{ ok: 1 }]);
    });
  });

  it('no web source opens a cross-tenant role directly', () => {
    const offenders = sources(path.join(root, 'apps/web')).filter((f) => /\b(withSystem|withAdmin|systemPool|adminPool|ownerPool)\b/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('deploys the web component with the app connection only', () => {
    const yaml = readFileSync(path.join(root, 'infra/do/app.yaml'), 'utf8');
    const top = yaml.slice(0, yaml.indexOf('\njobs:'));
    for (const k of ['DATABASE_URL', 'APP_DATABASE_URL', 'ADMIN_DATABASE_URL', 'SYSTEM_DATABASE_URL']) expect(top).not.toMatch(new RegExp(`key: ${k}\\b`));
    const web = yaml.slice(yaml.indexOf('- name: web'), yaml.indexOf('- name: admin'));
    expect(web).toMatch(/key: DB_ROLES, value: app,/);
    expect(web).toMatch(/key: APP_DATABASE_URL\b/);
    for (const k of ['DATABASE_URL', 'ADMIN_DATABASE_URL', 'SYSTEM_DATABASE_URL']) expect(web).not.toMatch(new RegExp(`key: ${k}\\b`));
  });

  it('saves a preview into an existing account as the app role, and objects follow the SKU', async () => {
    const home = await makeTenant();
    const prov = await createProvisionalWorkspace();
    const sku = await makeSku(prov.workspaceId, 'Dew Serum');
    const id = newId();
    const oldKey = `t/${prov.workspaceId}/photos/${id}.jpg`;
    await storage().put(oldKey, Buffer.from('photo'), 'image/jpeg');
    await ownerPool()`insert into assets (id, workspace_id, sku_id, kind, storage_key, mime, bytes, checksum_sha256, source)
                      values (${id}, ${prov.workspaceId}, ${sku}, 'product_photo', ${oldKey}, 'image/jpeg', 5, 'x', 'upload')`;
    const stranger = await makeTenant();

    await asWebProcess(async () => {
      // Only into a workspace the user belongs to.
      await expect(moveProvisionalSkus(prov.workspaceId, home.workspaceId, stranger.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await moveProvisionalSkus(prov.workspaceId, home.workspaceId, home.userId)).toBe(1);
      await expect(moveProvisionalSkus(prov.workspaceId, home.workspaceId, home.userId)).rejects.toMatchObject({ code: 'CONFLICT' });
      // Never out of a real workspace.
      await expect(moveProvisionalSkus(stranger.workspaceId, home.workspaceId, home.userId)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    const [s] = await ownerPool()`select workspace_id from skus where id = ${sku}`;
    expect(s!.workspace_id).toBe(home.workspaceId);
    const [a] = await ownerPool()`select workspace_id, storage_key from assets where id = ${id}`;
    expect(a).toEqual({ workspace_id: home.workspaceId, storage_key: `t/${home.workspaceId}/photos/${id}.jpg` });
    expect((await storage().get(a!.storage_key as string)).toString()).toBe('photo');
    const [w] = await ownerPool()`select state from workspaces where id = ${prov.workspaceId}`;
    expect(w!.state).toBe('PURGE_SCHEDULED');
  });

  it('the purge re-homes objects another workspace still references before deleting the prefix', async () => {
    const home = await makeTenant();
    const prov = await makeTenant({ state: 'PURGE_SCHEDULED' });
    const sku = await makeSku(home.workspaceId);
    const id = newId();
    const key = `t/${prov.workspaceId}/photos/${id}.jpg`;
    await storage().put(key, Buffer.from('kept'), 'image/jpeg');
    await ownerPool()`insert into assets (id, workspace_id, sku_id, kind, storage_key, mime, bytes, checksum_sha256, source)
                      values (${id}, ${home.workspaceId}, ${sku}, 'product_photo', ${key}, 'image/jpeg', 4, 'x', 'upload')`;
    await ownerPool()`update workspaces set purge_at = now() - interval '1 minute' where id = ${prov.workspaceId}`;
    await purgeWorkspace(prov.workspaceId);
    const [a] = await ownerPool()`select storage_key from assets where id = ${id}`;
    expect(a!.storage_key).toBe(`t/${home.workspaceId}/photos/${id}.jpg`);
    expect((await storage().get(a!.storage_key as string)).toString()).toBe('kept');
  });

  it('deletes an account as the app role; events are re-attributed only for a deleted user', async () => {
    const t = await makeTenant();
    await ownerPool()`update workspaces set state = 'CANCELLED' where id = ${t.workspaceId}`;
    await ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${t.workspaceId}, 'SKU_CREATED', ${'user:' + t.userId}, 'sku', ${newId()}, '{}')`;
    const other = await makeTenant();
    // The database refuses to anonymize a live user, or to a made-up actor.
    await expect(globalTx((tx) => tx`select arkiv_anonymize_user_events(${other.userId}::uuid, ${deletedUserActor(other.userId)})`)).rejects.toThrow(/not deleted/);
    await expect(globalTx((tx) => tx`select arkiv_anonymize_user_events(${other.userId}::uuid, 'user:deleted:0000000000000000')`)).rejects.toThrow(/invalid anonymous actor/);

    await asWebProcess(() => deleteUser(t.userId, { by: 'self' }));
    const [e] = await ownerPool()`select actor from events where workspace_id = ${t.workspaceId} and type = 'SKU_CREATED'`;
    expect(e!.actor).toBe(deletedUserActor(t.userId));
    const [u] = await ownerPool()`select deleted_at, email from users where id = ${t.userId}`;
    expect(u!.deleted_at).not.toBeNull();
    // Owner-of-a-live-workspace refusal still works without a cross-tenant read.
    await expect(asWebProcess(() => deleteUser(other.userId))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('landing examples and the proof count need no cross-tenant role, and follow the same rules as the console', async () => {
    const demo = await makeTenant();
    await ownerPool()`update workspaces set is_test = true where id = ${demo.workspaceId}`;
    const customer = await makeTenant();
    const mk = async (ws: string, o: { category?: string; kind?: string; expired?: boolean; source?: string } = {}) => {
      const sku = await makeSku(ws, 'Demo Serum');
      await ownerPool()`update skus set category = ${o.category ?? 'serum'} where id = ${sku}`;
      const id = newId();
      await ownerPool()`insert into assets (id, workspace_id, sku_id, kind, storage_key, mime, bytes, checksum_sha256, source, rights_expires_at)
                        values (${id}, ${ws}, ${sku}, ${o.kind ?? 'final_export'}, ${`t/${ws}/${id}.mp4`}, 'video/mp4', 10, 'x', ${o.source ?? 'composed'},
                                ${o.expired ? new Date(Date.now() - 60_000) : null})`;
      return id;
    };
    const ids = [
      await mk(demo.workspaceId),
      await mk(demo.workspaceId, { kind: 'scene_render' }),
      await mk(customer.workspaceId),
      await mk(demo.workspaceId, { category: 'sunscreen' }),
      await mk(demo.workspaceId, { kind: 'product_photo' }),
      await mk(demo.workspaceId, { expired: true }),
      await mk(demo.workspaceId, { source: 'upload' }),
      newId(),
    ];
    await ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${customer.workspaceId}, 'CLAIM_CREATED', 'system:x', 'claim', ${newId()}, '{}')`;

    const { shown, count } = await asWebProcess(async () => ({
      shown: [...(await globalTx((tx) => publicExampleUrls(tx, ids))).keys()].sort(),
      count: await globalTx((tx) => claimsCheckedLast7Days(tx)),
    }));
    const problems = new Set((await withSystem((tx) => landingAssetProblems(tx, ids))).map((p) => p.assetId));
    expect(shown).toEqual(ids.filter((id) => !problems.has(id)).sort());
    expect(shown).toEqual([ids[0], ids[1]].sort());
    expect(count).toBe(1);
    // The same ids read directly as the app role see nothing across tenants.
    await expect(withTenant(customer.workspaceId, (tx) => tx`select id from assets where id = ${ids[0]!}`)).resolves.toEqual([]);
  });
});
