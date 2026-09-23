// Appendix B event catalogue (V1.2) + platform events from the build plan.
// Event envelope per §36: actor, timestamp, tenant, object IDs, schema version.

export const EventType = [
  // Product
  'PRODUCT_IMPORTED',
  'PRODUCT_FACT_OBSERVED',
  'PRODUCT_FACT_CHANGED',
  'PRODUCT_CONFLICT_DETECTED',
  'VISUAL_FINGERPRINT_VERSIONED',
  'CUSTOMER_THEME_UPDATED',
  // Claims
  'CLAIM_CREATED',
  'CLAIM_EVIDENCE_ATTACHED',
  'CLAIM_APPROVED',
  'CLAIM_RESTRICTED',
  'CLAIM_BLOCKED',
  // Creative
  'CREATIVE_IMPORTED',
  'GENOME_EXTRACTED',
  'CREATIVE_VERSIONED',
  // Experiment
  'EXPERIMENT_CREATED',
  'EXPERIMENT_APPROVED',
  'EXPERIMENT_STATE_CHANGED',
  'VARIANT_GENERATED',
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
