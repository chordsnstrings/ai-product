import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { approveClaim, attachEvidence, INGREDIENT_EVIDENCE_REASON, proposeClaim } from './claims';
import type { TenantContext } from './context';
import { ctxFor } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

async function setup(wording: string) {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const skuId = await makeSku(t.workspaceId);
  const c = await withTenant(t.workspaceId, (tx) => proposeClaim(tx, ctx, skuId, { wording, origin: 'merchant' }));
  const staff: TenantContext = { workspaceId: t.workspaceId, workspaceState: 'ACTIVE_PAID', role: 'OWNER', actor: { kind: 'staff', id: newId() }, requestId: newId() };
  return { t, ctx, staff, claimId: c.id };
}

const scope = { markets: ['US'], platforms: ['TIKTOK'] };

describe('claim approval needs qualifying evidence (§43)', () => {
  it('a merchant assertion (no file, no link) keeps an expert claim pending', async () => {
    const { t, ctx, claimId } = await setup('Dermatologist tested');
    await withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'other', location: 'Our derm said so', applicability: 'product_specific', wording: 'Dermatologist tested' }));
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, scope))).rejects.toMatchObject({ code: 'GATE_BLOCKED', details: { needsEvidence: true } });
    const [c] = await ownerPool()`select status from claims where id = ${claimId}`;
    expect(c!.status).toBe('MERCHANT_REVIEW_REQUIRED');
  });

  it('an expert endorsement needs its exact wording on the evidence', async () => {
    const { t, ctx, claimId } = await setup('Dermatologist tested');
    await withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'lab_test', location: 'https://lab.example/report.pdf', applicability: 'product_specific' }));
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, scope))).rejects.toThrow(/exact wording/);
    await withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'lab_test', location: 'https://lab.example/report.pdf', applicability: 'product_specific', wording: 'Dermatologist recommended' }));
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, scope))).rejects.toThrow(/exact wording/);
    await withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'lab_test', location: 'https://lab.example/report.pdf', applicability: 'product_specific', wording: '“Dermatologist tested.”' }));
    const ok = await withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, scope));
    expect(ok.status).toBe('VERIFIED');
    const [ev] = await ownerPool()`select payload from events where subject_id = ${claimId} and type = 'CLAIM_APPROVED'`;
    expect((ev!.payload as { evidenceIds: string[] }).evidenceIds).toHaveLength(1);
  });

  it('other-formula, ingredient-spec, weak and expired evidence do not verify a clinical or quantified claim', async () => {
    const { t, ctx, claimId } = await setup('92% of users saw smoother skin');
    const link = 'https://lab.example/study.pdf';
    await withTenant(t.workspaceId, async (tx) => {
      await attachEvidence(tx, ctx, claimId, { type: 'clinical_study', location: link, applicability: 'other_formulation' });
      await attachEvidence(tx, ctx, claimId, { type: 'consumer_perception', location: link, applicability: 'product_specific', strength: 'weak' });
      await attachEvidence(tx, ctx, claimId, { type: 'ingredient_spec', location: link, applicability: 'product_specific' });
      await attachEvidence(tx, ctx, claimId, { type: 'clinical_study', location: link, applicability: 'product_specific', expiry: '2020-01-01' });
    });
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, scope))).rejects.toThrow(/expired|about this product/);
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, scope))).rejects.toThrow(/weak evidence/);
    await withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'consumer_perception', location: link, applicability: 'product_specific' }));
    expect((await withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, { ...scope, qualifier: 'in a 4-week consumer study of 32 women' }))).status).toBe('VERIFIED_WITH_QUALIFIER');
  });

  it('ingredient-level evidence for a high-risk claim goes to our compliance team, never transferred automatically', async () => {
    const { t, ctx, claimId } = await setup('92% of users saw smoother skin');
    await withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'clinical_study', location: 'https://lab.example/niacinamide.pdf', applicability: 'ingredient_level', strength: 'strong' }));
    const [c] = await ownerPool()`select status, block_reason from claims where id = ${claimId}`;
    expect(c).toMatchObject({ status: 'RESTRICTED', block_reason: INGREDIENT_EVIDENCE_REASON });
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, scope))).rejects.toMatchObject({ code: 'GATE_BLOCKED', details: { restricted: true } });
    expect(await ownerPool()`select 1 from events where subject_id = ${claimId} and type = 'CLAIM_RESTRICTED'`).toHaveLength(1);
  });

  it('ingredient-level evidence on a low-risk claim leaves it with the merchant', async () => {
    const { t, ctx, claimId } = await setup('Skin feels soft');
    await withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'lab_test', location: 'https://lab.example/a.pdf', applicability: 'ingredient_level' }));
    const [c] = await ownerPool()`select status from claims where id = ${claimId}`;
    expect(c!.status).toBe('MERCHANT_REVIEW_REQUIRED');
  });

  it('refuses an unknown applicability', async () => {
    const { t, ctx, claimId } = await setup('Clinically tested');
    await expect(withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'lab_test', location: 'https://x.example/a.pdf', applicability: 'whatever' as never }))).rejects.toMatchObject({ code: 'INVALID' });
  });
});

