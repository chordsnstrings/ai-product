// Appendix B event catalogue (V1.2) + platform events from the build plan.
// Event envelope per §36: actor, timestamp, tenant, object IDs, schema version.
import { z } from 'zod';
import { ClaimStatus, Role } from './enums';

export const EventType = [
  // Product
  'PRODUCT_IMPORTED',
  'PRODUCT_FACT_OBSERVED',
  'PRODUCT_FACT_CHANGED',
  'PRODUCT_CONFLICT_DETECTED',
  'VISUAL_FINGERPRINT_VERSIONED',
  'CUSTOMER_THEME_UPDATED',
  // Brand
  'BRAND_BRAIN_VERSIONED',
  // Claims
  'CLAIM_CREATED',
  'CLAIM_EVIDENCE_ATTACHED',
  'CLAIM_APPROVED',
  'CLAIM_RESTRICTED',
  'CLAIM_BLOCKED',
  'CLAIM_UNBLOCKED',
  // Platform event: our compliance team asked the brand for more evidence on a RESTRICTED claim (plan 05 §14).
  'CLAIM_EVIDENCE_REQUESTED',
  // Creative
  'CREATIVE_IMPORTED',
  'GENOME_EXTRACTED',
  'CREATIVE_VERSIONED',
  // Experiment
  'EXPERIMENT_CREATED',
  'EXPERIMENT_APPROVED',
  'EXPERIMENT_STATE_CHANGED',
  'VARIANT_GENERATED',
  // Platform event: a hook variant was not shipped (claims, integrity or fit) — never shipped confounded.
  'VARIANT_SKIPPED',
  'VARIANT_EXPORTED',
  // Standard §26 / §49 usage: a Creator Pack (a structured brief for a human creator) was made for an experiment.
  'CREATOR_PACK_CREATED',
  'EXPERIMENT_CONFOUNDED',
  // Performance
  'PERFORMANCE_INGESTED',
  'DATA_FRESHNESS_CHANGED',
  'CONFIDENCE_CHANGED',
  'LEARNING_CREATED',
  'LEARNING_WEAKENED',
  'LEARNING_INVALIDATED',
  // Recommendation
  'RECOMMENDATION_CREATED',
  'RECOMMENDATION_ACCEPTED',
  'RECOMMENDATION_DISMISSED',
  // Production
  'PROJECT_STATE_CHANGED',
  // §8: the merchant chose a creative goal (sell, UGC review, explainer, premium) for the next ideas.
  'PROJECT_GOAL_CHANGED',
  // Plan 03 P10 "Not right?": the merchant said the delivered ad missed (strategy / product accuracy / style).
  'OUTPUT_REJECTED',
  // §26: the merchant accepted creator footage into the experiment it answers (Creative Genome input).
  'CREATOR_FOOTAGE_ACCEPTED',
  'PROVIDER_JOB_CREATED',
  'PROVIDER_JOB_SUCCEEDED',
  'PROVIDER_JOB_FAILED',
  'QA_FAILED',
  'QA_PASSED',
  'COMPOSITION_COMPLETED',
  // Platform event: a paid production was asked to generate its creative again (Appendix C first-render acceptance:
  // `by: user` is a customer-requested regeneration; system and staff retries are not the customer's).
  'CREATIVE_REGENERATION_REQUESTED',
  // Billing / ledger
  'CREDIT_RESERVED',
  'CREDIT_CONSUMED',
  'CREDIT_RELEASED',
  'CREDIT_REFUNDED',
  'CREDIT_GRANTED',
  'CREDIT_EXPIRED',
  'CREDIT_ADJUSTED',
  'FREE_QA_RETRY',
  'PROVIDER_COST_RECORDED',
  // Platform / tenancy
  'WORKSPACE_CREATED',
  'WORKSPACE_STATE_CHANGED',
  'WORKSPACE_PURGED',
  'MEMBER_ADDED',
  'MEMBER_REMOVED',
  'MEMBER_ROLE_CHANGED',
  'OFFER_ISSUED',
  'OFFER_EXPIRED',
  'OFFER_REDEEMED',
  'SUBSCRIPTION_CHANGED',
  // Platform event: the subscription ended (Stripe deleted it) — the churn movement in MRR (plan 05 §7).
  'SUBSCRIPTION_ENDED',
  'INTEGRATION_CONNECTED',
  'INTEGRATION_DEGRADED',
  'INTEGRATION_DISCONNECTED',
  // Platform event: staff moved a SKU between workspaces with the owner's consent (plan 05 §2.3); one per side.
  'SKU_TRANSFERRED',
  // Standard §9/§11: the Day-30 / month-end SKU Creative Review was written.
  'SKU_REVIEW_CREATED',
  // Funnel (plan 04 §1) — server-side source of truth
  'LP_VIEWED',
  'UPLOAD_STARTED',
  'UPLOAD_COMPLETED',
  // An upload attempt refused before a preview started (plan 05 §4 drop-off drilldown: file too big, unsupported page…).
  'UPLOAD_FAILED',
  'URL_PARSE_FAILED',
  // Plan 03 P2: an out-of-scope product (not skincare, or SPF/drug) — the visitor left an email for when we support it.
  'WAITLIST_JOINED',
  'SKU_VALIDATED',
  'SKU_REJECTED',
  'PRODUCT_ANALYZED',
  'CONCEPTS_READY',
  'ACCOUNT_CLAIMED',
  // Plan 06 Phase 3 #8 "Passkeys (offered after first purchase)": the prompt was shown, and a passkey was added from it.
  'PASSKEY_PROMPT_SHOWN',
  'PASSKEY_ADDED',
  'STORYBOARD_READY',
  'CHECKOUT_STARTED',
  'TASTE_PAID',
  // Standard §7 "Taste delivered — QA pass and delivery success": a paid one-off ad reached COMPLETE.
  'TASTE_DELIVERED',
  'ASSET_WATCHED',
  'ASSET_EXPORTED',
  // Standard §40: a customer deleted an uploaded file (bytes purged unless retained for evidence/delivery).
  'ASSET_DELETED',
  // Standard §48: creator usage rights on a file ended (no new production; history kept), and the replacement upload.
  'ASSET_RIGHTS_EXPIRED',
  'ASSET_REPLACED',
  // Standard §7 "Ad account connected — Meta/TikTok connection rate".
  'AD_ACCOUNT_CONNECTED',
  'SUBSCRIPTION_STARTED',
] as const;
export type EventType = (typeof EventType)[number];

