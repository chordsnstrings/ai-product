import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { unzipSync } from 'fflate';
import { deliveryBundle, recordAssetExport } from './exports';
import { storage } from './storage';
import { computeRisk } from './lifecycle';
import { ctxFor } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

async function project(ws: string, skuId: string, kind: string) {
  const id = newId();
  await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by) values (${id}, ${ws}, ${skuId}, ${kind}, 'COMPLETE', 'test')`;
  return id;
}

async function finalExport(ws: string, skuId: string, lineage: Record<string, unknown>) {
  const [a] = await ownerPool()`insert into assets (workspace_id, sku_id, kind, mime, bytes, checksum_sha256, storage_key, source, lineage)
                                values (${ws}, ${skuId}, 'final_export', 'video/mp4', 1, ${newId()}, ${newId()}, 'composed', ${ownerPool().json(lineage as never)}) returning id`;
  return a!.id as string;
}

const paidNoExport = async (ws: string) => (await withSystem((tx) => computeRisk(tx, ws))).find((s) => s.indicator === 'paid_no_export');

describe('asset export events (Appendix B, §10 paid_no_export)', () => {
  it('keys ASSET_EXPORTED on the project, emits VARIANT_EXPORTED for variants, and clears paid_no_export', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ws = t.workspaceId;
    const skuId = await makeSku(ws);
    const taste = await project(ws, skuId, 'taste');
    const test = await project(ws, skuId, 'creative_test');
    const tasteAsset = await finalExport(ws, skuId, { projectId: taste, aspect: '9x16' });
    const variantId = newId();
    const hookAsset = await finalExport(ws, skuId, { projectId: test, variantId, aspect: '4x5' });

    expect((await paidNoExport(ws))?.evidence).toMatchObject({ projects: 2 });

    const ctx = ctxFor(ws, t.userId);
    // Another project's asset is refused (the caller checked access on the project, not the asset).
    expect(await withTenant(ws, (tx) => recordAssetExport(tx, ctx, tasteAsset, test))).toBeNull();

    const r = await withTenant(ws, (tx) => recordAssetExport(tx, ctx, tasteAsset, taste));
    expect(r).toMatchObject({ projectId: taste, variantId: null, aspect: '9x16' });
    expect((await paidNoExport(ws))?.evidence).toMatchObject({ projects: 1 });

    const v = await withTenant(ws, (tx) => recordAssetExport(tx, ctx, hookAsset, test));
    expect(v).toMatchObject({ projectId: test, variantId });
    expect(await paidNoExport(ws)).toBeUndefined();

    const events = await ownerPool()`select type, subject_type, subject_id, payload, refs from events where workspace_id = ${ws} and type in ('ASSET_EXPORTED','VARIANT_EXPORTED') order by at, type`;
    expect(events.filter((e) => e.type === 'ASSET_EXPORTED').map((e) => (e.payload as { projectId: string }).projectId).sort()).toEqual([taste, test].sort());
    const ve = events.find((e) => e.type === 'VARIANT_EXPORTED')!;
    expect(ve).toMatchObject({ subject_type: 'variant', subject_id: variantId, payload: { assetId: hookAsset, projectId: test, aspect: '4x5' } });
  });

  it('still matches legacy export events that only name the asset', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ws = t.workspaceId;
    const skuId = await makeSku(ws);
    const p = await project(ws, skuId, 'standalone');
    const asset = await finalExport(ws, skuId, { projectId: p, aspect: '9x16' });
    await ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${ws}, 'ASSET_EXPORTED', 'user:x', 'asset', ${asset}, '{}')`;
    expect(await paidNoExport(ws)).toBeUndefined();
  });

  it('uses the project control variant for an experiment master export', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ws = t.workspaceId;
    const skuId = await makeSku(ws);
    const [e] = await ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, mode, created_by) values (${ws}, ${skuId}, 'h', 'hook', 'CONTROLLED', 'test') returning id`;
    const [v] = await ownerPool()`insert into variants (workspace_id, experiment_id, label, code, role) values (${ws}, ${e!.id}, 'A', 'AK-001-A', 'control') returning id`;
    const p = await project(ws, skuId, 'creative_test');
    await ownerPool()`update projects set experiment_id = ${e!.id}, variant_id = ${v!.id} where id = ${p}`;
    const asset = await finalExport(ws, skuId, { projectId: p, aspect: '1x1' });
    const r = await withTenant(ws, (tx) => recordAssetExport(tx, ctxFor(ws, t.userId), asset, p));
    expect(r).toMatchObject({ variantId: v!.id, experimentId: e!.id });
    const [ve] = await ownerPool()`select subject_id, payload, refs from events where workspace_id = ${ws} and type = 'VARIANT_EXPORTED'`;
    expect(ve).toMatchObject({ subject_id: v!.id, payload: { experimentId: e!.id, assetId: asset }, refs: { experimentId: e!.id, projectId: p } });
  });

  it('"Download all" zips the delivered formats and the bonus hook, counting each as an export (plan 03 P10)', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ws = t.workspaceId;
    const skuId = await makeSku(ws);
    const ctx = ctxFor(ws, t.userId);
    const pid = await project(ws, skuId, 'taste');
    const stored = async (lineage: Record<string, unknown>, body: string) => {
      const id = await finalExport(ws, skuId, lineage);
      const key = `test/${id}.mp4`;
      await storage().put(key, Buffer.from(body), 'video/mp4');
      await ownerPool()`update assets set storage_key = ${key} where id = ${id}`;
      return id;
    };
    const tall = await stored({ projectId: pid, aspect: '9x16' }, 'tall');
    const square = await stored({ projectId: pid, aspect: '1x1' }, 'square');
    const alt = await stored({ projectId: pid, aspect: '9x16' }, 'alt');
    const foreign = await stored({ projectId: newId(), aspect: '4x5' }, 'not this project');
    const [main] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin, final_asset_ids) values (${ws}, ${skuId}, 'generated', ${[tall, square, foreign]}) returning id`;
    const [bonus] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin, final_asset_ids) values (${ws}, ${skuId}, 'generated', ${[alt]}) returning id`;
    await ownerPool()`update projects set final_creative_id = ${main!.id}, bonus_hook_creative_id = ${bonus!.id} where id = ${pid}`;
    await ownerPool()`update skus set name = 'Glow Serum' where id = ${skuId}`;

    const b = await withTenant(ws, (tx) => deliveryBundle(tx, ctx, pid));
    expect(b!.files).toBe(3);
    const files = unzipSync(b!.zip);
    expect(Object.keys(files).sort()).toEqual(['glow-serum-1x1.mp4', 'glow-serum-9x16.mp4', 'glow-serum-alt-hook-9x16.mp4']);
    expect(Buffer.from(files['glow-serum-9x16.mp4']!).toString()).toBe('tall');
    const exported = await ownerPool()`select subject_id from events where workspace_id = ${ws} and type = 'ASSET_EXPORTED'`;
    expect(exported.map((e) => e.subject_id).sort()).toEqual([tall, square, alt].sort());
    // Another tenant gets nothing; an unfinished project has nothing to bundle.
    const other = await makeTenant();
    expect(await withTenant(other.workspaceId, (tx) => deliveryBundle(tx, ctxFor(other.workspaceId, other.userId), pid))).toBeNull();
    await ownerPool()`update projects set state = 'RENDERING' where id = ${pid}`;
    expect(await withTenant(ws, (tx) => deliveryBundle(tx, ctx, pid))).toBeNull();
  });
});
