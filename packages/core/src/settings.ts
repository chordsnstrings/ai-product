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