export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'staff'; id: string; onBehalfOf?: string }
  | { kind: 'system'; id: string }
  | { kind: 'provisional'; id: string };

export function actorRef(a: Actor): string {
  return a.kind === 'staff' && a.onBehalfOf ? `staff:${a.id}>${a.onBehalfOf}` : `${a.kind}:${a.id}`;
}

/**
 * v2: every event carries `refs` (object IDs, subject included), one subject type per event type
 * (EVENT_SUBJECT), VARIANT_GENERATED is emitted for experiment variants only (a finished one-off ad is
 * COMPOSITION_COMPLETED) and PRODUCT_FACT_CHANGED carries the changed value.
 */
export const EVENT_SCHEMA_VERSION = 2;

/**
 * Payload schemas for event types written from more than one code path (customer app, staff console, system),
 * so every writer produces one shape under the same schema_version (§36). emit() checks them.
 */
export const EVENT_PAYLOADS: Partial<Record<EventType, z.ZodType>> = {
  // One event per member whose role changed. `transfer` marks an ownership transfer; `byStaff` a support action.
  MEMBER_ROLE_CHANGED: z
    .object({ from: z.enum(Role), to: z.enum(Role), transfer: z.literal(true).optional(), byStaff: z.literal(true).optional(), reason: z.string().optional() })
    .strict(),
  CLAIM_RESTRICTED: z.object({ reason: z.string() }).strict(),
  // COMPLIANCE lifted a block (four-eyes): the claim goes back to review, never straight to approved.
  CLAIM_UNBLOCKED: z.object({ from: z.literal('BLOCKED'), to: z.enum(ClaimStatus), reason: z.string() }).strict(),
  CLAIM_EVIDENCE_REQUESTED: z.object({ note: z.string() }).strict(),
  // Usage-ledger events of the Model Gateway (§37): one per provider call opened and closed. They carry no money
  // amount of their own (the ledger's PROVIDER_COST_RECORDED does); estimate/actual are for reconstruction.
  PROVIDER_JOB_CREATED: z
    .object({ task: z.string(), provider: z.string(), model: z.string(), promptVersion: z.string(), arm: z.enum(['stable', 'canary']), estimateMicros: z.number().int() })
    .strict(),
  PROVIDER_JOB_SUCCEEDED: z
    .object({ task: z.string(), latencyMs: z.number().int().nullable(), actualMicros: z.number().int(), providerRequestId: z.string().nullable(), modelVersion: z.string().nullable() })
    .strict(),
  PROVIDER_JOB_FAILED: z
    .object({ task: z.string(), latencyMs: z.number().int().nullable(), actualMicros: z.number().int(), providerRequestId: z.string().nullable(), errorKind: z.string() })
    .strict(),
  CREATIVE_REGENERATION_REQUESTED: z.object({ by: z.enum(['user', 'staff', 'system']), from: z.string(), reason: z.string().nullable() }).strict(),
  // A creative derived from a delivered one (a hook variant, a recomposition): its parent and what changed.
  CREATIVE_VERSIONED: z
    .object({ parentCreativeId: z.string().uuid(), changedVariables: z.array(z.string()).min(1), variantId: z.string().uuid().nullable(), projectId: z.string().uuid().nullable() })
    .strict(),
};

