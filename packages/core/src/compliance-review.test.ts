import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, type StaffRole } from '@arkiv/shared';
import type { Staff } from './admin';
import { analyzeProduct, startPreview } from './analysis';
import { listClaims, proposeClaim } from './claims';
import { productImagery } from './composite';
import { confirmSkuExclusion, escalateBlockedPattern, keepClaimRestricted, requestClaimEvidence, resolveImpliedFlag, reviewAsset } from './compliance-review';
import { referenceAssetIds } from './sku-variants';
import { ProductExtraction } from './intel-schemas';
import { mockExtraction } from './mock-intel';
import { ingestBytes } from './uploads';
import { holdForReview, nameReviewFlags, usableAssetIds } from './vision';
import { ctxFor, eventContractProblems, productPhoto } from './testing';

/** Plan 05 §14 compliance queues. */
beforeEach(truncateAll);
afterAll(closeAll);

async function staff(roles: StaffRole[] = ['COMPLIANCE']): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, 'Compliance', 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: 'Compliance', roles };
}

async function restricted() {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const skuId = await makeSku(t.workspaceId);
  const c = await withTenant(t.workspaceId, (tx) => proposeClaim(tx, ctx, skuId, { wording: 'Clinically proven to reduce redness', origin: 'merchant' }));
  expect(c.status).toBe('RESTRICTED');
  return { t, ctx, skuId, claimId: c.id };
}

describe('restricted claims queue', () => {
  it('keeps a claim restricted with a note the brand sees, and requests more evidence', async () => {
    const { t, skuId, claimId } = await restricted();
    const s = await staff();
    const other = await makeTenant();
    await expect(withAdmin((tx) => keepClaimRestricted(tx, s, other.workspaceId, claimId, 'wrong tenant'))).rejects.toThrow(/not found/);
    const kept = await withAdmin((tx) => keepClaimRestricted(tx, s, t.workspaceId, claimId, 'The study covers a different formula.'));
    expect(kept).toMatchObject({ claim: 'Clinically proven to reduce redness', skuId });
    await withAdmin((tx) => requestClaimEvidence(tx, s, t.workspaceId, claimId, 'Send the clinical study summary for this formula.'));
    const [c] = await withTenant(t.workspaceId, (tx) => listClaims(tx, skuId));
    expect(c).toMatchObject({ status: 'RESTRICTED', complianceNote: 'Send the clinical study summary for this formula.' });
    const [row] = await ownerPool()`select evidence_requested_at is not null as asked from claims where id = ${claimId}`;
    expect(row!.asked).toBe(true);
    const reviews = await ownerPool()`select verdict from compliance_reviews where subject_id = ${claimId} order by created_at`;
    expect(reviews.map((r) => r.verdict)).toEqual(['keep_restricted', 'request_evidence']);
    expect(await ownerPool()`select 1 from events where type = 'CLAIM_EVIDENCE_REQUESTED' and subject_id = ${claimId}`).toHaveLength(1);
    expect(await eventContractProblems(t.workspaceId)).toEqual([]);
    // The tenant can read decisions about its own content, never write them.
    const mine = await withTenant(t.workspaceId, (tx) => tx`select verdict from compliance_reviews`);
    expect(mine).toHaveLength(2);
    expect(await withTenant(other.workspaceId, (tx) => tx`select 1 from compliance_reviews`)).toHaveLength(0);
    await expect(withTenant(t.workspaceId, (tx) => tx`insert into compliance_reviews (workspace_id, kind, subject_type, subject_id, verdict, staff_id) values (${t.workspaceId}, 'claim_review', 'claim', ${claimId}, 'x', ${s.staffId})`)).rejects.toThrow();
    // Only restricted claims are in this queue.
    await ownerPool()`update claims set status = 'VERIFIED' where id = ${claimId}`;
    await expect(withAdmin((tx) => keepClaimRestricted(tx, s, t.workspaceId, claimId, 'x'))).rejects.toThrow(/no longer waiting/);
    const analyst = await staff(['ANALYST']);
    await expect(withAdmin((tx) => requestClaimEvidence(tx, analyst, t.workspaceId, claimId, 'x'))).rejects.toThrow(/role/);
  });
});

