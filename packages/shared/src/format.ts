/**
 * House date/time format (design system §6): dates as `23 Sep 2026`, times as `14:02 ET`. Customer surfaces use
 * US Eastern time; staff surfaces pass the console timezone. Output never depends on the viewer's locale or clock
 * zone, so server- and client-rendered markup agree.
 */

export const DEFAULT_TZ = 'America/New_York';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Short, familiar labels for the zones we show; anything else falls back to the platform's short name. */
const TZ_LABEL: Record<string, string> = {
  'America/New_York': 'ET',
  'America/Detroit': 'ET',
  'America/Toronto': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Phoenix': 'MT',
  'America/Los_Angeles': 'PT',
  UTC: 'UTC',
  'Etc/UTC': 'UTC',
};

type DateInput = Date | string | number;

function toDate(v: DateInput): Date | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parts(d: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** `America/New_York` → `ET`; unknown zones use the platform's short name (e.g. `GMT+1`). */
export function tzLabel(timeZone: string = DEFAULT_TZ, at: Date = new Date()): string {
  return TZ_LABEL[timeZone] ?? parts(at, timeZone, { timeZoneName: 'short' }).timeZoneName ?? timeZone;
}

/** `23 Sep 2026` (or `23 Sep` with `{ year: false }`). Empty string for a missing/invalid date. */
export function formatDate(v: DateInput | null | undefined, opts: { timeZone?: string; year?: boolean } = {}): string {
  const d = v == null ? null : toDate(v);
  if (!d) return '';
  // A calendar date ("2026-09-23") has no time or zone: it is that day everywhere, not UTC midnight.
  const calendar = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const p = parts(d, calendar ? 'UTC' : (opts.timeZone ?? DEFAULT_TZ), { day: 'numeric', month: 'numeric', year: 'numeric' });
  const day = `${Number(p.day)} ${MONTHS[Number(p.month) - 1]}`;
  return opts.year === false ? day : `${day} ${p.year}`;
}

/** `14:02 ET` (24-hour; `{ seconds: true }` → `14:02:09 ET`; `{ zone: false }` drops the label). */
export function formatTime(v: DateInput | null | undefined, opts: { timeZone?: string; seconds?: boolean; zone?: boolean } = {}): string {
  const d = v == null ? null : toDate(v);
  if (!d) return '';
  const tz = opts.timeZone ?? DEFAULT_TZ;
  const p = parts(d, tz, { hour: '2-digit', minute: '2-digit', second: opts.seconds ? '2-digit' : undefined, hourCycle: 'h23' });
  const hh = p.hour === '24' ? '00' : p.hour;
  const clock = `${hh}:${p.minute}${opts.seconds ? `:${p.second}` : ''}`;
  return opts.zone === false ? clock : `${clock} ${tzLabel(tz, d)}`;
}

/** `23 Sep 2026 14:02 ET`. */
export function formatDateTime(v: DateInput | null | undefined, opts: { timeZone?: string } = {}): string {
  const d = v == null ? null : toDate(v);
  if (!d) return '';
  return `${formatDate(d, opts)} ${formatTime(d, opts)}`;
}
