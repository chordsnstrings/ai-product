import { DomainError } from './core';

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
  // CSV exports the merchant uploads, one context per platform (§48: platform observations are never averaged into
  // one result). Rows imported before the split carry the legacy 'MERCHANT_IMPORTED'.
  'MERCHANT_IMPORTED_META',
  'MERCHANT_IMPORTED_TIKTOK',
  // Non-paid delivery the merchant imports (§48 "organic or affiliate creative has no paid-spend context"): kept in
  // its own contexts, shown as separate evidence, never compared with paid CPA/ROAS or learned from as paid.
  'META_ORGANIC',
  'TIKTOK_ORGANIC',
  'META_AFFILIATE',
  'TIKTOK_AFFILIATE',
] as const; // §30
export type MeasurementContext = (typeof MeasurementContext)[number];

/** Customer-facing label per measurement context (§30). Contexts are shown side by side, never merged. */
export const MeasurementContextLabel: Record<MeasurementContext, string> = {
  META_PAID_ATTRIBUTED: 'Meta · paid (attributed)',
  TIKTOK_PAID_ATTRIBUTED: 'TikTok · paid (attributed)',
  TIKTOK_GMV_MAX_TOTAL: 'TikTok GMV Max · total (includes organic + affiliate)',
  SHOPIFY_BLENDED_ORDER: 'Shopify · blended orders',
  MERCHANT_IMPORTED_META: 'Meta · imported by you (CSV)',
  MERCHANT_IMPORTED_TIKTOK: 'TikTok · imported by you (CSV)',
  META_ORGANIC: 'Meta · organic (imported)',
  TIKTOK_ORGANIC: 'TikTok · organic (imported)',
  META_AFFILIATE: 'Meta · affiliate / creator (imported)',
  TIKTOK_AFFILIATE: 'TikTok · affiliate / creator (imported)',
};

/** What a merchant's CSV reports: paid ads, organic posts, or affiliate/creator posts (§48). */
export const CSV_SOURCES = ['paid', 'organic', 'affiliate'] as const;
export type CsvSource = (typeof CSV_SOURCES)[number];

/** Contexts with no paid-spend attribution: separate evidence, never a paid comparison or a paid learning (§48). */
export const NON_PAID_CONTEXTS: ReadonlySet<string> = new Set(['META_ORGANIC', 'TIKTOK_ORGANIC', 'META_AFFILIATE', 'TIKTOK_AFFILIATE']);
export const isPaidContext = (context: string) => !NON_PAID_CONTEXTS.has(context);

/** Ad platforms a merchant can import a CSV export from. */
export const CSV_PLATFORMS = ['meta', 'tiktok'] as const;
export type CsvPlatform = (typeof CSV_PLATFORMS)[number];
export const csvContext = (platform: CsvPlatform, source: CsvSource = 'paid'): MeasurementContext =>
  source === 'organic' ? (platform === 'tiktok' ? 'TIKTOK_ORGANIC' : 'META_ORGANIC')
  : source === 'affiliate' ? (platform === 'tiktok' ? 'TIKTOK_AFFILIATE' : 'META_AFFILIATE')
  : platform === 'tiktok' ? 'MERCHANT_IMPORTED_TIKTOK' : 'MERCHANT_IMPORTED_META';

/** The platform a context's numbers come from; 'blended' spans platforms (Shopify orders, legacy CSV imports). */
export function measurementContextPlatform(context: string): 'meta' | 'tiktok' | 'blended' {
  if (context.startsWith('META_') || context === 'MERCHANT_IMPORTED_META') return 'meta';
  if (context.startsWith('TIKTOK_') || context === 'MERCHANT_IMPORTED_TIKTOK') return 'tiktok';
  return 'blended';
}

/** Scope caveats that must travel with a context wherever its numbers are shown (§45). */
export const MeasurementContextCaveat: Partial<Record<MeasurementContext, string>> = {
  TIKTOK_GMV_MAX_TOTAL: 'GMV Max totals include organic and affiliate sales, so they are not comparable to paid-only ROAS.',
  SHOPIFY_BLENDED_ORDER: 'Blended store orders include every channel; they are not attributed to a single ad.',
  META_ORGANIC: 'Organic reach and views are useful evidence, but not comparable to paid-ad CPA or ROAS, and not used to pick a paid winner.',
  TIKTOK_ORGANIC: 'Organic reach and views are useful evidence, but not comparable to paid-ad CPA or ROAS, and not used to pick a paid winner.',
  META_AFFILIATE: 'Affiliate and creator sales have no paid spend behind them: useful evidence, not comparable to paid-ad CPA or ROAS.',
  TIKTOK_AFFILIATE: 'Affiliate and creator sales (GMV) have no paid spend behind them: useful evidence, not comparable to paid-ad CPA or ROAS.',
};

export function measurementContextLabel(context: string): string {
  if (context === 'MERCHANT_IMPORTED') return 'Imported by you (CSV, before per-platform imports)';
  return (MeasurementContextLabel as Record<string, string>)[context] ?? context.replace(/_/g, ' ').toLowerCase();
}

