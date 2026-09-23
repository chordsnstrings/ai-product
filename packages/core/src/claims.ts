import type { Tx } from '@arkiv/db';
import { DomainError, RENDERABLE_CLAIM_STATUSES, type ClaimStatus } from '@arkiv/shared';
import { assertCan } from './authz';
import { classifyClaim, type SuggestedStatus } from './compliance';
import type { TenantContext } from './context';
import { actorString } from './context';
import { emit } from './events';

/**
 * ClaimsService (§17, §33). Opus may propose claims; only deterministic rules set the initial status and only
 * an explicit merchant/staff actor with scope can approve (§38: "approval requires explicit actor and scope").
 */

export interface ClaimRow {
  id: string;
  skuId: string;
  canonicalMeaning: string;
  preferredWording: string;
  category: string;
  riskLevel: string;
  status: ClaimStatus;
  mandatoryQualifier: string | null;
  allowedMarkets: string[];
  allowedPlatforms: string[];
  origin: string;
  sourceText: string | null;
  blockReason: string | null;
}

const toClaim = (r: Record<string, unknown>): ClaimRow => ({
  id: r.id as string,
  skuId: r.sku_id as string,
  canonicalMeaning: r.canonical_meaning as string,
  preferredWording: r.preferred_wording as string,
  category: r.claim_category as string,
  riskLevel: r.risk_level as string,
  status: r.status as ClaimStatus,
  mandatoryQualifier: (r.mandatory_qualifier as string) ?? null,
  allowedMarkets: r.allowed_markets as string[],
  allowedPlatforms: r.allowed_platforms as string[],
  origin: r.origin as string,
  sourceText: (r.source_text as string) ?? null,
  blockReason: (r.block_reason as string) ?? null,
});

export async function proposeClaim(
  tx: Tx,
  ctx: TenantContext,
  skuId: string,
  input: { wording: string; meaning?: string; origin: 'extracted' | 'merchant' | 'staff' | 'review_signal'; sourceText?: string | null },
): Promise<ClaimRow> {
  const wording = input.wording.trim();
  if (!wording) throw new DomainError('INVALID', 'Claim wording is required');
  const dup = await tx`select * from claims where sku_id = ${skuId} and lower(preferred_wording) = lower(${wording})`;
  if (dup.length) return toClaim(dup[0]!);
  const cls = classifyClaim(wording);
  // Customer language may inspire hooks but never becomes an efficacy claim (§18, §43 "cured acne" review).
  let status: ClaimStatus = cls.status === 'VERIFIED' || cls.status === 'VERIFIED_WITH_QUALIFIER' ? 'MERCHANT_REVIEW_REQUIRED' : cls.status;
  if (input.origin === 'review_signal' && status !== 'BLOCKED') status = 'INFERRED_ONLY';
  const [r] = await tx`
    insert into claims (workspace_id, sku_id, canonical_meaning, preferred_wording, claim_category, risk_level, status,
      origin, source_text, block_reason, mandatory_qualifier)
    values (${ctx.workspaceId}, ${skuId}, ${input.meaning ?? wording}, ${wording}, ${cls.category}, ${cls.risk}, ${status},
      ${input.origin}, ${input.sourceText ?? null}, ${status === 'BLOCKED' ? cls.matched[0]?.reason ?? null : null},
      ${cls.status === 'VERIFIED_WITH_QUALIFIER' ? 'with regular use' : null})
    returning *`;
  await emit(tx, ctx, 'CLAIM_CREATED', { type: 'claim', id: r!.id as string }, { status, category: cls.category, rules: cls.matched.map((m) => m.ruleId) });
  if (status === 'BLOCKED') await emit(tx, ctx, 'CLAIM_BLOCKED', { type: 'claim', id: r!.id as string }, { reason: r!.block_reason });
  return toClaim(r!);
}

/**
 * Approve a claim for use. Rules can't be overridden by the merchant: BLOCKED stays blocked (§43 "merchant
 * insists"), RESTRICTED needs the staff compliance path, and evidence-level claims need attached evidence.
 */
