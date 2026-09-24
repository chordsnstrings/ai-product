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

export async function available(tx: Tx, unit: LedgerUnit): Promise<number> {
  const [r] = await tx`select coalesce(sum(amount), 0)::bigint as n from ledger_entries
                       where unit = ${unit} and type in ${tx([...BALANCE_TYPES])}`;
  return Number(r!.n);
}

export interface Balances {
  creativeTests: number;
  taste: number;
  standalone: number;
}

export async function balances(tx: Tx): Promise<Balances> {
  const rows = await tx`select unit, coalesce(sum(amount), 0)::bigint as n from ledger_entries
                        where type in ${tx([...BALANCE_TYPES])} group by unit`;
  const by = Object.fromEntries(rows.map((r) => [r.unit as string, Number(r.n)]));
  return { creativeTests: by.creative_test ?? 0, taste: by.taste ?? 0, standalone: by.standalone ?? 0 };
}

/** Period usage for the "4 of 7 tests left" meter. */
export async function periodUsage(tx: Tx, periodKey: string) {
  const [r] = await tx`
    select
      coalesce(sum(amount) filter (where type = 'CREDIT_GRANTED'), 0)::bigint as granted,
      coalesce(sum(-amount) filter (where type = 'CREDIT_RESERVED'), 0)::bigint as reserved,
      coalesce(sum(amount) filter (where type in ('CREDIT_RELEASED','CREDIT_REFUNDED')), 0)::bigint as returned
    from ledger_entries where unit = 'creative_test' and period_key = ${periodKey}`;
  const granted = Number(r!.granted);
  const used = Number(r!.reserved) - Number(r!.returned);
  return { granted, used, remaining: Math.max(0, granted - used) };
}

/** Provider spend (COGS) in micros since a timestamp. */
export async function providerSpendSince(tx: Tx, since: Date): Promise<number> {
  const [r] = await tx`select coalesce(sum(amount), 0)::bigint as n from ledger_entries
                       where type = 'PROVIDER_COST_RECORDED' and created_at >= ${since}`;
  return Number(r!.n);
}

/** Expire unused creative tests of a finished period (no rollover in V1). Idempotent per period. */
export async function expirePeriod(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, periodKey: string) {
  const u = await periodUsage(tx, periodKey);
  if (u.remaining <= 0) return 0;
  await append(tx, ctx, {
    type: 'CREDIT_EXPIRED',
    unit: 'creative_test',
    amount: -u.remaining,
    periodKey,
    idempotencyKey: `expire:${periodKey}`,
    reason: 'Unused Creative Tests expire at period end',
  });
  return u.remaining;
}

/** Staff adjustments must carry a reason; four-eyes is enforced by the admin app above a threshold. */
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
  if (amount < 0 && (await available(tx, unit)) + amount < 0)
    throw new DomainError('CONFLICT', 'Adjustment would make the balance negative');
  return append(tx, ctx, { type: 'CREDIT_ADJUSTED', unit, amount, reason, idempotencyKey });
}
