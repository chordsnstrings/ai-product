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
  'PROVIDER_JOB_CREATED',
  'PROVIDER_JOB_SUCCEEDED',
  'PROVIDER_JOB_FAILED',
  'QA_FAILED',
  'QA_PASSED',
  'COMPOSITION_COMPLETED',
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
  'INTEGRATION_CONNECTED',
  'INTEGRATION_DEGRADED',
  'INTEGRATION_DISCONNECTED',
  // Funnel (plan 04 §1) — server-side source of truth
  'LP_VIEWED',
  'UPLOAD_STARTED',
  'UPLOAD_COMPLETED',
  'URL_PARSE_FAILED',
  'SKU_VALIDATED',
  'SKU_REJECTED',
  'PRODUCT_ANALYZED',
  'CONCEPTS_READY',
  'ACCOUNT_CLAIMED',
  'STORYBOARD_READY',
  'CHECKOUT_STARTED',
  'TASTE_PAID',
  'ASSET_WATCHED',
  'ASSET_EXPORTED',
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

export const EVENT_SCHEMA_VERSION = 1;

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
};

/** Throws when a payload doesn't match the registered schema for its type (types without one always pass). */
export function assertEventPayload(type: EventType, payload: unknown): void {
  const schema = EVENT_PAYLOADS[type];
  if (!schema) return;
  const r = schema.safeParse(payload);
  if (!r.success) throw new Error(`${type} payload does not match its schema: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
}
