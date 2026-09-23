// Canonical enums from the Product Standard (V1.2). Values are persisted: never rename, only add.

export const DataState = ['OBSERVED', 'INFERRED', 'DECIDED'] as const; // §15
export type DataState = (typeof DataState)[number];

export const FactStatus = ['ACTIVE', 'SUPERSEDED', 'DISPUTED'] as const; // §16
export type FactStatus = (typeof FactStatus)[number];

export const ClaimStatus = [
  'VERIFIED',
  'VERIFIED_WITH_QUALIFIER',
  'MERCHANT_REVIEW_REQUIRED',
  'RESTRICTED',
  'BLOCKED',
  'INFERRED_ONLY',
] as const; // §17
export type ClaimStatus = (typeof ClaimStatus)[number];

/** Claim statuses that may reach a final render (§17, Launch Gate 3). */
export const RENDERABLE_CLAIM_STATUSES: readonly ClaimStatus[] = ['VERIFIED', 'VERIFIED_WITH_QUALIFIER'];

export const ProjectState = [
  'PRODUCT_UPLOADED',
  'PRODUCT_ANALYZED',
  'BRIEF_READY',
  'CONCEPTS_READY',
  'CONCEPT_SELECTED',
  'STORYBOARD_READY',
  'STORYBOARD_APPROVED',
  'RENDER_RESERVED',
  'RENDERING',
  'QA_RUNNING',
  'COMPOSING',
  'PLATFORM_VARIANTS',
  'FINAL_QA',
  'COMPLETE',
  'NEEDS_USER_ACTION',
  'BLOCKED_COMPLIANCE',
  'PROVIDER_FAILED',
  'REFUNDED',
  'CANCELLED',
] as const; // §35
export type ProjectState = (typeof ProjectState)[number];

export const ExperimentState = [
  'DRAFT',
  'RECOMMENDED',
  'APPROVED',
  'PRODUCING',
  'READY_TO_RUN',
  'GATHERING_SIGNAL',
  'DIRECTIONAL',
  'ACTIONABLE',
  'ARCHIVED',
  'INCONCLUSIVE',
  'INVALIDATED',
  'OPERATIONALLY_CONFOUNDED',
] as const; // §35
export type ExperimentState = (typeof ExperimentState)[number];

export const ExperimentMode = ['CONTROLLED', 'EXPLORATORY'] as const; // §20
export type ExperimentMode = (typeof ExperimentMode)[number];

export const SignalState = ['GATHERING_SIGNAL', 'DIRECTIONAL', 'ACTIONABLE', 'WEAKENING', 'INVALIDATED'] as const; // §21
export type SignalState = (typeof SignalState)[number];

export const PortfolioSlot = ['EXPLOIT', 'EXPAND', 'EXPLORE'] as const; // §20
export type PortfolioSlot = (typeof PortfolioSlot)[number];

export const SkuMaturity = ['COLD', 'DEVELOPING', 'MATURE'] as const;
export type SkuMaturity = (typeof SkuMaturity)[number];

export const MeasurementContext = [
  'META_PAID_ATTRIBUTED',
  'TIKTOK_PAID_ATTRIBUTED',
  'TIKTOK_GMV_MAX_TOTAL',
  'SHOPIFY_BLENDED_ORDER',
  'MERCHANT_IMPORTED',
] as const; // §30
export type MeasurementContext = (typeof MeasurementContext)[number];

export const ProductionMode = [
  'STRICT_COMPOSITE',
  'GENERATIVE_INTERACTION',
  'HYBRID',
  'REAL_ASSET_REMIX',
  'CREATOR_PACK',
] as const; // §23
export type ProductionMode = (typeof ProductionMode)[number];

export const WorkspaceState = [
  'PROVISIONAL',
  'ACTIVE_FREE',
  'ACTIVE_PAID',
  'PAST_DUE',
  'CANCELLED',
  'PURGE_SCHEDULED',
  'PURGED',
  'SUSPENDED',
  'LOCKED',
] as const; // plan 02 §2
export type WorkspaceState = (typeof WorkspaceState)[number];

export const Role = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const; // plan 02 §1.1
export type Role = (typeof Role)[number];

export const StaffRole = [
  'SUPER_ADMIN',
  'OPS',
  'SUPPORT',
  'FINANCE',
  'COMPLIANCE',
  'GROWTH',
  'ENGINEERING',
  'ANALYST',
] as const; // plan 05 §0.2
export type StaffRole = (typeof StaffRole)[number];

export const PlanCode = ['LAUNCH', 'GROWTH', 'SCALE'] as const;
export type PlanCode = (typeof PlanCode)[number];

export const OfferType = ['TASTE', 'STANDALONE', 'PLAN_UPGRADE', 'WIN_BACK'] as const;
export type OfferType = (typeof OfferType)[number];

export const Platform = ['TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_FEED'] as const;
export type Platform = (typeof Platform)[number];

export const ExportFormat = ['9x16', '4x5', '1x1'] as const;
export type ExportFormat = (typeof ExportFormat)[number];

/** Appendix A — Initial Creative Taxonomy (v1). */
export const Taxonomy = {
  version: 1,
  angle: [
    'PROBLEM_SOLUTION',
    'INGREDIENT_EDUCATION',
    'TEXTURE_SENSORY',
    'ROUTINE',
    'APPLICATION_HOWTO',
    'OBJECTION_HANDLING',
    'PRODUCT_COMPARISON',
    'SOCIAL_PROOF',
    'FOUNDER_STORY',
    'EXPERT_AUTHORITY',
    'MYTH_BUSTING',
    'FAQ_RESPONSE',
    'LIFESTYLE_IDENTITY',
    'PRICE_VALUE',
    'OFFER',
    'SIMPLICITY',
    'PREMIUM_LUXURY',
  ],
  hook: [
    'PROBLEM',
    'QUESTION',
    'CONTRARIAN',
    'CURIOSITY',
    'CONFESSION',
    'TESTIMONIAL',
    'DEMONSTRATION',
    'RESULT_FIRST',
    'LIST',
    'WARNING',
    'MYTH',
    'COMMENT_REPLY',
    'DIRECT_PRODUCT',
  ],
  proof: [
    'TEXTURE_DEMO',
    'APPLICATION_DEMO',
    'INGREDIENT_EXPLANATION',
    'CUSTOMER_TESTIMONIAL',
    'CREATOR_TESTIMONIAL',
    'FOUNDER_EXPLANATION',
    'EXPERT_EXPLANATION',
    'PRODUCT_COMPARISON',
    'BEFORE_AFTER_RESTRICTED',
    'NONE',
  ],
  treatment: [
    'RAW_UGC',
    'POLISHED_UGC',
    'FOUNDER',
    'CREATOR',
    'PRODUCT_ONLY',
    'MOTION_GRAPHICS',
    'AI_TALENT',
    'AI_PRODUCT',
    'HYBRID',
    'PREMIUM_STUDIO',
  ],
} as const;
export type Angle = (typeof Taxonomy.angle)[number];
export type HookMechanism = (typeof Taxonomy.hook)[number];
export type ProofMechanism = (typeof Taxonomy.proof)[number];
export type Treatment = (typeof Taxonomy.treatment)[number];
