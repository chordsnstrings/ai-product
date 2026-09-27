import type { Tx } from '@arkiv/db';
import { DomainError, newId } from '@arkiv/shared';
import { assertStaff, audit, type Staff } from './admin';
import type { TenantContext } from './context';
import { withClaimChange } from './claims';
import { emit } from './events';
import { attestationOf } from './vision';

/**
 * Compliance review queues (plan 05 §14): staff decisions on restricted claims, implied-claim flags, repeated
 * blocked-claim attempts, drug/OTC detector hits and before/after or possible-minor media. Every decision is a
 * compliance_reviews row (the tenant can read decisions about its own content) plus an audit entry; the console
 * sends the tenant email. Admin role: every query names the workspace explicitly.
 */

export type ComplianceKind = 'implied_claim' | 'asset_review' | 'sku_exclusion' | 'blocked_pattern' | 'claim_review';

async function record(tx: Tx, s: Staff, workspaceId: string, kind: ComplianceKind, subject: { type: string; id: string }, verdict: string, note: string | null) {
  const [r] = await tx`insert into compliance_reviews (workspace_id, kind, subject_type, subject_id, verdict, note, staff_id)
                       values (${workspaceId}, ${kind}, ${subject.type}, ${subject.id}, ${verdict}, ${note}, ${s.staffId}) returning id`;
  return r!.id as string;
}

const staffCtx = (s: Staff, workspaceId: string): TenantContext => ({ workspaceId, workspaceState: 'ACTIVE_PAID', role: 'OWNER', actor: { kind: 'staff', id: s.staffId }, requestId: newId() });

async function restrictedClaim(tx: Tx, workspaceId: string, claimId: string) {
  const [c] = await tx`select c.id, c.status, c.preferred_wording, c.sku_id, c.compliance_note, s.name as sku_name from claims c join skus s on s.id = c.sku_id and s.workspace_id = c.workspace_id
                       where c.id = ${claimId} and c.workspace_id = ${workspaceId} for update of c`;
  if (!c) throw new DomainError('NOT_FOUND', 'Claim not found in this workspace');
  if (c.status !== 'RESTRICTED') throw new DomainError('CONFLICT', 'This claim is no longer waiting for compliance review.');
  return c;
}

/** "Keep restricted": the claim stays out of ads; staff's reason is stored on it and shown to the brand. */
export async function keepClaimRestricted(tx: Tx, s: Staff, workspaceId: string, claimId: string, note: string) {
  assertStaff(s, 'claims.review');
  const c = await restrictedClaim(tx, workspaceId, claimId);
  await withClaimChange(tx, { kind: 'kept_restricted', actor: `staff:${s.staffId}`, reason: note }, () =>
    tx`update claims set compliance_note = ${note}, reviewed_at = now(), approved_by = ${`staff:${s.staffId}`} where id = ${claimId} and workspace_id = ${workspaceId}`,
  );
  await emit(tx, staffCtx(s, workspaceId), 'CLAIM_RESTRICTED', { type: 'claim', id: claimId }, { reason: note }, { skuId: c.sku_id as string });
  await record(tx, s, workspaceId, 'claim_review', { type: 'claim', id: claimId }, 'keep_restricted', note);
  await audit(tx, s, 'claim.keep_restricted', { type: 'claim', id: claimId }, { workspaceId, reason: note, before: { compliance_note: c.compliance_note }, after: { status: 'RESTRICTED', compliance_note: note } });
  return { claim: c.preferred_wording as string, skuId: c.sku_id as string, productName: c.sku_name as string };
}

/** "Request more evidence": the claim stays restricted and the brand is asked (by email) for support. */
export async function requestClaimEvidence(tx: Tx, s: Staff, workspaceId: string, claimId: string, note: string) {
  assertStaff(s, 'claims.review');
  const c = await restrictedClaim(tx, workspaceId, claimId);
  await withClaimChange(tx, { kind: 'evidence_requested', actor: `staff:${s.staffId}`, reason: note }, () =>
    tx`update claims set compliance_note = ${note}, evidence_requested_at = now() where id = ${claimId} and workspace_id = ${workspaceId}`,
  );
  await emit(tx, staffCtx(s, workspaceId), 'CLAIM_EVIDENCE_REQUESTED', { type: 'claim', id: claimId }, { note }, { skuId: c.sku_id as string });
  await record(tx, s, workspaceId, 'claim_review', { type: 'claim', id: claimId }, 'request_evidence', note);
  await audit(tx, s, 'claim.request_evidence', { type: 'claim', id: claimId }, { workspaceId, reason: note, after: { evidence_requested: true } });
  return { claim: c.preferred_wording as string, skuId: c.sku_id as string, productName: c.sku_name as string };
}

/**
 * Resolve a whole-creative implied-claim flag (§43): `confirmed` (the creative does imply a medical/drug outcome —
 * it must not run; staff follow up) or `dismissed` (a false positive). The verdict joins the project's history.
 */
export async function resolveImpliedFlag(tx: Tx, s: Staff, workspaceId: string, projectId: string, verdict: 'confirmed' | 'dismissed', note: string) {
  assertStaff(s, 'claims.review');
  const [p] = await tx`select id, qa_report->'impliedClaims' as flags from projects where id = ${projectId} and workspace_id = ${workspaceId}`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found in this workspace');
  if (!Array.isArray(p.flags) || !p.flags.length) throw new DomainError('CONFLICT', 'This project has no implied-claim flags.');
  const [done] = await tx`select 1 from compliance_reviews where workspace_id = ${workspaceId} and kind = 'implied_claim' and subject_id = ${projectId}`;
  if (done) throw new DomainError('CONFLICT', 'Already resolved.');
  await record(tx, s, workspaceId, 'implied_claim', { type: 'project', id: projectId }, verdict, note);
  await audit(tx, s, `implied_flag.${verdict}`, { type: 'project', id: projectId }, { workspaceId, reason: note, after: { verdict, flags: p.flags } });
}