describe('implied-claim flags, blocked patterns and drug/OTC hits', () => {
  it('resolves an implied-claim flag once', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const pid = newId();
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, qa_report) values (${pid}, ${t.workspaceId}, ${sku}, 'taste', 'COMPLETE', 'test', ${ownerPool().json({ impliedClaims: [{ text: 'erases acne', reason: 'treats a condition' }] })})`;
    const s = await staff();
    await withAdmin((tx) => resolveImpliedFlag(tx, s, t.workspaceId, pid, 'dismissed', 'refers to makeup removal'));
    await expect(withAdmin((tx) => resolveImpliedFlag(tx, s, t.workspaceId, pid, 'confirmed', 'again'))).rejects.toThrow(/Already resolved/);
    expect(await ownerPool()`select action from admin_audit_log where action = 'implied_flag.dismissed'`).toHaveLength(1);
  });

  it('escalates a repeated blocked-claim pattern once a month, with a note for support', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    const s = await staff();
    await withTenant(t.workspaceId, (tx) => proposeClaim(tx, ctx, skuId, { wording: 'Cures acne overnight', origin: 'merchant' }));
    await expect(withAdmin((tx) => escalateBlockedPattern(tx, s, t.workspaceId, 'pattern'))).rejects.toThrow(/fewer than 3/);
    for (const w of ['Heals eczema', 'Boosts collagen production']) await withTenant(t.workspaceId, (tx) => proposeClaim(tx, ctx, skuId, { wording: w, origin: 'merchant' }));
    const r = await withAdmin((tx) => escalateBlockedPattern(tx, s, t.workspaceId, 'three drug claims this month'));
    expect(r.blocked).toBe(3);
    expect(r.examples).toHaveLength(3);
    expect(await ownerPool()`select body from tenant_notes where workspace_id = ${t.workspaceId}`).toEqual([{ body: expect.stringMatching(/repeated blocked claims \(3 in 30 days\)/) }]);
    await expect(withAdmin((tx) => escalateBlockedPattern(tx, s, t.workspaceId, 'again'))).rejects.toThrow(/Already escalated/);
  });

  it('confirms a drug/OTC exclusion for a rejected SKU only, once', async () => {
    const t = await makeTenant();
    const skuId = await makeSku(t.workspaceId, 'Daily SPF 50');
    const s = await staff();
    await expect(withAdmin((tx) => confirmSkuExclusion(tx, s, t.workspaceId, skuId, 'sunscreen'))).rejects.toThrow(/Only a rejected SKU/);
    await ownerPool()`update skus set status = 'rejected', reject_reason = 'Sunscreens are OTC drugs' where id = ${skuId}`;
    const r = await withAdmin((tx) => confirmSkuExclusion(tx, s, t.workspaceId, skuId, 'SPF is an OTC drug claim'));
    expect(r).toEqual({ productName: 'Daily SPF 50', reason: 'Sunscreens are OTC drugs' });
    await expect(withAdmin((tx) => confirmSkuExclusion(tx, s, t.workspaceId, skuId, 'again'))).rejects.toThrow(/already confirmed/);
  });
});

describe('before/after and possible minors (standard §48)', () => {
  it('flags by name, holds media for review and keeps held or rejected media out of production inputs', async () => {
    expect(nameReviewFlags('serum-before-after.jpg')).toEqual({ beforeAfter: true, possibleMinor: false });
    expect(nameReviewFlags('{"filename":"Before & After week 4.png"}').beforeAfter).toBe(true);
    expect(nameReviewFlags('kids_bathtime.mp4').possibleMinor).toBe(true);
    expect(nameReviewFlags('front-label.jpg')).toEqual({ beforeAfter: false, possibleMinor: false });
    // The product analyst's own look (extract-product@1.1.0 imageReview; mock hook shown).
    expect(mockExtraction({ text: 'Serum [[review:minor]]' }).imageReview).toEqual([{ index: 0, beforeAfter: false, possibleMinor: true }]);
    expect(ProductExtraction.parse(mockExtraction({ text: 'Serum' })).imageReview).toEqual([]);

    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const photo = await productPhoto();
    const flagged = await withTenant(t.workspaceId, (tx) => ingestBytes(tx, ctx, photo, 'product_photo', null, { filename: 'glow-before-after.jpg' }));
    const plain = await withTenant(t.workspaceId, (tx) => ingestBytes(tx, ctx, photo, 'product_photo', null, { filename: 'glow-front.jpg' }));
    const [a] = await ownerPool()`select review_status, review_flags from assets where id = ${flagged.id}`;
    expect(a).toMatchObject({ review_status: 'pending', review_flags: { beforeAfter: true, sources: ['name'] } });
    expect(await withTenant(t.workspaceId, (tx) => usableAssetIds(tx, [flagged.id, plain.id]))).toEqual([plain.id]);
    // A decision is final for the hold: re-flagging doesn't reopen it.
    const s = await staff();
    await withAdmin((tx) => reviewAsset(tx, s, t.workspaceId, flagged.id, 'rejected', 'before/after comparison'));
    expect(await withTenant(t.workspaceId, (tx) => holdForReview(tx, [{ assetId: flagged.id, flags: { beforeAfter: true, possibleMinor: false, sources: ['name'] } }]))).toEqual([]);
    await expect(withAdmin((tx) => reviewAsset(tx, s, t.workspaceId, flagged.id, 'approved', 'changed my mind'))).rejects.toThrow(/isn’t waiting/);

    // Fingerprint references and frames never use rejected media.
    const skuId = await makeSku(t.workspaceId);
    await ownerPool()`insert into visual_fingerprints (workspace_id, sku_id, version, reference_asset_ids, active) values (${t.workspaceId}, ${skuId}, 1, ${[flagged.id, plain.id]}, true)`;
    expect(await withTenant(t.workspaceId, (tx) => referenceAssetIds(tx, skuId, null))).toEqual([plain.id]);
    expect((await withTenant(t.workspaceId, (tx) => productImagery(tx, skuId))).reference?.assetId).toBe(plain.id);
  });

  it('the analysis holds photos the analyst flags and builds the fingerprint from the rest', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const photo = await productPhoto();
    const first = await withTenant(t.workspaceId, (tx) => ingestBytes(tx, ctx, photo, 'product_photo', null));
    const photo2 = await productPhoto('GLOW SERUM', '#B0907A');
    const second = await withTenant(t.workspaceId, (tx) => ingestBytes(tx, ctx, photo2, 'product_photo', null));
    // The first photo's source names it a before/after (the analyst's own look is the other path).
    await ownerPool()`update assets set origin = ${ownerPool().json({ caption: 'week 4 before_after' })} where id = ${first.id}`;
    const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [first.id, second.id] }));
    const r = await analyzeProduct(ctx, skuId, projectId);
    expect(r.status).toBe('ready');
    const [fp] = await ownerPool()`select reference_asset_ids, cutout_asset_id from visual_fingerprints where sku_id = ${skuId} and active`;
    const [held] = await ownerPool()`select review_status from assets where id = ${first.id}`;
    expect(held!.review_status).toBe('pending');
    expect(fp!.reference_asset_ids).toEqual([second.id]);
    const [cut] = await ownerPool()`select lineage->>'from' as src from assets where id = ${fp!.cutout_asset_id}`;
    expect(cut!.src).toBe(second.id);
  }, 60_000);
});
