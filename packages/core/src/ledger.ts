import type { Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { emit } from './events';
import type { TenantContext } from './context';
import { actorString } from './context';

/**
 * Usage Ledger (§37). Append-only; balances are always derived.
 * Amounts are signed. Entitlement-affecting types are summed for "available"; CONSUMED, FREE_QA_RETRY and
 * PROVIDER_COST_RECORDED are informational (reporting / COGS) and never change what a customer can spend.
 */
export type LedgerUnit = 'creative_test' | 'taste' | 'standalone' | 'usd_micros';
export type LedgerType =
  | 'CREDIT_GRANTED'
  | 'CREDIT_RESERVED'
  | 'CREDIT_CONSUMED'
  | 'CREDIT_RELEASED'
  | 'CREDIT_REFUNDED'
  | 'CREDIT_EXPIRED'
  | 'CREDIT_ADJUSTED'
  | 'FREE_QA_RETRY'
  | 'PROVIDER_COST_RECORDED';

/** Entry types that change the available balance (the rest are informational). */
export const BALANCE_TYPES: readonly LedgerType[] = [
  'CREDIT_GRANTED',
  'CREDIT_RESERVED',
  'CREDIT_RELEASED',
  'CREDIT_REFUNDED',
  'CREDIT_EXPIRED',
  'CREDIT_ADJUSTED',
];

export interface LedgerEntryInput {
  type: LedgerType;
  unit: LedgerUnit;
  amount: number;
  idempotencyKey: string;
  authorizationId?: string | null;
  projectId?: string | null;
  providerJobId?: string | null;
  periodKey?: string | null;
  reference?: string | null;
  reason?: string | null;
}

/** Append one entry. Duplicate idempotency keys are a no-op (duplicate webhooks/callbacks can't double-settle). */
export async function append(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  e: LedgerEntryInput,
): Promise<boolean> {
  const rows = await tx`
    insert into ledger_entries (workspace_id, type, unit, amount, authorization_id, project_id, provider_job_id,
      period_key, reference, reason, actor, idempotency_key)
    values (${ctx.workspaceId}, ${e.type}, ${e.unit}, ${e.amount}, ${e.authorizationId ?? null}, ${e.projectId ?? null},
      ${e.providerJobId ?? null}, ${e.periodKey ?? null}, ${e.reference ?? null}, ${e.reason ?? null},
      ${actorString(ctx)}, ${e.idempotencyKey})
    on conflict (workspace_id, idempotency_key) do nothing
    returning id`;
  if (rows.length && e.type !== 'PROVIDER_COST_RECORDED') {
    await emit(
      tx,
      ctx,
      e.type,
      e.projectId ? { type: 'project', id: e.projectId } : null,
      { unit: e.unit, amount: e.amount, ledgerType: e.type, reference: e.reference, periodKey: e.periodKey ?? null },
      { ledgerEntryId: rows[0]!.id as string, authorizationId: e.authorizationId, providerJobId: e.providerJobId },
    );
  }
  return rows.length > 0;
}

/**
 * Serializes every check-then-append on a workspace's entitlement balance (x-races-01): a reservation, a negative
 * adjustment, a period expiry, a refund withdrawal and a plan-change grant take it before reading the balance and
 * hold it to the end of their transaction, so two of them can never both spend the last unit. Lock order: a
 * caller that also locks the project row takes that first.
 */
export async function lockEntitlement(tx: Tx, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${`entitlement:${workspaceId}`}))`;
}

/**
 * Pass `workspaceId` whenever the caller may run as a role whose policies are not tenant-scoped (staff, system):
 * RLS alone would then sum every tenant's ledger.
 */
const inWorkspace = (tx: Tx, workspaceId?: string | null) => (workspaceId ? tx`and workspace_id = ${workspaceId}` : tx``);

export async function available(tx: Tx, unit: LedgerUnit, workspaceId?: string | null): Promise<number> {
  const [r] = await tx`select coalesce(sum(amount), 0)::bigint as n from ledger_entries
                       where unit = ${unit} and type in ${tx([...BALANCE_TYPES])} ${inWorkspace(tx, workspaceId)}`;
  return Number(r!.n);
}

export interface Balances {
  creativeTests: number;
  taste: number;
  standalone: number;
}

export async function balances(tx: Tx, workspaceId?: string | null): Promise<Balances> {
  const rows = await tx`select unit, coalesce(sum(amount), 0)::bigint as n from ledger_entries
                        where type in ${tx([...BALANCE_TYPES])} ${inWorkspace(tx, workspaceId)} group by unit`;
  const by = Object.fromEntries(rows.map((r) => [r.unit as string, Number(r.n)]));
  return { creativeTests: by.creative_test ?? 0, taste: by.taste ?? 0, standalone: by.standalone ?? 0 };
}

/**
 * Period usage for the "4 of 7 tests left" meter. `remaining` is the period's share of the balance (every balance
 * entry carrying this period key: grants and staff adjustments, reservations and what came back, expiry), so the
 * meter and available() agree once earlier periods are expired (§37 "balance can be derived from the ledger").
 */
export async function periodUsage(tx: Tx, periodKey: string, workspaceId?: string | null) {
  const [r] = await tx`
    select
      coalesce(sum(amount) filter (where type in ('CREDIT_GRANTED','CREDIT_ADJUSTED')), 0)::bigint as granted,
      coalesce(sum(-amount) filter (where type = 'CREDIT_RESERVED'), 0)::bigint as reserved,
      coalesce(sum(amount) filter (where type in ('CREDIT_RELEASED','CREDIT_REFUNDED')), 0)::bigint as returned,
      coalesce(sum(-amount) filter (where type = 'CREDIT_EXPIRED'), 0)::bigint as expired
    from ledger_entries where unit = 'creative_test' and period_key = ${periodKey} ${inWorkspace(tx, workspaceId)}`;
  const granted = Number(r!.granted);
  const used = Number(r!.reserved) - Number(r!.returned);
  const expired = Number(r!.expired);
  return { granted, used, expired, remaining: Math.max(0, granted - used - expired) };
}

/**
 * The key (UTC date of its start) of the live subscription's current billing period, or null: the key the period
 * grant, reservations, staff adjustments and the meter all use.
 */
export async function currentPeriodKey(tx: Tx, workspaceId: string): Promise<string | null> {
  const [s] = await tx`select to_char(current_period_start at time zone 'UTC', 'YYYY-MM-DD') as k from subscriptions
                       where workspace_id = ${workspaceId} and status in ('active','trialing','past_due') and current_period_start is not null
                       order by created_at desc limit 1`;
  return (s?.k as string) ?? null;
}

/** Provider spend (COGS) in micros since a timestamp. */
export async function providerSpendSince(tx: Tx, since: Date, workspaceId?: string | null): Promise<number> {
  const [r] = await tx`select coalesce(sum(amount), 0)::bigint as n from ledger_entries
                       where type = 'PROVIDER_COST_RECORDED' and created_at >= ${since} ${inWorkspace(tx, workspaceId)}`;
  return Number(r!.n);
}

/**
 * Expire unused creative tests of a finished period (no rollover in V1). Idempotent: once a period is expired,
 * calling it again writes nothing, unless something came back to the period since (a reservation released after
 * the period ended), which then expires too, under its own key.
 */
export async function expirePeriod(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, periodKey: string) {
  await lockEntitlement(tx, ctx.workspaceId);
  const u = await periodUsage(tx, periodKey, ctx.workspaceId);
  if (u.remaining <= 0) return 0;
  const [n] = await tx`select count(*)::int as n from ledger_entries where workspace_id = ${ctx.workspaceId} and unit = 'creative_test'
                         and type = 'CREDIT_EXPIRED' and period_key = ${periodKey}`;
  const prior = Number(n!.n);
  await append(tx, ctx, {
    type: 'CREDIT_EXPIRED',
    unit: 'creative_test',
    amount: -u.remaining,
    periodKey,
    idempotencyKey: prior === 0 ? `expire:${periodKey}` : `expire:${periodKey}:${prior}`,
    reason: prior === 0 ? 'Unused Creative Tests expire at period end' : 'Returned to a period that has already ended',
  });
  return u.remaining;
}

/** Has this period's leftover already been expired (the period ended)? */
export async function periodExpired(tx: Tx, workspaceId: string, periodKey: string): Promise<boolean> {
  const [r] = await tx`select 1 from ledger_entries where workspace_id = ${workspaceId} and unit = 'creative_test' and type = 'CREDIT_EXPIRED'
                         and period_key = ${periodKey} limit 1`;
  return !!r;
}

/**
 * Staff adjustments must carry a reason; four-eyes is enforced by the admin app above a threshold. Scoped to
 * ctx.workspaceId explicitly: the console runs this as admin_rw, whose policies see every tenant. A Creative Test
 * adjustment belongs to the current plan period, so it shows on the meter and expires with the period's own tests.
 */
export async function adjust(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  unit: LedgerUnit,
  amount: number,
  reason: string,
  idempotencyKey: string,
) {
  if (!reason.trim()) throw new DomainError('INVALID', 'Adjustments require a reason');
  if (unit === 'usd_micros') throw new DomainError('INVALID', 'Provider cost cannot be adjusted; record a correction instead');
  await lockEntitlement(tx, ctx.workspaceId);
  const periodKey = unit === 'creative_test' ? await currentPeriodKey(tx, ctx.workspaceId) : null;
  if (amount < 0) {
    let have = await available(tx, unit, ctx.workspaceId);
    if (periodKey) have = Math.min(have, (await periodUsage(tx, periodKey, ctx.workspaceId)).remaining);
    if (have + amount < 0) throw new DomainError('CONFLICT', 'Adjustment would make the balance negative');
  }
  return append(tx, ctx, { type: 'CREDIT_ADJUSTED', unit, amount, reason, idempotencyKey, periodKey });
}
