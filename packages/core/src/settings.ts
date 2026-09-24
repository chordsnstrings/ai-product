import type { Tx } from '@arkiv/db';
import { COST_LIMITS, FREE_LIMITS, PLANS, RETENTION, type PlanCode } from '@arkiv/shared';

/**
 * Platform settings (plan 05 §20): staff edit them in the console; code constants are the fallback when a
 * key is missing or holds a value of the wrong shape. Reads are cached per process for a short time so hot
 * paths (cost authorization, render leases) don't add a query per call; edits apply within the TTL.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { value: unknown; at: number }>();

export async function getSetting<T>(tx: Tx, key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  let value: unknown;
  if (hit && Date.now() - hit.at < TTL_MS) value = hit.value;
  else {
    const [r] = await tx`select value from platform_settings where key = ${key}`;
    value = r ? r.value : undefined;
    cache.set(key, { value, at: Date.now() });
  }
  if (value === undefined || value === null) return fallback;
  if (typeof value !== typeof fallback) return fallback;
  if (typeof fallback === 'number' && !Number.isFinite(value as number)) return fallback;
  return value as T;
}

/** Drop cached values (after a staff edit in this process, and in tests). */
export function clearSettingsCache(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}

/** Keys the app reads, with their code fallbacks — the console lists these so staff can see what is wired. */
export const SETTING_DEFAULTS = {
  'support.email': 'support@localhost',
  'legal.terms_url': '/legal/terms',
  'legal.privacy_url': '/legal/privacy',
  'retention.cancelled_archive_days': RETENTION.CANCELLED_ARCHIVE_DAYS,
  'retention.purge_grace_days': RETENTION.PURGE_GRACE_DAYS,
  'free_preview.cogs_cap_micros': COST_LIMITS.FREE_PREVIEW_CAP,
  'quota.plan_defaults': {} as Record<string, Partial<PlanQuota>>,
  // Payment fee allocation for Taste contribution / effective CAC (Appendix C): standard card rate.
  'finance.payment_fee_bps': 290,
  'finance.payment_fee_fixed_micros': 300_000,
  // Standard §46 "cancel after dispatch": up to this share of a production's estimate (basis points) already spent
  // on providers, a cancel still returns the credit or payment; past it, the credit is used and nothing is refunded.
  'production.cancel_release_max_spend_bps': 2500,
  // Plan 05 §10 automatic circuit breaker: a route (or a whole provider) whose outage-class error rate reaches
  // `error_rate` over at least `min_calls` finished calls in `window_minutes` is opened for `cooldown_minutes`.
  'circuit.window_minutes': 15,
  'circuit.min_calls': 10,
  'circuit.error_rate': 0.5,
  'circuit.cooldown_minutes': 15,
  // Plan 05 §12 job detail "logs and traces (link out)": URL templates with {jobId}, {queue} and {requestId}.
  'ops.log_url_template': '',
  'ops.trace_url_template': '',
  // Plan 05 §15 rights intake: inbound email to this address (besides rights@, takedown@, copyright@, dmca@, legal@)
  // opens a rights case.
  'rights.intake_address': '',
  // Plan 05 §16: the console warns this many days before an API version in integrations.api_versions is sunset.
  'integrations.sunset_banner_days': 60,
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;

export const setting = <K extends SettingKey>(tx: Tx, key: K) => getSetting(tx, key, SETTING_DEFAULTS[key] as (typeof SETTING_DEFAULTS)[K]);

export interface PlanQuota {
  brands: number;
  members: number;
  renderConcurrency: number;
  storageGb: number;
}

/** Quota defaults per plan (2-multi-tenancy §4): the `quota.plan_defaults` setting over the PLANS constants. */
export async function planQuota(tx: Tx, plan: PlanCode | null | undefined): Promise<PlanQuota & { creativeTestsPerMonth: number }> {
  const base: PlanQuota = plan ? { brands: PLANS[plan].brands, members: PLANS[plan].members, renderConcurrency: PLANS[plan].renderConcurrency, storageGb: PLANS[plan].storageGb } : { ...FREE_LIMITS };
  const overrides = (await setting(tx, 'quota.plan_defaults'))[plan ?? 'FREE'] ?? {};
  const out = { ...base };
  for (const k of Object.keys(base) as (keyof PlanQuota)[]) {
    const v = overrides[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return { ...out, creativeTestsPerMonth: plan ? PLANS[plan].creativeTestsPerMonth : 0 };
}