export const ProductionMode = [
  'STRICT_COMPOSITE',
  'GENERATIVE_INTERACTION',
  'HYBRID',
  'REAL_ASSET_REMIX',
  'CREATOR_PACK',
] as const; // §23
export type ProductionMode = (typeof ProductionMode)[number];

/** §8: what the merchant wants the ad to do. Recommendations default to performance. */
export const CreativeGoal = ['performance', 'ugc_review', 'explainer', 'premium'] as const;
export type CreativeGoal = (typeof CreativeGoal)[number];
/** The brief each goal gives the Creative Director (the context packet's objective). */
export const CREATIVE_GOAL_BRIEF: Record<CreativeGoal, string> = {
  performance: 'Sell the product: find the next creative test most likely to lift sales for this SKU',
  ugc_review: 'A UGC-style review: a customer-voiced, handheld, native-feeling ad (a generated person never claims to be a real customer)',
  explainer: 'Explain the product: what it is, how to use it and where it fits in a routine',
  premium: 'Premium creative: polished studio visuals that make the product look high-end',
};

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

/** Where each export is published (§30): 9:16 → TikTok + Reels; 4:5 and 1:1 → Facebook/Instagram feed. */
export const EXPORT_PLATFORMS: Record<ExportFormat, readonly Platform[]> = {
  '9x16': ['TIKTOK', 'INSTAGRAM_REELS'],
  '4x5': ['FACEBOOK_FEED'],
  '1x1': ['FACEBOOK_FEED'],
};
export const platformsFor = (formats: readonly ExportFormat[]): Platform[] => [...new Set(formats.flatMap((f) => EXPORT_PLATFORMS[f]))];

/** One placement of a finished variant (standard §20 Variant.platform_assets[]): the export a platform uses. */
export interface PlatformAsset {
  platform: Platform;
  aspect: ExportFormat;
  assetId: string;
}

/** A variant's exports by platform placement, in Platform order, then aspect order (9:16, 4:5, 1:1). */
export function platformAssets(exports: readonly { aspect: string; assetId: string }[]): PlatformAsset[] {
  const out: PlatformAsset[] = [];
  for (const platform of Platform) {
    for (const aspect of ExportFormat) {
      if (!EXPORT_PLATFORMS[aspect].includes(platform)) continue;
      for (const e of exports) if (e.aspect === aspect) out.push({ platform, aspect, assetId: e.assetId });
    }
  }
  return out;
}

/**
 * Claim scope (§17, §43): the platforms a claim may be used on. Stored upper-case; the export platforms plus
 * YouTube and organic posts. Merchant-facing shorthands expand: META = Reels + Feed.
 */
export const ClaimPlatform = [...Platform, 'YOUTUBE', 'ORGANIC'] as const;
export type ClaimPlatform = (typeof ClaimPlatform)[number];
export const CLAIM_PLATFORM_ALIASES: Record<string, readonly ClaimPlatform[]> = {
  META: ['INSTAGRAM_REELS', 'FACEBOOK_FEED'],
  INSTAGRAM: ['INSTAGRAM_REELS'],
  REELS: ['INSTAGRAM_REELS'],
  FACEBOOK: ['FACEBOOK_FEED'],
  FEED: ['FACEBOOK_FEED'],
  YOUTUBE_SHORTS: ['YOUTUBE'],
};

/** Normalise a platform scope (any case, aliases) to stored values; unknown values are refused, never guessed. */
export function normalizeClaimPlatforms(input: readonly string[]): ClaimPlatform[] {
  const out = new Set<ClaimPlatform>();
  for (const raw of input) {
    const v = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
    const expanded = CLAIM_PLATFORM_ALIASES[v] ?? ((ClaimPlatform as readonly string[]).includes(v) ? [v as ClaimPlatform] : null);
    if (!expanded) throw new DomainError('INVALID', `Unknown platform “${raw}”.`, { platform: raw });
    for (const p of expanded) out.add(p);
  }
  return ClaimPlatform.filter((p) => out.has(p));
}

/** Markets are ISO-style upper-case codes (US, GB, EU…); US approval never implies another market (§43). */
export function normalizeMarkets(input: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of input) {
    const v = raw.trim().toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(v)) throw new DomainError('INVALID', `Unknown market “${raw}”.`, { market: raw });
    out.add(v);
  }
  return [...out];
}

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

/** Churn-risk indicators (plan 05 §17, standard §10). Persisted in risk_flags.indicator; each maps to a playbook. */
export const RiskIndicator = [
  'idle_7d',
  'paid_no_export',
  'repeated_qa_rejects',
  'ignored_recommendations',
  'ad_account_disconnected',
  'stockout',
  'low_utilisation',
  'high_utilisation_friction',
  'no_performance_linked_test',
  'negative_support_sentiment',
] as const;
export type RiskIndicator = (typeof RiskIndicator)[number];

/** Privacy queue kinds (plan 05 §21). */
export const DataRequestKind = ['access', 'export', 'delete_workspace', 'delete_user', 'delete_person_in_reviews'] as const;
export type DataRequestKind = (typeof DataRequestKind)[number];

/** Refund reason codes (plan 05 §7 refund tool). */
export const RefundReason = ['requested_by_customer', 'duplicate', 'service_failure', 'goodwill', 'fraudulent', 'other'] as const;
export type RefundReason = (typeof RefundReason)[number];