describe('staff approvals of RESTRICTED claims (§43 "Clinically tested ingredient")', () => {
  it('need qualifying evidence too, or an explicit override reason; the evidence relied on is recorded', async () => {
    const { t, ctx, staff, claimId } = await setup('Clinically proven to smooth skin');
    const [c0] = await ownerPool()`select status from claims where id = ${claimId}`;
    expect(c0!.status).toBe('RESTRICTED');
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, staff, claimId, scope))).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    // Ingredient evidence does not transfer.
    await withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'clinical_study', location: 'https://x.example/niacinamide.pdf', applicability: 'ingredient_level' }));
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, staff, claimId, scope))).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    // Only the named evidence counts when ids are given.
    await withTenant(t.workspaceId, (tx) => attachEvidence(tx, ctx, claimId, { type: 'clinical_study', location: 'https://x.example/product.pdf', applicability: 'product_specific' }));
    const ids = await ownerPool()`select id, applicability from claim_evidence where claim_id = ${claimId}`;
    const ingredient = ids.find((e) => e.applicability === 'ingredient_level')!.id as string;
    const product = ids.find((e) => e.applicability === 'product_specific')!.id as string;
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, staff, claimId, { ...scope, evidenceIds: [ingredient] }))).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    await withTenant(t.workspaceId, (tx) => approveClaim(tx, staff, claimId, { ...scope, evidenceIds: [product] }));
    const [ev] = await ownerPool()`select payload from events where subject_id = ${claimId} and type = 'CLAIM_APPROVED'`;
    expect(ev!.payload).toMatchObject({ evidenceIds: [product] });
  });

  it('an override approves without evidence and says so on the event; merchants cannot override', async () => {
    const { t, ctx, staff, claimId } = await setup('Clinically proven to smooth skin');
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, { ...scope, overrideReason: 'trust me' }))).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    await withTenant(t.workspaceId, (tx) => approveClaim(tx, staff, claimId, { ...scope, overrideReason: 'Study reviewed offline by counsel' }));
    const [ev] = await ownerPool()`select payload from events where subject_id = ${claimId} and type = 'CLAIM_APPROVED'`;
    expect(ev!.payload).toMatchObject({ evidenceIds: [], evidenceOverride: 'Study reviewed offline by counsel' });
  });
});

describe('compliant alternatives (§43 "Merchant insists on blocked claim")', () => {
  it('a blocked or restricted claim keeps the alternative the rules propose; a reviewable one has none', async () => {
    const { t, ctx, claimId } = await setup('Cures acne overnight');
    const [c] = await ownerPool()`select status, sku_id, suggested_alternative from claims where id = ${claimId}`;
    expect(c!.status).toBe('BLOCKED');
    expect(c!.suggested_alternative).toMatch(/looks clearer/);
    const restricted = await withTenant(t.workspaceId, (tx) => proposeClaim(tx, ctx, c!.sku_id as string, { wording: 'Great for rosacea', origin: 'merchant' }));
    expect(restricted).toMatchObject({ status: 'RESTRICTED', suggestedAlternative: expect.stringMatching(/appearance/) });
    const fine = await withTenant(t.workspaceId, (tx) => proposeClaim(tx, ctx, c!.sku_id as string, { wording: 'Skin feels soft', origin: 'merchant' }));
    expect(fine.suggestedAlternative).toBeNull();
  });

  it('approving a blocked wording is refused with the alternative in the error details', async () => {
    const { t, ctx, claimId } = await setup('Removes wrinkles');
    await expect(withTenant(t.workspaceId, (tx) => approveClaim(tx, ctx, claimId, scope))).rejects.toMatchObject({ code: 'GATE_BLOCKED', details: { alternative: expect.stringMatching(/reduces the look of fine lines/) } });
  });
});
