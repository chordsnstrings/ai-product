import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, Taxonomy, type StaffRole } from '@arkiv/shared';
import type { Staff } from './admin';
import { versionCreative } from './creatives';
import { canonicalGenome } from './genome';
import { applyTaxonomyChange, applyTaxonomyRemap, canonicalTaxonomy, proposeTaxonomyChange, reviewTaxonomyProposal, taxonomyRemaps } from './taxonomy';

beforeEach(truncateAll);
// taxonomy_versions is reference data (kept across truncation): drop what a test added.
afterEach(async () => {
  await ownerPool()`delete from taxonomy_versions where version > 1`;
});
afterAll(closeAll);

async function staff(roles: StaffRole[] = ['ENGINEERING']): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, 'Eng', 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: 'Eng', roles };
}

describe('taxonomy changes (plan 05 §19)', () => {
  it('validates changes against the canonical families', async () => {
    const t = await withAdmin((tx) => canonicalTaxonomy(tx));
    expect(t.version).toBe(Taxonomy.version);
    expect(t.families.proof).toContain('TEXTURE_DEMO');
    expect(() => applyTaxonomyChange(t, { family: 'angle', op: 'add', value: 'ROUTINE' })).toThrow(/already/);
    expect(() => applyTaxonomyChange(t, { family: 'angle', op: 'add', value: 'lower case' })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => applyTaxonomyChange(t, { family: 'hook', op: 'rename', value: 'NOPE', to: 'X_Y' })).toThrow(/not an active/);
    expect(() => applyTaxonomyChange(t, { family: 'angle', op: 'deprecate', value: 'OFFER', to: 'OFFER' })).toThrow(/another active/);
    const next = applyTaxonomyChange(t, { family: 'angle', op: 'deprecate', value: 'OFFER', to: 'PRICE_VALUE' });
    expect(next.families.angle).not.toContain('OFFER');
    expect(next.deprecated.angle).toEqual(['OFFER']);
    expect(t.families.angle).toContain('OFFER'); // the input is not mutated
  });

  it('needs a second reviewer; approval records a version and remaps existing genomes across workspaces', async () => {
    const a = await staff();
    const b = await staff(['COMPLIANCE']);
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    const sku1 = await makeSku(t1.workspaceId);
    const sku2 = await makeSku(t2.workspaceId);
    const [e1] = await ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, mode, created_by, genes)
                                   values (${t1.workspaceId}, ${sku1}, 'h', 'angle', 'CONTROLLED', 'test', ${ownerPool().json({ angle: 'MYTH_BUSTING', hookMechanism: 'MYTH', treatment: 'RAW_UGC' })}) returning id`;
    const [c2] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin, genome) values (${t2.workspaceId}, ${sku2}, 'imported', ${ownerPool().json({ angle: 'ROUTINE', secondaryAngle: 'MYTH_BUSTING' })}) returning id`;

    const id = await withAdmin((tx) => proposeTaxonomyChange(tx, a, { family: 'angle', op: 'rename', value: 'MYTH_BUSTING', to: 'MYTH_CORRECTION', reason: 'clearer name for compliance' }));
    await expect(withAdmin((tx) => reviewTaxonomyProposal(tx, a, id, true, 'looks good'))).rejects.toThrow(/second staff member/);
    // Proposed but not reviewed: nothing is canonical yet.
    expect((await withAdmin((tx) => canonicalTaxonomy(tx))).families.angle).toContain('MYTH_BUSTING');

    expect(await withAdmin((tx) => reviewTaxonomyProposal(tx, b, id, true, 'approved in review'))).toEqual({ version: 2, remap: true });
    const tax = await withAdmin((tx) => canonicalTaxonomy(tx));
    expect(tax.version).toBe(2);
    expect(tax.families.angle).toContain('MYTH_CORRECTION');
    expect(tax.families.angle).not.toContain('MYTH_BUSTING');
    const [cmd] = await ownerPool()`select kind, payload from ops_commands`;
    expect(cmd).toMatchObject({ kind: 'taxonomy.remap', payload: { proposalId: id } });
    await expect(withAdmin((tx) => reviewTaxonomyProposal(tx, b, id, true, 'again'))).rejects.toThrow(/Already approved/);

    const counts = await applyTaxonomyRemap(id);
    expect(counts['experiments.genes']).toBe(1);
    expect(counts['creatives.genome']).toBe(1);
    const [e] = await ownerPool()`select genes from experiments where id = ${e1!.id}`;
    expect(e!.genes).toEqual({ angle: 'MYTH_CORRECTION', hookMechanism: 'MYTH', treatment: 'RAW_UGC' }); // the MYTH hook is another family
    const [c] = await ownerPool()`select genome from creatives where id = ${c2!.id}`;
    expect(c!.genome).toEqual({ angle: 'ROUTINE', secondaryAngle: 'MYTH_CORRECTION' });
    const [p] = await ownerPool()`select remap_status from taxonomy_proposals where id = ${id}`;
    expect(p!.remap_status).toBe('done');
    // New genomes from the model follow the remap too.
    const remaps = await withAdmin((tx) => taxonomyRemaps(tx));
    expect(canonicalGenome({ angle: 'MYTH_BUSTING', treatment: 'RAW_UGC' }, remaps)).toEqual({ angle: 'MYTH_CORRECTION', treatment: 'RAW_UGC' });
  });

  it('rejection and a plain addition change no genomes', async () => {
    const a = await staff();
    const b = await staff();
    const rej = await withAdmin((tx) => proposeTaxonomyChange(tx, a, { family: 'treatment', op: 'deprecate', value: 'AI_TALENT', reason: 'policy review' }));
    expect(await withAdmin((tx) => reviewTaxonomyProposal(tx, b, rej, false, 'keep for now'))).toEqual({ version: null, remap: false });
    const add = await withAdmin((tx) => proposeTaxonomyChange(tx, a, { family: 'proof', op: 'add', value: 'DERMATOLOGIST_TESTED_CLAIM', reason: 'new proof type' }));
    expect(await withAdmin((tx) => reviewTaxonomyProposal(tx, b, add, true, 'ok'))).toEqual({ version: 2, remap: false });
    expect((await withAdmin((tx) => canonicalTaxonomy(tx))).families.proof).toContain('DERMATOLOGIST_TESTED_CLAIM');
    expect(await ownerPool()`select 1 from ops_commands`).toHaveLength(0);
    const audit = await ownerPool()`select action from admin_audit_log where action like 'taxonomy.%' order by id`;
    expect(audit.map((x) => x.action)).toEqual(['taxonomy.propose', 'taxonomy.reject', 'taxonomy.propose', 'taxonomy.approve']);
  });

  it('new creatives are recorded against the current canonical version, not a hardcoded one', async () => {
    const t = await makeTenant();
    const skuId = await makeSku(t.workspaceId);
    const [parent] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin, genome, genome_version) values (${t.workspaceId}, ${skuId}, 'generated', '{}', 1) returning id`;
    const ctx = { workspaceId: t.workspaceId, actor: { kind: 'system' as const, id: 'test' } };
    const v = (changed: string) => ({ skuId, parentCreativeId: parent!.id as string, projectId: null, genome: { angle: 'ROUTINE' }, finalAssetIds: [], composition: null, changedVariables: [changed] });
    const first = await withTenant(t.workspaceId, (tx) => versionCreative(tx, ctx, v('hook')));
    expect((await ownerPool()`select genome_version from creatives where id = ${first}`)[0]!.genome_version).toBe(Taxonomy.version);
    const [a, b] = [await staff(), await staff()];
    const add = await withAdmin((tx) => proposeTaxonomyChange(tx, a, { family: 'proof', op: 'add', value: 'PATCH_TEST', reason: 'new proof type' }));
    await withAdmin((tx) => reviewTaxonomyProposal(tx, b, add, true, 'ok'));
    const second = await withTenant(t.workspaceId, (tx) => versionCreative(tx, ctx, v('hook')));
    expect((await ownerPool()`select genome_version from creatives where id = ${second}`)[0]!.genome_version).toBe(2);
  });
});
