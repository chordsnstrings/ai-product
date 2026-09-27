import { formatDate, formatDateTime } from '@arkiv/shared/format';
import { formatUsd, type WorkspaceState } from '@arkiv/shared';

/**
 * The billing page's "no plan" panel (plan 02 §2, standard §5): what a workspace without a subscription can buy
 * today, stated from its lifecycle state and its live quote — never a constant price.
 *  - CANCELLED: "Read + export + reactivate" — when the plan ended, how long the archive is kept, and reactivation.
 *    No per-ad price: a cancelled workspace can't buy one-off ads.
 *  - a hold (SUSPENDED / LOCKED) or pending deletion: nothing to buy, and why.
 *  - otherwise: the one-off price actually quoted, with an intro offer's end time while it runs.
 */
export type NoPlanPanel =
  | { kind: 'cancelled'; title: string; body: string; cta: { href: string; label: string } }
  | { kind: 'held'; title: string; body: string; cta: null }
  | { kind: 'per_ad'; title: string; body: string; cta: { href: string; label: string } };

export interface NoPlanInput {
  state: WorkspaceState;
  cancelledAt: Date | string | null;
  archiveDays: number;
  quote: { kind: 'taste' | 'standalone'; priceMicros: number; status: string; expiresAt: string | null };
  /** The price after an intro offer ends (the live standalone or next-offer price). */
  afterMicros: number;
}

export function noPlanPanel(i: NoPlanInput): NoPlanPanel {
  if (i.state === 'CANCELLED') {
    const ended = i.cancelledAt ? new Date(i.cancelledAt) : null;
    const keptUntil = ended ? new Date(ended.getTime() + i.archiveDays * 86_400_000) : null;
    return {
      kind: 'cancelled',
      title: 'Your plan has ended',
      body: `${ended ? `Your plan ended on ${formatDate(ended)}. ` : 'Your plan has ended. '}Your archive — products, tests, results and finished ads — is kept${keptUntil ? ` until ${formatDate(keptUntil)}` : ` for ${i.archiveDays} days`}, and you can export it anytime. Reactivate a plan to make new ads.`,
      cta: { href: '/app/plan', label: 'Reactivate' },
    };
  }
  if (i.state === 'SUSPENDED' || i.state === 'LOCKED' || i.state === 'PURGE_SCHEDULED' || i.state === 'PURGED') {
    return {
      kind: 'held',
      title: 'No plan',
      body: i.state === 'PURGE_SCHEDULED' ? 'This workspace is scheduled for deletion. Cancel the deletion first to choose a plan.' : 'This workspace is on hold, so nothing can be bought right now.',
      cta: null,
    };
  }
  const intro = i.quote.kind === 'taste' && i.quote.status === 'active';
  const price = formatUsd(i.quote.priceMicros, 0);
  const body = intro
    ? `Your first ad is ${price} (intro price${i.quote.expiresAt ? ` until ${formatDateTime(i.quote.expiresAt)}` : ''}), then ${formatUsd(i.afterMicros, 0)} per ad. Choose a plan to test continuously.`
    : `You’re paying per ad (${price} each). Choose a plan to test continuously.`;
  return { kind: 'per_ad', title: 'No plan', body, cta: { href: '/app/plan', label: 'See plans' } };
}
