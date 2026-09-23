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
} as const;

export const OFFER_RULES = {
  TASTE_WINDOW_MINUTES: 60,
  STRIPE_MIN_SESSION_MINUTES: 30,
} as const;

export const PROVISIONAL = {
  TTL_DAYS: 7,
  MAX_SKUS: 3,
  MAX_CONCEPT_REGENERATIONS: 1,
} as const;

export const RETENTION = {
  CANCELLED_ARCHIVE_DAYS: 90,
  PURGE_GRACE_DAYS: 7,
  CONSENT_RECORD_YEARS: 3,
} as const;
