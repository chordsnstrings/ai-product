import type { Tx } from '@arkiv/db';
import { setting } from './settings';

/**
 * Economics and learning metrics (standard Appendix C, §49). Staff-side aggregates read under the admin role; every
 * query names its workspace filter explicitly (test workspaces are left out unless asked for).
 */

export interface MetricScope {
  /** Rolling window in days. */
  days: number;
  includeTest?: boolean;
  /** One tenant's metric (admin tenant page); the whole platform when absent. */
  workspaceId?: string | null;
}

const scopeSql = (tx: Tx, s: MetricScope, col: string) =>
  tx`${s.includeTest ? tx`` : tx`and ${tx(col)} not in (select id from workspaces where is_test)`} ${s.workspaceId ? tx`and ${tx(col)} = ${s.workspaceId}` : tx``}`;

/** Days a Taste buyer can still ask for a refund: sales younger than this carry an expected refund. */
export const TASTE_REFUND_WINDOW_DAYS = 30;
/** Expected refund rate when there is no settled history yet. */
export const DEFAULT_TASTE_REFUND_RATE = 0.05;

export interface TasteContribution {
  purchases: number;
  grossMicros: number;
  refundedMicros: number;
  /** Refund rate of settled Taste sales (older than the refund window, last 180 days). */
  expectedRefundRate: number;
  expectedRefundsMicros: number;
  cogsMicros: number;
  paymentFeeMicros: number;
  contributionMicros: number;
  perTasteMicros: number | null;
}

/**
 * Taste contribution (Appendix C: "Taste net revenue after expected refunds − output COGS − payment fee
 * allocation"): paid Taste sales in the window, less refunds made, less the expected refunds of sales still inside
 * the refund window (at the settled refund rate), less the provider cost of producing those Tastes after purchase,
 * less the payment fee (basis points + fixed per charge, platform settings).
 */
export async function tasteContribution(tx: Tx, scope: MetricScope): Promise<TasteContribution> {
  const [r] = await tx`
    with taste as (
      select p.workspace_id, p.project_id, p.paid_at, p.amount_micros::bigint as amount, coalesce(p.refunded_micros, 0)::bigint as refunded
      from purchases p where p.kind = 'taste' and p.status in ('paid', 'refunded') and p.paid_at > now() - make_interval(days => ${scope.days}) ${scopeSql(tx, scope, 'p.workspace_id')})
    select count(*)::int as n, coalesce(sum(amount), 0)::bigint as gross, coalesce(sum(refunded), 0)::bigint as refunded,
           coalesce(sum(amount - refunded) filter (where refunded = 0 and paid_at > now() - make_interval(days => ${TASTE_REFUND_WINDOW_DAYS})), 0)::bigint as open_recent,
           coalesce((select sum(l.amount) from ledger_entries l join taste t on t.workspace_id = l.workspace_id and t.project_id = l.project_id
                     where l.type = 'PROVIDER_COST_RECORDED' and l.created_at >= t.paid_at), 0)::bigint as cogs
    from taste`;
  const [h] = await tx`
    select coalesce(sum(p.amount_micros), 0)::bigint as gross, coalesce(sum(coalesce(p.refunded_micros, 0)), 0)::bigint as refunded from purchases p
    where p.kind = 'taste' and p.status in ('paid', 'refunded')
      and p.paid_at <= now() - make_interval(days => ${TASTE_REFUND_WINDOW_DAYS}) and p.paid_at > now() - interval '180 days' ${scopeSql(tx, { ...scope, workspaceId: null }, 'p.workspace_id')}`;
  const settledGross = Number(h?.gross ?? 0);
  const expectedRefundRate = settledGross > 0 ? Number(h!.refunded) / settledGross : DEFAULT_TASTE_REFUND_RATE;
  const bps = await setting(tx, 'finance.payment_fee_bps');
  const fixed = await setting(tx, 'finance.payment_fee_fixed_micros');
  const n = Number(r?.n ?? 0);
  const gross = Number(r?.gross ?? 0);
  const refunded = Number(r?.refunded ?? 0);
  const expectedRefundsMicros = Math.round(Number(r?.open_recent ?? 0) * expectedRefundRate);
  const cogsMicros = Number(r?.cogs ?? 0);
  const paymentFeeMicros = Math.round((gross * bps) / 10_000) + n * fixed;
  const contributionMicros = gross - refunded - expectedRefundsMicros - cogsMicros - paymentFeeMicros;
  return {
    purchases: n,
    grossMicros: gross,
    refundedMicros: refunded,
    expectedRefundRate: Math.round(expectedRefundRate * 10_000) / 10_000,
    expectedRefundsMicros,
    cogsMicros,
    paymentFeeMicros,
    contributionMicros,
    perTasteMicros: n ? Math.round(contributionMicros / n) : null,
  };
}

export interface LearningVelocity {
  /** Experiments that first reached Directional or Actionable in the window. */
  experiments: number;
  activeSkus: number;
  /** Experiments per active SKU per 30 days (Appendix C). */
  perSkuPerMonth: number | null;
}

/**
 * Learning velocity (Appendix C: "experiments reaching Directional or Actionable learning state per active SKU per
 * month"; §49 North Star): an experiment counts once, in the window where it FIRST reached either state; active SKUs
 * are the active products of workspaces with a live subscription or experiment activity in the window. Normalized
 * to 30 days.
 */
export async function learningVelocity(tx: Tx, scope: MetricScope): Promise<LearningVelocity> {
  const [r] = await tx`
    with firsts as (
      select e.subject_id, min(e.at) as at from events e
      where e.type = 'EXPERIMENT_STATE_CHANGED' and e.payload->>'to' in ('DIRECTIONAL', 'ACTIONABLE') ${scopeSql(tx, scope, 'e.workspace_id')}
      group by e.subject_id)
    select (select count(*) from firsts where at > now() - make_interval(days => ${scope.days}))::int as n,
           (select count(*) from skus s where s.status = 'active' ${scopeSql(tx, scope, 's.workspace_id')}
              and (exists (select 1 from subscriptions b where b.workspace_id = s.workspace_id and b.status in ('active', 'trialing', 'past_due'))
                   or exists (select 1 from events x where x.workspace_id = s.workspace_id and x.type like 'EXPERIMENT_%' and x.at > now() - make_interval(days => ${scope.days}))))::int as skus`;
  const experiments = Number(r?.n ?? 0);
  const activeSkus = Number(r?.skus ?? 0);
  return { experiments, activeSkus, perSkuPerMonth: activeSkus ? Math.round((experiments / activeSkus) * (30 / scope.days) * 100) / 100 : null };
}
