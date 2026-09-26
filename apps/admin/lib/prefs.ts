import { cache } from 'react';
import { cookies } from 'next/headers';

/**
 * Console-wide preferences (plan 05 §1 "Global date and timezone selector (default America/New_York; stored
 * UTC)", §2.3 "is_test is filterable everywhere and defaults to excluded"). Cookies set by the nav control.
 */
export const DEFAULT_TZ = 'America/New_York';
export const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Sao_Paulo',
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;
export const RANGES = [1, 7, 30] as const;

export interface ConsolePrefs {
  tz: string;
  range: (typeof RANGES)[number];
  includeTest: boolean;
}

/** Parse raw cookie values; anything unknown falls back to the defaults (the tz also reaches SQL). */
export function parsePrefs(raw: { tz?: string | null; range?: string | null; test?: string | null }): ConsolePrefs {
  const tz = (TIMEZONES as readonly string[]).includes(raw.tz ?? '') ? raw.tz! : DEFAULT_TZ;
  const r = Number(raw.range);
  const range = (RANGES as readonly number[]).includes(r) ? (r as ConsolePrefs['range']) : 7;
  return { tz, range, includeTest: raw.test === '1' };
}

/** Per-request holder read synchronously by the date formatters in components/ui. */
export const requestTz = cache(() => ({ tz: DEFAULT_TZ }));

export const consolePrefs = cache(async (): Promise<ConsolePrefs> => {
  const c = await cookies();
  const p = parsePrefs({ tz: c.get('ak_tz')?.value, range: c.get('ak_range')?.value, test: c.get('ak_test')?.value });
  requestTz().tz = p.tz;
  return p;
});

/** A page's day window: an explicit ?days= / ?range= wins over the console-wide range. */
export function daysFrom(param: string | undefined, prefs: ConsolePrefs, max = 365): number {
  const n = Number(param);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : prefs.range;
}
