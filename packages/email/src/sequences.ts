import { MARKETING_TEMPLATES, type TemplateName } from './templates';

/**
 * Lifecycle sequences (plan 05 §18): what triggers each automated email, who gets it, and the caps that apply. The
 * worker's schedules read their timing from here, and the console lists it read-only, so the two can't drift.
 */
export interface LifecycleSequence {
  key: string;
  template: TemplateName;
  trigger: string;
  audience: string;
  /** When it goes out relative to the trigger (hours; negative = before, e.g. before an offer ends). */
  delayHours: number;
  caps: string;
}

export const SEQUENCES = [
  {
    key: 'offer_ending',
    template: 'offer_ending',
    trigger: 'Taste offer window about to close (storyboard ready, no purchase)',
    audience: 'Owner of the preview; no purchase in the workspace; under the 3-email recovery cap',
    delayHours: -0.25,
    caps: 'Once per offer; at most 3 recovery emails per project',
  },
  {
    key: 'storyboard_saved',
    template: 'storyboard_saved',
    trigger: 'Storyboard ready but no purchase within the offer window',
    audience: 'Owner of the preview; no purchase in the workspace; under the recovery cap; not unsubscribed',
    delayHours: 24,
    caps: 'Marketing: max 1/day and 3/week per address; quiet hours 20:00–08:00 workspace time',
  },
  {
    key: 'new_concept',
    template: 'new_concept',
    trigger: 'Storyboard still not produced 3 days later (a fresh concept is drafted first)',
    audience: 'Signed-up workspaces (free or paid) with no purchase; under the recovery cap; not unsubscribed',
    delayHours: 72,
    caps: 'Marketing: max 1/day and 3/week per address; quiet hours 20:00–08:00 workspace time',
  },
  {
    key: 'day30_review',
    template: 'day30_review',
    trigger: 'Day 30 after a SKU’s first paid production or test (standard §9)',
    audience: 'Owners and admins of active workspaces',
    delayHours: 30 * 24,
    caps: 'Once per SKU',
  },
  {
    key: 'weekly_brief',
    template: 'weekly_brief',
    trigger: 'Weekly recommendations are ready (Monday)',
    audience: 'Owners and admins of workspaces with open recommendations',
    delayHours: 0,
    caps: 'Once per workspace per week',
  },
] as const satisfies readonly LifecycleSequence[];

export type SequenceKey = (typeof SEQUENCES)[number]['key'];
export const sequence = (key: SequenceKey): LifecycleSequence => SEQUENCES.find((s) => s.key === key)!;

/** Marketing email is not sent between these local hours (plan 05 §18 "quiet hours by workspace timezone"). */
export const QUIET_HOURS = { start: 20, end: 8 } as const;

/** Local hour and minute in a timezone (UTC when the zone is unknown). */
function localTime(timezone: string | null | undefined, now: Date): { hour: number; minute: number } {
  let tz = timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: get('hour') % 24, minute: get('minute') };
}

/**
 * When a marketing email may go out: null to send now, or the time quiet hours end (08:00 in the workspace's
 * timezone). Transactional email is never held.
 */
export function quietHoursDelay(template: TemplateName, timezone: string | null | undefined, now = new Date()): Date | null {
  if (!MARKETING_TEMPLATES.has(template)) return null;
  const { hour, minute } = localTime(timezone, now);
  if (hour >= QUIET_HOURS.end && hour < QUIET_HOURS.start) return null;
  const hoursLeft = hour >= QUIET_HOURS.start ? 24 - hour + QUIET_HOURS.end : QUIET_HOURS.end - hour;
  return new Date(now.getTime() + (hoursLeft * 60 - minute) * 60_000);
}
