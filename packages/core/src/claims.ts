import type { Tx } from '@arkiv/db';
import { weakenLearnings } from './experiment-state';
import { DomainError, ExportFormat, normalizeClaimPlatforms, normalizeMarkets, platformsFor, RENDERABLE_CLAIM_STATUSES, type ClaimStatus } from '@arkiv/shared';
import { assertCan } from './authz';
import { claimMeaningKey, classifyClaim, type SuggestedStatus } from './compliance';
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
  /** Our compliance team's note on a RESTRICTED claim (kept restricted, or what evidence is needed). */
  complianceNote: string | null;
  /** Other wordings of the same claim found in the sources (page, label, merchant). */
  altWordings: string[];
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
  complianceNote: (r.compliance_note as string) ?? null,
  altWordings: (r.alt_wordings as string[] | null) ?? [],
});

type ClaimOrigin = 'extracted' | 'merchant' | 'staff' | 'review_signal';

/** The status a new wording starts at: rules decide, never the model (§22); customer language never becomes a claim. */
function initialStatus(wording: string, origin: ClaimOrigin): { status: ClaimStatus; cls: ReturnType<typeof classifyClaim> } {
  const cls = classifyClaim(wording);
  // Customer language may inspire hooks but never becomes an efficacy claim (§18, §43 "cured acne" review).
  let status: ClaimStatus = cls.status === 'VERIFIED' || cls.status === 'VERIFIED_WITH_QUALIFIER' ? 'MERCHANT_REVIEW_REQUIRED' : cls.status;
  if (origin === 'review_signal' && status !== 'BLOCKED') status = 'INFERRED_ONLY';
  return { status, cls };
}

/**
 * Name the change the next claim writes record in its version history (claim_versions, written by the claims
 * trigger), run them, and clear it again so later writes in the transaction don't inherit it.
 */
export async function withClaimChange<T>(tx: Tx, change: { kind: string; actor: string; reason?: string | null }, fn: () => Promise<T>): Promise<T> {
  await tx`select set_config('arkiv.claim_change', ${change.kind}, true), set_config('arkiv.claim_actor', ${change.actor}, true), set_config('arkiv.claim_reason', ${change.reason ?? ''}, true)`;
  try {
    return await fn();
  } finally {
    await tx`select set_config('arkiv.claim_change', '', true), set_config('arkiv.claim_actor', '', true), set_config('arkiv.claim_reason', '', true)`;
  }
}

/**
 * Propose a claim for a SKU (§17). One claim per meaning: a wording whose meaning (the model's canonical meaning,
 * else the deterministic meaning key) matches an existing claim of the SKU joins it as another wording — the same
 * claim from the page and the label keeps one status — unless the rules would treat the new wording differently,
 * in which case it stays its own claim so a riskier phrasing is never hidden behind a safer one.
 */
