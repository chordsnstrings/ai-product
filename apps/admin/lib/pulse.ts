/** Pulse alert rules (plan 05 §1 tile table), kept out of the page so they can be tested. */

/** Open-queue service levels ("Open queues … Counts + oldest age | SLA breach"), in hours from the oldest item. */
export const SLA_HOURS: Record<string, number> = {
  'Restricted claims': 48,
  'QA review': 48,
  'Unmatched Stripe': 24,
  'Data requests': 30 * 24, // statutory 45 days (CCPA); we answer within 30
  'Abuse signals (24h)': 24,
  Approvals: 24,
  // Raised by sweeps and webhooks that changed something on their own (offer auto-paused, experiment stopped…).
  'Platform alerts': 24,
  'Stripe reconciliation': 48,
};

export function slaBreach(queue: string, open: number, oldest: Date | string | null, now = Date.now()): boolean {
  const sla = SLA_HOURS[queue];
  if (!sla || !open || !oldest) return false;
  return (now - new Date(oldest).getTime()) / 3600_000 > sla;
}

/** "Stage conversion −25% vs 7d baseline". */
export const conversionDrop = (current: number, baseline: number) => Number.isFinite(current) && Number.isFinite(baseline) && baseline > 0 && current < baseline * 0.75;

/** "hard-fail > 3%" of QA checks in the window. */
export const hardFailAlert = (hard: number, total: number) => total > 0 && hard / total > 0.03;