/** Throws when a payload doesn't match the registered schema for its type (types without one always pass). */
export function assertEventPayload(type: EventType, payload: unknown): void {
  const schema = EVENT_PAYLOADS[type];
  if (!schema) return;
  const r = schema.safeParse(payload);
  if (!r.success) throw new Error(`${type} payload does not match its schema: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
}

// ───────────── Subjects and object refs (§36 "events carry … object IDs") ─────────────

/** Object IDs an event can relate to. Stored in events.refs so projections can be rebuilt without payload parsing. */
export const EVENT_REF_KEYS = [
  'skuId',
  'projectId',
  'experimentId',
  'variantId',
  'creativeId',
  'sceneId',
  'storyboardId',
  'claimId',
  'factId',
  'learningId',
  'recommendationId',
  'integrationId',
  'providerJobId',
  'authorizationId',
  'ledgerEntryId',
  'purchaseId',
  'offerId',
  'subscriptionId',
  'brandId',
  'assetId',
  'userId',
] as const;
export type EventRefKey = (typeof EVENT_REF_KEYS)[number];
export type EventRefs = Partial<Record<EventRefKey, string | null | undefined>>;

export type EventSubjectType =
  | 'sku'
  | 'brand'
  | 'claim'
  | 'creative'
  | 'experiment'
  | 'variant'
  | 'learning'
  | 'recommendation'
  | 'project'
  | 'scene'
  | 'provider_job'
  | 'workspace'
  | 'user'
  | 'offer'
  | 'subscription'
  | 'integration'
  | 'asset';

/** The ref key a subject's id is also stored under (subject { type: 'sku', id } ⇒ refs.skuId = id). */
export const SUBJECT_REF: Partial<Record<EventSubjectType, EventRefKey>> = {
  sku: 'skuId',
  brand: 'brandId',
  claim: 'claimId',
  creative: 'creativeId',
  experiment: 'experimentId',
  variant: 'variantId',
  learning: 'learningId',
  recommendation: 'recommendationId',
  project: 'projectId',
  scene: 'sceneId',
  provider_job: 'providerJobId',
  user: 'userId',
  offer: 'offerId',
  subscription: 'subscriptionId',
  integration: 'integrationId',
  asset: 'assetId',
};

/**
 * One subject type per event type (an event may also have no subject: workspace-level, e.g. a subscription grant
 * with no project). Writers that disagree fail in tests (emit()).
 */
export const EVENT_SUBJECT: Record<EventType, EventSubjectType | null> = {
  PRODUCT_IMPORTED: 'sku',
  PRODUCT_FACT_OBSERVED: 'sku',
  PRODUCT_FACT_CHANGED: 'sku',
  PRODUCT_CONFLICT_DETECTED: 'sku',
  VISUAL_FINGERPRINT_VERSIONED: 'sku',
  CUSTOMER_THEME_UPDATED: 'sku',
  BRAND_BRAIN_VERSIONED: 'brand',
  CLAIM_CREATED: 'claim',
  CLAIM_EVIDENCE_ATTACHED: 'claim',
  CLAIM_APPROVED: 'claim',
  CLAIM_RESTRICTED: 'claim',
  CLAIM_BLOCKED: 'claim',
  CLAIM_UNBLOCKED: 'claim',
  CLAIM_EVIDENCE_REQUESTED: 'claim',
  CREATIVE_IMPORTED: 'creative',
  GENOME_EXTRACTED: 'creative',
  CREATIVE_VERSIONED: 'creative',
  EXPERIMENT_CREATED: 'experiment',
  EXPERIMENT_APPROVED: 'experiment',
  EXPERIMENT_STATE_CHANGED: 'experiment',
  VARIANT_GENERATED: 'variant',
  VARIANT_SKIPPED: 'variant',
  VARIANT_EXPORTED: 'variant',
  EXPERIMENT_CONFOUNDED: 'experiment',
  PERFORMANCE_INGESTED: 'integration',
  DATA_FRESHNESS_CHANGED: 'integration',
  CONFIDENCE_CHANGED: 'experiment',
  LEARNING_CREATED: 'learning',
  LEARNING_WEAKENED: 'learning',
  LEARNING_INVALIDATED: 'learning',
  RECOMMENDATION_CREATED: 'recommendation',
  RECOMMENDATION_ACCEPTED: 'recommendation',
  RECOMMENDATION_DISMISSED: 'recommendation',
  PROJECT_STATE_CHANGED: 'project',
  PROJECT_GOAL_CHANGED: 'project',
  OUTPUT_REJECTED: 'project',
  CREATOR_FOOTAGE_ACCEPTED: 'asset',
  PROVIDER_JOB_CREATED: 'provider_job',
  PROVIDER_JOB_SUCCEEDED: 'provider_job',
  PROVIDER_JOB_FAILED: 'provider_job',
  QA_FAILED: 'scene',
  QA_PASSED: 'scene',
  COMPOSITION_COMPLETED: 'project',
  CREATOR_PACK_CREATED: 'experiment',
  CREATIVE_REGENERATION_REQUESTED: 'project',
  CREDIT_RESERVED: 'project',
  CREDIT_CONSUMED: 'project',
  CREDIT_RELEASED: 'project',
  CREDIT_REFUNDED: 'project',
  CREDIT_GRANTED: 'project',
  CREDIT_EXPIRED: 'project',
  CREDIT_ADJUSTED: 'project',
  FREE_QA_RETRY: 'project',
  PROVIDER_COST_RECORDED: 'provider_job',
  WORKSPACE_CREATED: 'workspace',
  WORKSPACE_STATE_CHANGED: 'workspace',
  WORKSPACE_PURGED: 'workspace',
  MEMBER_ADDED: 'user',
  MEMBER_REMOVED: 'user',
  MEMBER_ROLE_CHANGED: 'user',
  OFFER_ISSUED: 'offer',
  OFFER_EXPIRED: 'offer',
  OFFER_REDEEMED: 'offer',
  SUBSCRIPTION_CHANGED: 'subscription',
  SUBSCRIPTION_ENDED: 'subscription',
  INTEGRATION_CONNECTED: 'integration',
  INTEGRATION_DEGRADED: 'integration',
  INTEGRATION_DISCONNECTED: 'integration',
  SKU_TRANSFERRED: 'sku',
  SKU_REVIEW_CREATED: 'sku',
  LP_VIEWED: null,
  UPLOAD_STARTED: null,
  UPLOAD_COMPLETED: 'sku',
  UPLOAD_FAILED: null,
  URL_PARSE_FAILED: null,
  WAITLIST_JOINED: null,
  SKU_VALIDATED: 'sku',
  SKU_REJECTED: 'sku',
  PRODUCT_ANALYZED: 'sku',
  CONCEPTS_READY: 'project',
  ACCOUNT_CLAIMED: 'workspace',
  PASSKEY_PROMPT_SHOWN: null,
  PASSKEY_ADDED: null,
  STORYBOARD_READY: 'project',
  CHECKOUT_STARTED: 'project',
  TASTE_PAID: 'project',
  TASTE_DELIVERED: 'project',
  ASSET_WATCHED: 'asset',
  ASSET_EXPORTED: 'asset',
  ASSET_DELETED: 'asset',
  ASSET_RIGHTS_EXPIRED: 'asset',
  ASSET_REPLACED: 'asset',
  AD_ACCOUNT_CONNECTED: 'integration',
  SUBSCRIPTION_STARTED: 'subscription',
};

/**
 * Object IDs every event of a type must carry (subject included), so downstream state (QA metrics, variant
 * lineage, ledger reconciliation, product truth) can be rebuilt from events alone.
 */
export const EVENT_REQUIRED_REFS: Partial<Record<EventType, readonly EventRefKey[]>> = {
  PRODUCT_FACT_OBSERVED: ['skuId', 'factId'],
  PRODUCT_FACT_CHANGED: ['skuId', 'factId'],
  PRODUCT_CONFLICT_DETECTED: ['skuId', 'factId'],
  QA_PASSED: ['sceneId', 'projectId', 'skuId', 'storyboardId', 'providerJobId'],
  QA_FAILED: ['sceneId', 'projectId', 'skuId', 'storyboardId', 'providerJobId'],
  VARIANT_GENERATED: ['variantId', 'experimentId', 'creativeId', 'skuId'],
  VARIANT_SKIPPED: ['variantId', 'experimentId', 'skuId'],
  COMPOSITION_COMPLETED: ['projectId', 'skuId', 'creativeId'],
  CREATOR_PACK_CREATED: ['experimentId', 'skuId'],
  CREATIVE_REGENERATION_REQUESTED: ['projectId', 'skuId'],
  CREDIT_RESERVED: ['ledgerEntryId', 'authorizationId'],
  CREDIT_CONSUMED: ['ledgerEntryId', 'authorizationId'],
  CREDIT_RELEASED: ['ledgerEntryId', 'authorizationId'],
  CREDIT_GRANTED: ['ledgerEntryId'],
  CREDIT_EXPIRED: ['ledgerEntryId'],
  CREDIT_ADJUSTED: ['ledgerEntryId'],
  PROVIDER_COST_RECORDED: ['ledgerEntryId', 'providerJobId'],
  FREE_QA_RETRY: ['ledgerEntryId', 'authorizationId', 'projectId'],
  LEARNING_CREATED: ['learningId', 'experimentId', 'skuId'],
  CONFIDENCE_CHANGED: ['experimentId', 'skuId'],
  EXPERIMENT_CREATED: ['experimentId', 'skuId'],
  EXPERIMENT_APPROVED: ['experimentId', 'skuId', 'projectId'],
  RECOMMENDATION_CREATED: ['recommendationId', 'skuId'],
  RECOMMENDATION_ACCEPTED: ['recommendationId', 'experimentId', 'skuId'],
  GENOME_EXTRACTED: ['creativeId'],
  CREATIVE_VERSIONED: ['creativeId', 'skuId'],
  PROVIDER_JOB_CREATED: ['providerJobId', 'authorizationId'],
  PROVIDER_JOB_SUCCEEDED: ['providerJobId', 'authorizationId'],
  PROVIDER_JOB_FAILED: ['providerJobId', 'authorizationId'],
};

/** Merge the subject into the refs and drop empty values. */
export function eventRefs(subject: { type: string; id: string } | null, refs: EventRefs = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(refs)) if (v) out[k] = v;
  const key = subject ? SUBJECT_REF[subject.type as EventSubjectType] : undefined;
  if (key && subject) out[key] = subject.id;
  return out;
}

/** Throws when an event's subject type or required refs don't match its registered contract. */
export function assertEventEnvelope(type: EventType, subject: { type: string; id: string } | null, refs: Record<string, string>): void {
  const want = EVENT_SUBJECT[type];
  if (subject && want && subject.type !== want) throw new Error(`${type} subject must be a ${want}, got ${subject.type}`);
  const missing = (EVENT_REQUIRED_REFS[type] ?? []).filter((k) => !refs[k]);
  if (missing.length) throw new Error(`${type} is missing refs: ${missing.join(', ')}`);
}