export async function proposeClaim(
  tx: Tx,
  ctx: TenantContext,
  skuId: string,
  input: { wording: string; meaning?: string | null; origin: ClaimOrigin; sourceText?: string | null },
): Promise<ClaimRow> {
  const wording = input.wording.trim();
  if (!wording) throw new DomainError('INVALID', 'Claim wording is required');
  const meaning = input.meaning?.trim() || null;
  const keys = new Set([claimMeaningKey(wording), ...(meaning ? [claimMeaningKey(meaning)] : [])].filter(Boolean));
  const { status, cls } = initialStatus(wording, input.origin);
  const existing = await tx`select * from claims where sku_id = ${skuId} order by created_at`;
  const same = (t: string) => t.trim().toLowerCase() === wording.toLowerCase();
  const exact = existing.find((c) => same(c.preferred_wording as string) || ((c.alt_wordings as string[]) ?? []).some(same));
  if (exact) return toClaim(exact);
  const match = existing.find((c) => [c.canonical_meaning as string, c.preferred_wording as string, ...((c.alt_wordings as string[]) ?? [])].some((t) => keys.has(claimMeaningKey(t))));
  if (match) {
    const theirs = initialStatus(match.preferred_wording as string, match.origin as ClaimOrigin);
    if (theirs.status === status && theirs.cls.category === cls.category) {
      const [r] = await withClaimChange(tx, { kind: 'wording_added', actor: actorString(ctx), reason: input.sourceText ?? null }, () =>
        tx`update claims set alt_wordings = array_append(alt_wordings, ${wording}::text) where id = ${match.id} returning *`,
      );
      return toClaim(r!);
    }
  }
  const [r] = await withClaimChange(tx, { kind: 'created', actor: actorString(ctx), reason: input.sourceText ?? null }, () => tx`
    insert into claims (workspace_id, sku_id, canonical_meaning, preferred_wording, claim_category, risk_level, status,
      origin, source_text, block_reason, mandatory_qualifier)
    values (${ctx.workspaceId}, ${skuId}, ${meaning ?? claimMeaningKey(wording)}, ${wording}, ${cls.category}, ${cls.risk}, ${status},
      ${input.origin}, ${input.sourceText ?? null}, ${status === 'BLOCKED' || status === 'RESTRICTED' ? cls.matched[0]?.reason ?? null : null},
      ${cls.status === 'VERIFIED_WITH_QUALIFIER' ? 'with regular use' : null})
    returning *`);
  await emit(tx, ctx, 'CLAIM_CREATED', { type: 'claim', id: r!.id as string }, { status, category: cls.category, rules: cls.matched.map((m) => m.ruleId), wording, canonicalMeaning: r!.canonical_meaning, origin: input.origin }, { skuId });
  if (status === 'BLOCKED') await emit(tx, ctx, 'CLAIM_BLOCKED', { type: 'claim', id: r!.id as string }, { reason: r!.block_reason }, { skuId });
  // Appendix B: a claim the rules send to the specialist path is RESTRICTED from the moment it exists.
  if (status === 'RESTRICTED') await emit(tx, ctx, 'CLAIM_RESTRICTED', { type: 'claim', id: r!.id as string }, { reason: (r!.block_reason as string | null) ?? 'Needs our compliance team’s review' }, { skuId });
  return toClaim(r!);
}

/** A claim's decision history, newest first (§15): every wording, status, scope and qualifier it has had. */
export async function claimHistory(tx: Tx, claimId: string) {
  return (await tx`select version, status, preferred_wording, alt_wordings, mandatory_qualifier, allowed_markets, allowed_platforms, merchant_approved,
                          change, reason, actor, created_at, id
                   from claim_versions where claim_id = ${claimId} order by version desc`).map((v) => ({
    id: v.id as string,
    version: Number(v.version),
    status: v.status as ClaimStatus,
    wording: v.preferred_wording as string,
    altWordings: (v.alt_wordings as string[]) ?? [],
    qualifier: (v.mandatory_qualifier as string | null) ?? null,
    markets: v.allowed_markets as string[],
    platforms: v.allowed_platforms as string[],
    merchantApproved: !!v.merchant_approved,
    change: v.change as string,
    reason: (v.reason as string | null) ?? null,
    actor: v.actor as string,
    at: v.created_at as Date,
  }));
}

/** The current version id of each claim (what a creative made now used), by claim id. */
export async function currentClaimVersions(tx: Tx, claimIds: readonly string[]): Promise<Record<string, string>> {
  if (!claimIds.length) return {};
  const rows = await tx`select distinct on (claim_id) claim_id, id from claim_versions where claim_id = any(${[...claimIds]}::uuid[]) order by claim_id, version desc`;
  return Object.fromEntries(rows.map((r) => [r.claim_id as string, r.id as string]));
}

/**
 * Approve a claim for use. Rules can't be overridden by the merchant: BLOCKED stays blocked (§43 "merchant
 * insists"), RESTRICTED needs the staff compliance path, and evidence-level claims need attached evidence.
 */
/** How evidence relates to the claimed product (§43: ingredient evidence does not transfer to the product). */
export const EVIDENCE_APPLICABILITY = ['product_specific', 'ingredient_level', 'other_formulation'] as const;
export type EvidenceApplicability = (typeof EVIDENCE_APPLICABILITY)[number];

/** Claim categories whose endorsement must be substantiated in its exact wording (§43 "Dermatologist tested"). */
const EXACT_WORDING = new Set(['expert_endorsement']);

