import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, type StaffRole } from '@arkiv/shared';
import { startBreakGlass, type Staff } from './admin';
import { saveAsset } from './assets';
import { requestSkuTransfer, transferSku } from './sku-transfer';
import { storage } from './storage';

async function staff(roles: StaffRole[]): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, 'Ops', 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: 'Ops', roles };
}

beforeEach(truncateAll);
afterAll(closeAll);

/** A SKU with the whole product-truth subtree: superseding facts, claims with evidence files, a fingerprint. */
async function richSku(workspaceId: string) {
  const sku = await makeSku(workspaceId, 'Dew Serum');
  return withTenant(workspaceId, async (tx) => {
    const photo = await saveAsset(tx, workspaceId, { bytes: Buffer.from('photo-bytes'), mime: 'application/pdf', kind: 'product_photo', source: 'upload', skuId: sku });
    const cutout = await saveAsset(tx, workspaceId, { bytes: Buffer.from('cutout-bytes'), mime: 'application/pdf', kind: 'cutout', source: 'generated', skuId: sku });
    const doc = await saveAsset(tx, workspaceId, { bytes: Buffer.from('clinical-study'), mime: 'application/pdf', kind: 'evidence_doc', source: 'upload' });
    const [f1] = await tx`insert into product_facts (workspace_id, sku_id, fact_type, normalized_key, value_text, source_type, state, status, created_by)
                          values (${workspaceId}, ${sku}, 'size', 'size_ml', '50', 'product_page', 'OBSERVED', 'SUPERSEDED', 'system') returning id`;
    await tx`insert into product_facts (workspace_id, sku_id, fact_type, normalized_key, value_text, source_type, state, supersedes_fact_id, created_by)
             values (${workspaceId}, ${sku}, 'size', 'size_ml', '30', 'merchant', 'DECIDED', ${f1!.id}, 'user:x')`;
    const [c] = await tx`insert into claims (workspace_id, sku_id, canonical_meaning, preferred_wording, claim_category, risk_level, status, origin)
                         values (${workspaceId}, ${sku}, 'hydrates', 'Hydrates for 24 hours', 'cosmetic', 'medium', 'VERIFIED', 'merchant') returning id`;
    await tx`insert into claim_evidence (workspace_id, claim_id, evidence_type, source_asset_id, supplied_by) values (${workspaceId}, ${c!.id}, 'clinical_study', ${doc.id}, 'user:x')`;
    await tx`insert into visual_fingerprints (workspace_id, sku_id, version, reference_asset_ids, cutout_asset_id, label_text)
             values (${workspaceId}, ${sku}, 1, ${[photo.id]}, ${cutout.id}, 'DEW SERUM 30 ml')`;
    return { sku, photo: photo.id, cutout: cutout.id, doc: doc.id, claim: c!.id as string };
  });
}