export async function approveClaim(
  tx: Tx,
  ctx: TenantContext,
  claimId: string,
  scope: { markets: string[]; platforms: string[]; qualifier?: string | null; wording?: string },
): Promise<ClaimRow> {
  const isStaff = ctx.actor.kind === 'staff';
  if (!isStaff) assertCan(ctx, 'claim.approve');
  if (!scope.markets.length || !scope.platforms.length) throw new DomainError('INVALID', 'Choose where this claim may be used');
  const [c] = await tx`select * from claims where id = ${claimId} for update`;
  if (!c) throw new DomainError('NOT_FOUND', 'Claim not found');
  const wording = scope.wording?.trim() || (c.preferred_wording as string);
  const cls = classifyClaim(wording);
  if (c.status === 'BLOCKED' || cls.status === 'BLOCKED')
    throw new DomainError('GATE_BLOCKED', cls.matched[0]?.reason ?? (c.block_reason as string) ?? 'This claim can’t be used.', { alternative: cls.matched[0]?.alternative });
  if ((c.status === 'RESTRICTED' || cls.status === 'RESTRICTED') && !isStaff)
    throw new DomainError('GATE_BLOCKED', 'This claim needs our compliance team’s review before it can be used.', { restricted: true });
  if (c.status === 'INFERRED_ONLY') throw new DomainError('GATE_BLOCKED', 'Customer language can guide ideas but can’t be advertised as a product claim.');
  if (cls.risk === 'high' && !isStaff) {
    const [e] = await tx`select count(*)::int as n from claim_evidence where claim_id = ${claimId}`;
    if (!e!.n) throw new DomainError('GATE_BLOCKED', 'Attach evidence (a study, test report or certificate) before approving this claim.', { needsEvidence: true });
  }
  const qualifier = scope.qualifier?.trim() || (c.mandatory_qualifier as string | null);
  const status: ClaimStatus = qualifier ? 'VERIFIED_WITH_QUALIFIER' : 'VERIFIED';
  const [r] = await tx`
    update claims set status = ${status}, preferred_wording = ${wording}, mandatory_qualifier = ${qualifier ?? null},
      allowed_markets = ${scope.markets}, allowed_platforms = ${scope.platforms}, merchant_approved = ${!isStaff},
      approved_by = ${actorString(ctx)}, reviewed_at = now()
    where id = ${claimId} returning *`;
  await emit(tx, ctx, 'CLAIM_APPROVED', { type: 'claim', id: claimId }, { status, scope });
  return toClaim(r!);
}

export async function blockClaim(tx: Tx, ctx: TenantContext, claimId: string, reason: string) {
  if (ctx.actor.kind !== 'staff') assertCan(ctx, 'claim.approve');
  await tx`update claims set status = 'BLOCKED', block_reason = ${reason}, reviewed_at = now(), approved_by = ${actorString(ctx)} where id = ${claimId}`;
  await emit(tx, ctx, 'CLAIM_BLOCKED', { type: 'claim', id: claimId }, { reason });
}

export async function restrictClaim(tx: Tx, ctx: TenantContext, claimId: string, reason: string) {
  await tx`update claims set status = 'RESTRICTED', block_reason = ${reason}, reviewed_at = now() where id = ${claimId}`;
  await emit(tx, ctx, 'CLAIM_RESTRICTED', { type: 'claim', id: claimId }, { reason });
}

export async function attachEvidence(
  tx: Tx,
  ctx: TenantContext,
  claimId: string,
  e: { type: string; assetId?: string | null; location?: string | null; applicability?: string | null; strength?: 'weak' | 'moderate' | 'strong'; expiry?: string | null },
) {
  if (ctx.actor.kind !== 'staff') assertCan(ctx, 'sku.edit');
  await tx`insert into claim_evidence (workspace_id, claim_id, evidence_type, source_asset_id, source_location, supplied_by,
             applicability, evidence_strength, expiry_date)
           values (${ctx.workspaceId}, ${claimId}, ${e.type}, ${e.assetId ?? null}, ${e.location ?? null}, ${actorString(ctx)},
             ${e.applicability ?? null}, ${e.strength ?? 'moderate'}, ${e.expiry ?? null})`;
  await emit(tx, ctx, 'CLAIM_EVIDENCE_ATTACHED', { type: 'claim', id: claimId }, { type: e.type });
}

export async function listClaims(tx: Tx, skuId: string): Promise<ClaimRow[]> {
  return (await tx`select * from claims where sku_id = ${skuId} order by created_at`).map(toClaim);
}

/** Claims usable in a final render for a platform/market (Launch Gate 3). */
export async function renderableClaims(tx: Tx, skuId: string, platform: string, market = 'US'): Promise<ClaimRow[]> {
  const rows = await tx`select * from claims where sku_id = ${skuId} and status in ${tx(RENDERABLE_CLAIM_STATUSES as string[])}
                        and ${platform} = any(allowed_platforms) and ${market} = any(allowed_markets)`;
  return rows.map(toClaim);
}

/** Evidence expiring within 14 days moves the claim back to review (plan 03 A5). Runs as a daily sweep. */
export async function sweepExpiringEvidence(tx: Tx): Promise<number> {
  const r = await tx`
    update claims c set status = 'MERCHANT_REVIEW_REQUIRED', reviewed_at = now()
    where c.status in ('VERIFIED','VERIFIED_WITH_QUALIFIER')
      and exists (select 1 from claim_evidence e where e.claim_id = c.id and e.expiry_date is not null and e.expiry_date < now() + interval '14 days')
    returning id`;
  return r.count;
}

export type { SuggestedStatus };
