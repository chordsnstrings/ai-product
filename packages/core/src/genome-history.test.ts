import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { ffmpeg, withTempDir } from '@arkiv/media';
import { newId, type StaffRole } from '@arkiv/shared';
import type { Staff } from './admin';
import { extractGenome, importHistoricalCreative, stillTimes } from './genome';
import { append } from './ledger';
import { applyTaxonomyRemap, proposeTaxonomyChange, reviewTaxonomyProposal } from './taxonomy';
import { ctxFor } from './testing';
import { ingestBytes } from './uploads';

/** Standard §19: versioned genomes with history, re-read on a taxonomy change, and read from the ad's video. */
beforeEach(truncateAll);
afterEach(async () => {
  await ownerPool()`delete from taxonomy_versions where version > 1`;
});
afterAll(closeAll);

/** A 6-second clip of three solid colours: two hard cuts, at 2s and 4s. */
async function threeShotClip(): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const out = path.join(dir, 'ad.mp4');
    const shot = (c: string) => ['-f', 'lavfi', '-i', `color=c=${c}:s=180x320:d=2:r=10`];
    await ffmpeg([...shot('red'), ...shot('blue'), ...shot('green'), '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out], 60_000);
    return readFile(out);
  });
}

async function staff(roles: StaffRole[] = ['ENGINEERING']): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, 'Eng', 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: 'Eng', roles };
}

async function tenant() {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const skuId = await makeSku(t.workspaceId);
  await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 3, periodKey: '2026-09-01', idempotencyKey: 'grant:g' }));
  return { t, ctx, skuId };
}

describe('genome from the ad’s video (§19 hook and production genes)', () => {
  it('measures duration, scenes and cut rate from the video and sends stills to the analyst', async () => {
    const { t, ctx, skuId } = await tenant();
    const asset = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await threeShotClip(), 'historical_creative', skuId));
    const id = await withTenant(t.workspaceId, (tx) => importHistoricalCreative(tx, ctx, { skuId, copy: 'Watch the texture absorb', assetId: asset.id }));
    expect(await extractGenome(ctx, id)).toBe(true);
    const [c] = await ownerPool()`select genome from creatives where id = ${id}`;
    const g = c!.genome as { durationSec: number; production: { sceneCount: number; cutsPerMinute: number; durationSec: number } };
    expect(g.durationSec).toBeCloseTo(6, 0);
    expect(g.production.sceneCount).toBe(3);
    expect(g.production.cutsPerMinute).toBeCloseTo(20, 0);
    // The model call carried the stills and the measured cuts.
    const [job] = await ownerPool()`select input_refs from provider_jobs where task = 'genome.extract' and workspace_id = ${t.workspaceId}`;
    expect(job!.input_refs).toMatchObject({ video: { cuts: 2, stills: 3 } });
    expect(stillTimes(6)).toEqual([0, 1, 3]);
    expect(stillTimes(20)).toEqual([0, 1, 3, 10]);
  }, 60_000);

  it('an ad without a readable video is read from its copy', async () => {
    const { t, ctx, skuId } = await tenant();
    const id = await withTenant(t.workspaceId, (tx) => importHistoricalCreative(tx, ctx, { skuId, copy: 'My 3 step routine' }));
    expect(await extractGenome(ctx, id)).toBe(true);
    const [c] = await ownerPool()`select genome from creatives where id = ${id}`;
    expect((c!.genome as { angle: string }).angle).toBe('ROUTINE');
  });
});

describe('genome history (§19 versioned genome)', () => {
  it('keeps every genome; a genome read against an older taxonomy is read again, a current one is not', async () => {
    const { t, ctx, skuId } = await tenant();
    const id = await withTenant(t.workspaceId, (tx) => importHistoricalCreative(tx, ctx, { skuId, copy: 'Watch the texture absorb' }));
    expect(await extractGenome(ctx, id)).toBe(true);
    expect(await extractGenome(ctx, id)).toBe(false); // current: nothing to do
    const history = async () => ownerPool()`select source, taxonomy_version, schema_version from creative_genomes where creative_id = ${id} order by created_at, id`;
    expect(await history()).toEqual([{ source: 'extracted', taxonomy_version: 1, schema_version: 2 }]);

    // A new taxonomy version: the genome is stale and read again; the first one stays.
    const [a, b] = [await staff(), await staff()];
    const add = await withAdmin((tx) => proposeTaxonomyChange(tx, a, { family: 'proof', op: 'add', value: 'PATCH_TEST', reason: 'new proof type' }));
    await withAdmin((tx) => reviewTaxonomyProposal(tx, b, add, true, 'ok'));
    expect(await extractGenome(ctx, id)).toBe(true);
    expect(await history()).toEqual([
      { source: 'extracted', taxonomy_version: 1, schema_version: 2 },
      { source: 'reextracted', taxonomy_version: 2, schema_version: 2 },
    ]);
    // History is append-only for the app.
    await expect(withTenant(t.workspaceId, (tx) => tx`delete from creative_genomes where creative_id = ${id}`)).rejects.toThrow();
    await expect(ownerPool()`update creative_genomes set source = 'generated' where creative_id = ${id}`).rejects.toThrow(/append-only/);
  });

  it('a remap records a new genome version at the new taxonomy version', async () => {
    const { t, skuId } = await tenant();
    const [c] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin, genome, genome_version) values (${t.workspaceId}, ${skuId}, 'imported', ${ownerPool().json({ angle: 'MYTH_BUSTING' })}, 1) returning id`;
    const [a, b] = [await staff(), await staff()];
    const id = await withAdmin((tx) => proposeTaxonomyChange(tx, a, { family: 'angle', op: 'rename', value: 'MYTH_BUSTING', to: 'MYTH_CORRECTION', reason: 'clearer' }));
    await withAdmin((tx) => reviewTaxonomyProposal(tx, b, id, true, 'ok'));
    await applyTaxonomyRemap(id);
    expect((await ownerPool()`select genome_version from creatives where id = ${c!.id}`)[0]!.genome_version).toBe(2);
    const rows = await ownerPool()`select source, taxonomy_version, genome->>'angle' as angle from creative_genomes where creative_id = ${c!.id} order by created_at, id`;
    expect(rows).toEqual([
      { source: 'extracted', taxonomy_version: 1, angle: 'MYTH_BUSTING' },
      { source: 'remapped', taxonomy_version: 2, angle: 'MYTH_CORRECTION' },
    ]);
  });
});