/** Blocked claims a workspace added in the last 30 days (merchant-made), newest first. */
export async function recentBlockedClaims(tx: Tx, workspaceId: string) {
  return tx`select preferred_wording, block_reason, created_at from claims where workspace_id = ${workspaceId} and status = 'BLOCKED' and origin = 'merchant'
            and created_at > now() - interval '30 days' order by created_at desc limit 20`;
}

/**
 * Escalate a repeated blocked-claim pattern (§14 "education, not punishment; a repeated pattern escalates"): the
 * escalation is recorded (tenant note for the support team, compliance review row); the console emails guidance.
 * Once per 30 days per workspace.
 */
export async function escalateBlockedPattern(tx: Tx, s: Staff, workspaceId: string, note: string) {
  assertStaff(s, 'claims.review');
  const blocked = await recentBlockedClaims(tx, workspaceId);
  if (blocked.length < 3) throw new DomainError('CONFLICT', 'No repeated pattern: fewer than 3 blocked claims in 30 days.');
  const [recent] = await tx`select 1 from compliance_reviews where workspace_id = ${workspaceId} and kind = 'blocked_pattern' and created_at > now() - interval '30 days'`;
  if (recent) throw new DomainError('CONFLICT', 'Already escalated in the last 30 days.');
  await record(tx, s, workspaceId, 'blocked_pattern', { type: 'workspace', id: workspaceId }, 'escalated', note);
  await tx`insert into tenant_notes (workspace_id, staff_id, body) values (${workspaceId}, ${s.staffId}, ${`Compliance: repeated blocked claims (${blocked.length} in 30 days) — guidance sent. ${note}`.slice(0, 4000)})`;
  await audit(tx, s, 'blocked_pattern.escalate', { type: 'workspace', id: workspaceId }, { workspaceId, reason: note, after: { blocked: blocked.length } });
  return { blocked: blocked.length, examples: blocked.slice(0, 3).map((b) => b.preferred_wording as string) };
}

/**
 * Confirm a drug/OTC detector hit (§1 exclusions): the SKU stays rejected for good (a re-analysis can't reopen it)
 * and the owner is told it is outside V1 scope.
 */
export async function confirmSkuExclusion(tx: Tx, s: Staff, workspaceId: string, skuId: string, note: string) {
  assertStaff(s, 'claims.review');
  const [sku] = await tx`select id, name, status, reject_reason, exclusion_confirmed_at from skus where id = ${skuId} and workspace_id = ${workspaceId} for update`;
  if (!sku) throw new DomainError('NOT_FOUND', 'SKU not found in this workspace');
  if (sku.status !== 'rejected') throw new DomainError('CONFLICT', 'Only a rejected SKU can have its exclusion confirmed.');
  if (sku.exclusion_confirmed_at) throw new DomainError('CONFLICT', 'Exclusion already confirmed.');
  await tx`update skus set exclusion_confirmed_at = now() where id = ${skuId} and workspace_id = ${workspaceId}`;
  await record(tx, s, workspaceId, 'sku_exclusion', { type: 'sku', id: skuId }, 'confirmed', note);
  await audit(tx, s, 'sku.confirm_exclusion', { type: 'sku', id: skuId }, { workspaceId, reason: note, before: { status: sku.status, reject_reason: sku.reject_reason }, after: { exclusion_confirmed: true } });
  return { productName: (sku.name as string) ?? 'This product', reason: (sku.reject_reason as string) ?? note };
}

/**
 * Decide a held before/after or possible-minor asset (§14, standard §48): approved media becomes usable; rejected
 * media is never used in production (and stays out of every reference set).
 */
export async function reviewAsset(tx: Tx, s: Staff, workspaceId: string, assetId: string, verdict: 'approved' | 'rejected', note: string, opts: { permissionRef?: string | null } = {}) {
  assertStaff(s, 'claims.review');
  const [a] = await tx`select a.id, a.review_status, a.review_flags, a.origin, a.sku_id, k.name as sku_name from assets a left join skus k on k.id = a.sku_id and k.workspace_id = a.workspace_id
                       where a.id = ${assetId} and a.workspace_id = ${workspaceId} for update of a`;
  if (!a) throw new DomainError('NOT_FOUND', 'Asset not found in this workspace');
  if (a.review_status !== 'pending') throw new DomainError('CONFLICT', 'This media isn’t waiting for review.');
  // §43: a before/after is used only with provenance and permission on file — the merchant's attestation at
  // upload, or a reference to the written permission they sent us. The policy review is this decision.
  const permissionRef = opts.permissionRef?.trim() || null;
  const attestation = attestationOf(a.origin);
  if (verdict === 'approved' && (a.review_flags as { beforeAfter?: boolean } | null)?.beforeAfter && !attestation && !permissionRef) {
    throw new DomainError('CONFLICT', 'A before/after can only be approved with provenance and permission on file: the merchant’s upload attestation, or a reference to the written permission they sent.');
  }
  await tx`update assets set review_status = ${verdict} where id = ${assetId} and workspace_id = ${workspaceId}`;
  await record(tx, s, workspaceId, 'asset_review', { type: 'asset', id: assetId }, verdict, permissionRef ? `${note} (permission: ${permissionRef})` : note);
  await audit(tx, s, `asset_review.${verdict}`, { type: 'asset', id: assetId }, { workspaceId, reason: note, before: { review_status: 'pending', flags: a.review_flags }, after: { review_status: verdict, attestation, permissionRef } });
  return { skuId: (a.sku_id as string | null) ?? null, productName: (a.sku_name as string | null) ?? 'your product' };
}