const normWording = (s: string) => s.toLowerCase().replace(/[“”"'’.!]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Evidence on file that can substantiate this wording of a claim (§43, FTC [R13]): a document or a link to one
 * (a merchant's say-so alone is not evidence), not expired, about this product (not an ingredient study or another
 * formulation), not a mere ingredient spec, and — where it states the substantiated wording — the same wording.
 * Expert endorsements need that wording stated.
 */
export async function qualifyingEvidence(tx: Tx, claimId: string, wording: string, category: string, only?: string[] | null) {
  const rows = await tx`select id, evidence_type, source_asset_id, source_location, applicability, expiry_date, substantiated_wording
                        from claim_evidence where claim_id = ${claimId}`;
  const reasons = new Set<string>();
  const ok = rows.filter((e) => {
    if (only?.length && !only.includes(e.id as string)) return false;
    const onFile = e.source_asset_id != null || /^https?:\/\/\S+$/i.test(String(e.source_location ?? '').trim());
    if (!onFile) return reasons.add('attach the document (or a link to it)'), false;
    if (e.expiry_date && new Date(e.expiry_date as string).getTime() < new Date(new Date().toISOString().slice(0, 10)).getTime()) return reasons.add('the evidence has expired'), false;
    if (e.evidence_type === 'ingredient_spec' || e.applicability !== 'product_specific') return reasons.add('the evidence must be about this product, not an ingredient or another formula'), false;
    const said = (e.substantiated_wording as string | null)?.trim();
    if (said ? normWording(said) !== normWording(wording) : EXACT_WORDING.has(category)) return reasons.add('the evidence must state this exact wording'), false;
    return true;
  });
  return { ids: ok.map((e) => e.id as string), reasons: [...reasons] };
}

export async function approveClaim(
  tx: Tx,
  ctx: TenantContext,
  claimId: string,
  scope: {
    markets: string[];
    platforms: string[];
    qualifier?: string | null;
    wording?: string;
    /** The evidence this approval rests on (default: every qualifying file). */
    evidenceIds?: string[] | null;
    /** Staff only, after a second reviewer's approval: approve without qualifying evidence, with the reason. */
    overrideReason?: string | null;
  },
): Promise<ClaimRow> {
  const isStaff = ctx.actor.kind === 'staff';
  if (!isStaff) assertCan(ctx, 'claim.approve');
  if (!scope.markets.length || !scope.platforms.length) throw new DomainError('INVALID', 'Choose where this claim may be used');
  // Stored scope is canonical (upper-case, aliases expanded) so the render check can match it exactly (§17).
  const platforms = normalizeClaimPlatforms(scope.platforms);
  const markets = normalizeMarkets(scope.markets);
  const [c] = await tx`select * from claims where id = ${claimId} for update`;
  if (!c) throw new DomainError('NOT_FOUND', 'Claim not found');
  const wording = scope.wording?.trim() || (c.preferred_wording as string);
  const cls = classifyClaim(wording);
  if (c.status === 'BLOCKED' || cls.status === 'BLOCKED')
    throw new DomainError('GATE_BLOCKED', cls.matched[0]?.reason ?? (c.block_reason as string) ?? 'This claim can’t be used.', { alternative: cls.matched[0]?.alternative });
  if ((c.status === 'RESTRICTED' || cls.status === 'RESTRICTED') && !isStaff)
    throw new DomainError('GATE_BLOCKED', 'This claim needs our compliance team’s review before it can be used.', { restricted: true });
  if (c.status === 'INFERRED_ONLY') throw new DomainError('GATE_BLOCKED', 'Customer language can guide ideas but can’t be advertised as a product claim.');
  // High-risk and RESTRICTED claims need qualifying evidence — for staff approvals too (§43 "Clinically tested").
  let evidenceIds: string[] = [];
  let override: string | null = null;
  if (cls.risk === 'high' || c.status === 'RESTRICTED' || cls.status === 'RESTRICTED') {
    const ev = await qualifyingEvidence(tx, claimId, wording, cls.category, scope.evidenceIds);
    evidenceIds = ev.ids;
    if (!evidenceIds.length) {
      if (!isStaff || !scope.overrideReason?.trim())
        throw new DomainError(
          'GATE_BLOCKED',
          `This claim needs evidence before it can be approved${ev.reasons.length ? `: ${ev.reasons.join('; ')}` : ' (a study, test report or certificate about this product)'}.`,
          { needsEvidence: true, reasons: ev.reasons },
        );
      override = scope.overrideReason.trim();
    }
  }
  const qualifier = scope.qualifier?.trim() || (c.mandatory_qualifier as string | null);
  const status: ClaimStatus = qualifier ? 'VERIFIED_WITH_QUALIFIER' : 'VERIFIED';
  // A reworded claim keeps the wording it was found in as one of its wordings (the meaning is unchanged).
  const was = c.preferred_wording as string;
  const alt = was.trim().toLowerCase() !== wording.toLowerCase() && !((c.alt_wordings as string[]) ?? []).some((w) => w.toLowerCase() === was.toLowerCase())
    ? [...((c.alt_wordings as string[]) ?? []), was].filter((w) => w.toLowerCase() !== wording.toLowerCase())
    : ((c.alt_wordings as string[]) ?? []).filter((w) => w.toLowerCase() !== wording.toLowerCase());
  const [r] = await withClaimChange(tx, { kind: 'approved', actor: actorString(ctx), reason: override ? `evidence override: ${override}` : null }, () => tx`
    update claims set status = ${status}, preferred_wording = ${wording}, alt_wordings = ${alt}::text[], mandatory_qualifier = ${qualifier ?? null},
      allowed_markets = ${markets}, allowed_platforms = ${platforms}, merchant_approved = ${!isStaff},
      approved_by = ${actorString(ctx)}, reviewed_at = now()
    where id = ${claimId} returning *`);
  await emit(tx, ctx, 'CLAIM_APPROVED', { type: 'claim', id: claimId }, { status, scope: { markets, platforms, qualifier: qualifier ?? null }, evidenceIds, ...(override ? { evidenceOverride: override } : {}) });
  return toClaim(r!);
}

export async function blockClaim(tx: Tx, ctx: TenantContext, claimId: string, reason: string) {
  if (ctx.actor.kind !== 'staff') assertCan(ctx, 'claim.approve');
  const [before] = await tx`select sku_id, status from claims where id = ${claimId}`;
  await withClaimChange(tx, { kind: 'blocked', actor: actorString(ctx), reason }, () =>
    tx`update claims set status = 'BLOCKED', block_reason = ${reason}, reviewed_at = now(), approved_by = ${actorString(ctx)} where id = ${claimId}`,
  );
  await emit(tx, ctx, 'CLAIM_BLOCKED', { type: 'claim', id: claimId }, { reason });
  // §21: a claim the SKU's ads could use is withdrawn — the context its learnings came from changed; they weaken
  // and get revalidated.
  if (before?.sku_id && ['VERIFIED', 'VERIFIED_WITH_QUALIFIER'].includes(before.status as string)) await weakenLearnings(tx, ctx, before.sku_id as string, 'an approved claim was blocked');
}

export async function restrictClaim(tx: Tx, ctx: TenantContext, claimId: string, reason: string) {
  await withClaimChange(tx, { kind: 'restricted', actor: actorString(ctx), reason }, () =>
    tx`update claims set status = 'RESTRICTED', block_reason = ${reason}, reviewed_at = now() where id = ${claimId}`,
  );
  await emit(tx, ctx, 'CLAIM_RESTRICTED', { type: 'claim', id: claimId }, { reason });
}

export async function attachEvidence(
  tx: Tx,
  ctx: TenantContext,
  claimId: string,
  e: {
    type: string;
    assetId?: string | null;
    location?: string | null;
    applicability?: EvidenceApplicability | null;
    strength?: 'weak' | 'moderate' | 'strong';
    expiry?: string | null;
    /** The claim wording the evidence substantiates, as it states it. */
    wording?: string | null;
  },
) {
  if (ctx.actor.kind !== 'staff') assertCan(ctx, 'sku.edit');
  if (e.applicability && !(EVIDENCE_APPLICABILITY as readonly string[]).includes(e.applicability)) throw new DomainError('INVALID', 'Say whether the evidence is about this product.');
  await tx`insert into claim_evidence (workspace_id, claim_id, evidence_type, source_asset_id, source_location, supplied_by,
             applicability, evidence_strength, expiry_date, substantiated_wording)
           values (${ctx.workspaceId}, ${claimId}, ${e.type}, ${e.assetId ?? null}, ${e.location ?? null}, ${actorString(ctx)},
             ${e.applicability ?? null}, ${e.strength ?? 'moderate'}, ${e.expiry ?? null}, ${e.wording?.trim() || null})`;
  await emit(tx, ctx, 'CLAIM_EVIDENCE_ATTACHED', { type: 'claim', id: claimId }, { type: e.type });
}

export async function listClaims(tx: Tx, skuId: string): Promise<ClaimRow[]> {
  return (await tx`select * from claims where sku_id = ${skuId} order by created_at`).map(toClaim);
}

/** Where a render is published: the platforms of its exports and the brand's market. */
export interface ClaimScope {
  platforms: readonly string[];
  /** Defaults to the SKU's brand market (Brand Brain), else US. */
  market?: string | null;
}

/** Every platform an ad's standard exports (9:16, 4:5, 1:1) are published to. */
export const AD_PLATFORMS = platformsFor(ExportFormat);

/** Market a SKU's creative is made for: its brand's Brand Brain market, else the workspace's first brand, else US. */
export async function claimMarket(tx: Tx, skuId: string): Promise<string> {
  const [r] = await tx`select coalesce((select b.brain->>'market' from brands b where b.id = s.brand_id and b.workspace_id = s.workspace_id),
                                       (select b.brain->>'market' from brands b where b.workspace_id = s.workspace_id order by b.created_at limit 1)) as market
                       from skus s where s.id = ${skuId}`;
  const m = (r?.market as string | null) ?? 'US';
  try {
    return normalizeMarkets([m])[0]!;
  } catch {
    return 'US';
  }
}

/**
 * Claims usable in a final render published on *every* platform in `scope`, in its market (Launch Gate 3, §43
 * "US approval does not imply UK/EU approval"). Compared on canonical values, tolerant of legacy casing.
 */
export async function renderableClaims(tx: Tx, skuId: string, scope: ClaimScope): Promise<ClaimRow[]> {
  const platforms = normalizeClaimPlatforms(scope.platforms);
  const market = scope.market ? normalizeMarkets([scope.market])[0]! : await claimMarket(tx, skuId);
  const rows = await tx`select * from claims where sku_id = ${skuId} and status in ${tx(RENDERABLE_CLAIM_STATUSES as string[])}
                        and array(select upper(p) from unnest(allowed_platforms) p) @> ${platforms}::text[]
                        and exists (select 1 from unnest(allowed_markets) m where upper(m) = ${market})`;
  return rows.map(toClaim);
}

/** Why the evidence-expiry sweep sent a claim back to review. */
export const EVIDENCE_EXPIRING_REASON = 'The evidence behind this claim expires within 14 days';

/**
 * Evidence expiring within 14 days moves the claim back to review (plan 03 A5). Runs as a daily sweep (system role:
 * each row is written with its own workspace). Each claim gets a history version and a CLAIM_REVIEW_REQUIRED event.
 */
export async function sweepExpiringEvidence(tx: Tx): Promise<number> {
  const rows = await withClaimChange(tx, { kind: 'evidence_expiring', actor: 'system:sweep-evidence', reason: EVIDENCE_EXPIRING_REASON }, () => tx`
    update claims c set status = 'MERCHANT_REVIEW_REQUIRED', reviewed_at = now()
    where c.status in ('VERIFIED','VERIFIED_WITH_QUALIFIER')
      and exists (select 1 from claim_evidence e where e.claim_id = c.id and e.workspace_id = c.workspace_id and e.expiry_date is not null and e.expiry_date < now() + interval '14 days')
    returning c.id, c.workspace_id, c.sku_id, (select min(e.expiry_date) from claim_evidence e where e.claim_id = c.id and e.workspace_id = c.workspace_id and e.expiry_date is not null) as expires`);
  for (const r of rows) {
    await emit(tx, { workspaceId: r.workspace_id as string, actor: { kind: 'system', id: 'sweep-evidence' } }, 'CLAIM_REVIEW_REQUIRED', { type: 'claim', id: r.id as string },
      { reason: 'evidence_expiring', expiresOn: r.expires ? new Date(r.expires as string).toISOString().slice(0, 10) : null }, { skuId: r.sku_id as string });
  }
  return rows.length;
}

export type { SuggestedStatus };
