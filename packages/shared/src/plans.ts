import type { PlanCode } from './enums';
import { usd, type Micros } from './core';

/** Commercial constants (standard §5, plan 02 §4). Stripe Price IDs come from env. */
export interface PlanSpec {
  code: PlanCode;
  name: string;
  priceMicros: Micros;
  creativeTestsPerMonth: number;
  brands: number;
  members: number;
  renderConcurrency: number;
  storageGb: number;
}

export const PLANS: Record<PlanCode, PlanSpec> = {
  LAUNCH: {
    code: 'LAUNCH',
    name: 'Launch',
    priceMicros: usd(49),
    creativeTestsPerMonth: 3,
    brands: 1,
    members: 2,
    renderConcurrency: 2,
    storageGb: 5,
  },
  GROWTH: {
    code: 'GROWTH',
    name: 'Growth',
    priceMicros: usd(99),
    creativeTestsPerMonth: 7,
    brands: 1,
    members: 5,
    renderConcurrency: 3,
    storageGb: 20,
  },
  SCALE: {
    code: 'SCALE',
    name: 'Scale',
    priceMicros: usd(199),
    creativeTestsPerMonth: 16,
    brands: 3,
    members: 10,
    renderConcurrency: 5,
    storageGb: 50,
  },
};

/** Defaults for workspaces without a subscription (free / Taste buyers). */
export const FREE_LIMITS = { brands: 1, members: 2, renderConcurrency: 1, storageGb: 2 } as const;

export const PRICES = {
  TASTE: usd(19),
  STANDALONE: usd(29),
} as const;

export const COST_LIMITS = {
  /** Free preview COGS cap per provisional/free SKU (standard §5). */
  FREE_PREVIEW_CAP: usd(0.2),
  /** Storyboard preview (account-gated, pre-payment): LLM plan + at most 2 generated frames. */
  STORYBOARD_CAP: usd(0.25),
  /** Standard Creative Test variable COGS ceiling (standard §5, V1.1). */
  CREATIVE_TEST_CEILING: usd(8.5),
  /** QA retry reserve as fraction of raw video cost (standard §6). */
  RETRY_RESERVE_FRACTION: 0.25,
  /** Daily anomaly guard = multiple of expected daily COGS (plan 02 §4). */
  DAILY_ANOMALY_MULTIPLE: 3,
  /**
   * Markup floor (standard §33/§37): minimum variable margin of entitlement-bearing work. The Creative Test
   * ceiling keeps Scale (~$12.44 per test) just above it (standard §5: "above ~30% variable margin").
   */
  MIN_VARIABLE_MARGIN: 0.3,
} as const;

export const OFFER_RULES = {
  TASTE_WINDOW_MINUTES: 60,
  STRIPE_MIN_SESSION_MINUTES: 30,
} as const;

/**
 * Pre-purchase exploration for signed-in workspaces that have not paid (standard §5 free preview: analysis,
 * three concepts, a storyboard preview, "target preview COGS <= $0.20"). Signing up unlocks more exploration
 * than a provisional workspace, but still bounded per SKU and per day, and by a cumulative per-SKU cost cap.
 */
export const FREE_EXPLORATION = {
  /** New products a day. */
  SKUS_PER_DAY: 3,
  /** Concept batches per product, including the first three ideas. */
  CONCEPT_BATCHES_PER_SKU: 4,
  /** Storyboards drawn per product (each chosen concept draws one). */
  STORYBOARDS_PER_SKU: 3,
  /** Cumulative pre-purchase generation spend per product (storyboards, frames, extra concepts). */
  SKU_COGS_CAP: usd(1.5),
} as const;

export const PROVISIONAL = {
  TTL_DAYS: 7,
  MAX_SKUS: 3,
  /** Upper bound for staff-allowlisted evaluators (plan 05 §15): still bounded, COGS caps still apply per SKU. */
  ALLOWLISTED_MAX_SKUS: 25,
  MAX_CONCEPT_REGENERATIONS: 1,
} as const;

export const RETENTION = {
  CANCELLED_ARCHIVE_DAYS: 90,
  PURGE_GRACE_DAYS: 7,
  CONSENT_RECORD_YEARS: 3,
} as const;