describe('Transfer SKU to workspace (plan 05 §2.3)', () => {
  it('copies the SKU subtree and its files with new ids, rewrites references, archives the original, and audits both sides', async () => {
    const from = await makeTenant({ state: 'ACTIVE_PAID' });
    const to = await makeTenant();
    await makeSku(to.workspaceId, 'Existing product'); // target catalogue already has No. 001
    const src = await richSku(from.workspaceId);
    const ops = await staff(['OPS']);
    const req = { fromWorkspaceId: from.workspaceId, skuId: src.sku, toWorkspaceId: to.workspaceId, consentRef: 'Ticket #77: owner email 12 Sep', reason: 'Owner consolidating brands' };

    await expect(requestSkuTransfer(await staff(['SUPPORT']), req)).rejects.toThrow(/role/);
    await expect(requestSkuTransfer(ops, req)).rejects.toThrow(/break-glass/);
    await startBreakGlass(ops, from.workspaceId, { reasonKind: 'ticket', ticket: '77', reason: 'Owner asked to move a SKU', write: true, writeReason: 'Moving the SKU for them' });
    await expect(requestSkuTransfer(ops, { ...req, toWorkspaceId: from.workspaceId })).rejects.toThrow(/different target/);
    await expect(requestSkuTransfer(ops, { ...req, consentRef: '' })).rejects.toThrow(/consent/);
    const { transferId } = await requestSkuTransfer(ops, req);
    await expect(requestSkuTransfer(ops, req)).rejects.toThrow(/already queued/);
    const [job] = await ownerPool()`select workspace_id, queue, payload from outbox where queue = 'transfer-sku'`;
    expect(job).toMatchObject({ workspace_id: from.workspaceId, payload: { transferId } });

    const r = await transferSku(transferId);
    expect(r.status).toBe('completed');
    expect(r.counts).toEqual({ skus: 1, assets: 3, product_facts: 2, visual_fingerprints: 1, claims: 1, claim_evidence: 1 });
    const newSku = r.newSkuId!;
    expect(newSku).not.toBe(src.sku);

    const [copy] = await ownerPool()`select workspace_id, catalogue_no, name, brand_id, status from skus where id = ${newSku}`;
    expect(copy).toMatchObject({ workspace_id: to.workspaceId, catalogue_no: 2, name: 'Dew Serum', brand_id: to.brandId, status: 'active' });
    const [orig] = await ownerPool()`select status from skus where id = ${src.sku}`;
    expect(orig!.status).toBe('archived');

    // Facts: new ids, the supersede link points at the copied fact.
    const facts = await ownerPool()`select id, value_text, supersedes_fact_id, status from product_facts where sku_id = ${newSku} order by value_text`;
    expect(facts.map((f) => f.value_text)).toEqual(['30', '50']);
    expect(facts[0]!.supersedes_fact_id).toBe(facts[1]!.id);
    // Assets: new ids and keys under the target's prefix, same bytes.
    const assets = await ownerPool()`select id, kind, sku_id, storage_key from assets where workspace_id = ${to.workspaceId} order by kind`;
    expect(assets.map((a) => a.kind)).toEqual(['cutout', 'evidence_doc', 'product_photo']);
    expect(assets.every((a) => String(a.storage_key).startsWith(`t/${to.workspaceId}/transfer/${transferId}/`))).toBe(true);
    expect(assets.find((a) => a.kind === 'evidence_doc')!.sku_id).toBeNull();
    for (const a of assets) expect([src.photo, src.cutout, src.doc]).not.toContain(a.id);
    const byKind = Object.fromEntries(assets.map((a) => [a.kind as string, a]));
    expect((await storage().get(byKind.evidence_doc!.storage_key as string)).toString()).toBe('clinical-study');
    // Claims + evidence and the fingerprint reference the copies, never the source rows.
    const [claim] = await ownerPool()`select id, preferred_wording from claims where sku_id = ${newSku}`;
    expect(claim!.id).not.toBe(src.claim);
    const [ev] = await ownerPool()`select claim_id, source_asset_id, workspace_id from claim_evidence where claim_id = ${claim!.id}`;
    expect(ev).toEqual({ claim_id: claim!.id, source_asset_id: byKind.evidence_doc!.id, workspace_id: to.workspaceId });
    const [fp] = await ownerPool()`select reference_asset_ids, cutout_asset_id, label_text from visual_fingerprints where sku_id = ${newSku}`;
    expect(fp).toEqual({ reference_asset_ids: [byKind.product_photo!.id], cutout_asset_id: byKind.cutout!.id, label_text: 'DEW SERUM 30 ml' });
    // The source keeps its rows (archived) — nothing was moved out from under its history.
    expect(await ownerPool()`select 1 from claims where sku_id = ${src.sku}`).toHaveLength(1);

    const ev2 = await ownerPool()`select workspace_id, payload->>'direction' as dir from events where type = 'SKU_TRANSFERRED' order by dir`;
    expect(ev2).toEqual([{ workspace_id: to.workspaceId, dir: 'in' }, { workspace_id: from.workspaceId, dir: 'out' }]);
    // Neither tenant's event names the other tenant's workspace or rows.
    const [outEv] = await ownerPool()`select payload from events where type = 'SKU_TRANSFERRED' and workspace_id = ${from.workspaceId}`;
    const [inEv] = await ownerPool()`select payload from events where type = 'SKU_TRANSFERRED' and workspace_id = ${to.workspaceId}`;
    expect(JSON.stringify(outEv!.payload)).not.toContain(to.workspaceId);
    expect(JSON.stringify(outEv!.payload)).not.toContain(newSku);
    expect(JSON.stringify(inEv!.payload)).not.toContain(from.workspaceId);
    expect(JSON.stringify(inEv!.payload)).not.toContain(src.sku);
    const audits = await ownerPool()`select action, workspace_id from admin_audit_log where action like 'tenant.sku_transfer%' order by id`;
    expect(audits.map((a) => a.action)).toEqual(['tenant.sku_transfer_requested', 'tenant.sku_transfer_requested', 'tenant.sku_transfer_completed', 'tenant.sku_transfer_completed']);
    expect(new Set(audits.map((a) => a.workspace_id))).toEqual(new Set([from.workspaceId, to.workspaceId]));
    const [t] = await ownerPool()`select status, new_sku_id from sku_transfers where id = ${transferId}`;
    expect(t).toEqual({ status: 'completed', new_sku_id: newSku });
    // A redelivered job does nothing.
    expect((await transferSku(transferId)).status).toBe('skipped');
    expect(await ownerPool()`select 1 from skus where workspace_id = ${to.workspaceId} and name = 'Dew Serum'`).toHaveLength(1);
    // The target tenant sees the copy through RLS; the source sees none of the target's rows.
    expect(await withTenant(to.workspaceId, (tx) => tx`select id from claims`)).toHaveLength(1);
    expect(await withTenant(from.workspaceId, (tx) => tx`select id from assets where workspace_id = ${to.workspaceId}`)).toHaveLength(0);
  });

  it('fails cleanly when the target is no longer live, and refuses archived SKUs', async () => {
    const from = await makeTenant();
    const to = await makeTenant();
    const src = await richSku(from.workspaceId);
    const ops = await staff(['OPS']);
    await startBreakGlass(ops, from.workspaceId, { reasonKind: 'ticket', ticket: '9', reason: 'Owner asked to move a SKU', write: true, writeReason: 'Moving the SKU for them' });
    const { transferId } = await requestSkuTransfer(ops, { fromWorkspaceId: from.workspaceId, skuId: src.sku, toWorkspaceId: to.workspaceId, consentRef: 'Ticket #9', reason: 'consolidating' });
    await ownerPool()`update workspaces set state = 'SUSPENDED' where id = ${to.workspaceId}`;
    const r = await transferSku(transferId);
    expect(r).toMatchObject({ status: 'failed' });
    const [t] = await ownerPool()`select status, error from sku_transfers where id = ${transferId}`;
    expect(t!.status).toBe('failed');
    expect(await ownerPool()`select 1 from skus where workspace_id = ${to.workspaceId}`).toHaveLength(0);
    const [orig] = await ownerPool()`select status from skus where id = ${src.sku}`;
    expect(orig!.status).toBe('active');
    await ownerPool()`update workspaces set state = 'ACTIVE_FREE' where id = ${to.workspaceId}`;
    await ownerPool()`update skus set status = 'archived' where id = ${src.sku}`;
    await expect(requestSkuTransfer(ops, { fromWorkspaceId: from.workspaceId, skuId: src.sku, toWorkspaceId: to.workspaceId, consentRef: 'Ticket #9', reason: 'again' })).rejects.toThrow(/Archived/);
  });
});
