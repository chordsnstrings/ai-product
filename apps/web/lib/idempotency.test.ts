import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { ingestBytes, proposeClaim, startPreview } from '@arkiv/core';
import { ctxFor, productPhoto } from '../../../packages/core/src/testing';
import { idempotencyKeyOf, withIdempotency } from './http';

beforeEach(truncateAll);
afterAll(closeAll);

const req = (key?: string) => new Request('http://localhost/api/preview', { method: 'POST', headers: key === undefined ? {} : { 'Idempotency-Key': key } });
const count = (table: 'skus' | 'projects' | 'claims', ws: string) => ownerPool()`select count(*)::int as n from ${ownerPool()(table)} where workspace_id = ${ws}`.then((r) => r[0]!.n as number);

describe('Idempotency-Key on externally triggered creates (standard §39, §35)', () => {
  it('reads the header, and refuses a malformed key', () => {
    expect(idempotencyKeyOf(req())).toBeNull();
    expect(idempotencyKeyOf(req('0b6f2f4e-8f7a-4c52-9d38-2a1f7c9e1a11'))).toBe('0b6f2f4e-8f7a-4c52-9d38-2a1f7c9e1a11');
    expect(() => idempotencyKeyOf(req('short'))).toThrow(/Idempotency-Key/);
    expect(() => idempotencyKeyOf(req('has spaces in it'))).toThrow(/Idempotency-Key/);
  });

  it('a replayed preview returns the first product and creates no second SKU or project', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
    const request = { url: null, uploaded: [asset.id], photos: [] };
    const run = (key: string | null, r: unknown = request) =>
      withTenant(t.workspaceId, (tx) => withIdempotency(tx, t.workspaceId, 'preview', key, r, () => startPreview(tx, ctx, { photoAssetIds: [asset.id] })));
    const first = await run('preview-key-0001');
    const again = await run('preview-key-0001');
    expect(again).toEqual(first);
    expect(await count('skus', t.workspaceId)).toBe(1);
    expect(await count('projects', t.workspaceId)).toBe(1);
    // The same key for a different request is refused, not silently answered with the first product.
    await expect(run('preview-key-0001', { ...request, url: 'https://example.com/p' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Stored against this workspace and operation.
    const rows = await ownerPool()`select workspace_id, operation from idempotency_keys where key = 'preview-key-0001'`;
    expect(rows).toEqual([{ workspace_id: t.workspaceId, operation: 'preview' }]);
  }, 60_000);

  it('a create that fails stores nothing, so the same key can try again; without a key it just runs', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const [sku] = await ownerPool()`insert into skus (workspace_id, catalogue_no, name, status, category) values (${t.workspaceId}, 1, 'Glow Serum', 'active', 'serum') returning id`;
    const skuId = sku!.id as string;
    const propose = (key: string | null, wording: string) => withTenant(t.workspaceId, (tx) => withIdempotency(tx, t.workspaceId, 'claim-propose', key, { skuId, wording }, () => proposeClaim(tx, ctx, skuId, { wording, origin: 'merchant' })));
    await expect(
      withTenant(t.workspaceId, (tx) =>
        withIdempotency(tx, t.workspaceId, 'claim-propose', 'claim-key-0001', { skuId, wording: 'Feels light' }, async () => {
          throw new Error('provider hiccup');
        }),
      ),
    ).rejects.toThrow('provider hiccup');
    expect((await ownerPool()`select count(*)::int as n from idempotency_keys where key = 'claim-key-0001'`)[0]!.n).toBe(0);
    const a = await propose('claim-key-0001', 'Feels light');
    expect(await propose('claim-key-0001', 'Feels light')).toEqual(a);
    expect(await count('claims', t.workspaceId)).toBe(1);
    await propose(null, 'Absorbs quickly');
    expect(await count('claims', t.workspaceId)).toBe(2);
  }, 60_000);
});
