import { createHash, randomBytes } from 'node:crypto';
import type { Tx } from '@arkiv/db';
import { COST_LIMITS, DomainError, PLANS, type Micros, type PlanCode } from '@arkiv/shared';
import type { TenantContext } from './context';
import { append, available, providerSpendSince, type LedgerUnit } from './ledger';
import { estimate as priceEstimate, loadRates, type CostLine, type Estimate } from './rates';
import { isFlagOn } from './flags';

/**
 * Cost Governor (§37). No creative or agent may call a billable provider directly: the Production Planner
 * requests an estimate, the Governor checks entitlement, ceilings, anomaly caps and kill switches, writes a
 * reservation and returns an authorization token. The Model Gateway accepts only valid tokens.
 */

export type Purpose = 'free_preview' | 'storyboard' | 'taste' | 'standalone' | 'creative_test' | 'premium' | 'repair';

export interface AuthorizeInput {
  projectId?: string | null;
  skuId?: string | null;
  purpose: Purpose;
  lines: CostLine[];
  /** Customer entitlement to reserve (null for free/internal work). */
  entitlement?: { unit: Exclude<LedgerUnit, 'usd_micros'>; amount: number; periodKey?: string | null } | null;
  ttlMinutes?: number;
  idempotencyKey: string;
}

export interface Authorization {
  authorizationId: string;
  token: string;
  estimate: Estimate;
  maxCostMicros: Micros;
  replayed: boolean;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function estimateCost(tx: Tx, lines: CostLine[]): Promise<Estimate> {
  return priceEstimate(await loadRates(tx), lines);
}

function ceilingFor(purpose: Purpose): Micros | null {
  switch (purpose) {
    case 'creative_test':
    case 'taste':
    case 'standalone':
      return COST_LIMITS.CREATIVE_TEST_CEILING;
    case 'free_preview':
      return COST_LIMITS.FREE_PREVIEW_CAP;
    case 'storyboard':
      return COST_LIMITS.STORYBOARD_CAP;
    default:
      return null;
  }
}

export async function authorize(tx: Tx, ctx: TenantContext, input: AuthorizeInput): Promise<Authorization> {
  // Idempotent: a retried request returns the same reservation (no second hold).
  const [existing] = await tx`select id from cost_authorizations where idempotency_key = ${input.idempotencyKey}`;
  if (existing) {
    // The token is only ever returned once; a replay must not dispatch again (the project state machine guards this).
    throw new DomainError('CONFLICT', 'Authorization already issued for this request', { authorizationId: existing.id });
  }

  if (await isFlagOn(tx, 'kill.renders') && input.purpose !== 'free_preview' && input.purpose !== 'storyboard') {
    throw new DomainError('UNAVAILABLE', 'Production is paused for maintenance. Your place is held.');
  }
  if (input.purpose === 'free_preview' && (await isFlagOn(tx, 'kill.free_preview'))) {
    throw new DomainError('UNAVAILABLE', 'Free previews are paused. Please try again shortly.');
  }

  const est = await estimateCost(tx, input.lines);

  // 1. Ceiling per purpose (standard §5 V1.1 Creative Test ceiling; free preview cap per SKU).
  const ceiling = ceilingFor(input.purpose);
  if (ceiling !== null) {
    let prior = 0;
    if (input.purpose === 'free_preview' && input.skuId) {
      // Active holds count at their ceiling; settled ones at what was actually spent.
      const [r] = await tx`select coalesce(sum(case when status = 'active' then max_cost_micros else spent_micros end), 0)::bigint as n
                           from cost_authorizations
                           where purpose = 'free_preview' and estimate->>'skuId' = ${input.skuId}
                             and status in ('active','settled')`;
      prior = Number(r!.n);
    }
    if (prior + est.totalMicros > ceiling) {
      throw new DomainError('GATE_BLOCKED', 'This plan exceeds the cost ceiling for its class', {
        ceilingMicros: ceiling,
        estimateMicros: est.totalMicros,
        priorMicros: prior,
        purpose: input.purpose,
      });
    }
  }

  // 2. Daily anomaly guard (plan 02 §4): 3x the plan's expected daily COGS.
  const [ws] = await tx`select plan_code from workspaces where id = ${ctx.workspaceId}`;
  const plan = (ws?.plan_code as PlanCode | null) ?? null;
  const expectedDaily = plan
    ? (PLANS[plan].creativeTestsPerMonth * COST_LIMITS.CREATIVE_TEST_CEILING) / 30
    : COST_LIMITS.CREATIVE_TEST_CEILING;
  const since = new Date(Date.now() - 24 * 3600_000);
  const spent24h = await providerSpendSince(tx, since);
  const cap = Math.max(expectedDaily * COST_LIMITS.DAILY_ANOMALY_MULTIPLE, COST_LIMITS.CREATIVE_TEST_CEILING * 2);
  if (spent24h + est.totalMicros > cap) {
    throw new DomainError('UNAVAILABLE', "We're reviewing unusual activity on this workspace. Your work is saved.", {
      anomaly: true,
      spent24h,
      cap,
    });
  }

  // 3. Entitlement.
  if (input.entitlement && input.entitlement.amount > 0) {
    const have = await available(tx, input.entitlement.unit);
    if (have < input.entitlement.amount) {
      throw new DomainError('PAYMENT_REQUIRED', 'No remaining entitlement for this production', {
        unit: input.entitlement.unit,
        available: have,
      });
    }
  }

  const token = randomBytes(24).toString('base64url');
  const ttl = input.ttlMinutes ?? 120;
  const [auth] = await tx`
    insert into cost_authorizations (workspace_id, project_id, purpose, token_hash, idempotency_key, rate_table_versions,
      estimate, max_cost_micros, entitlement_unit, entitlement_amount, expires_at)
    values (${ctx.workspaceId}, ${input.projectId ?? null}, ${input.purpose}, ${hashToken(token)}, ${input.idempotencyKey},
      ${tx.json(est.rateVersions)}, ${tx.json({ ...est, skuId: input.skuId ?? null } as never)}, ${est.totalMicros},
      ${input.entitlement?.unit ?? null}, ${input.entitlement?.amount ?? 0}, now() + make_interval(mins => ${ttl}))
    on conflict (workspace_id, idempotency_key) do nothing
    returning id`;
  if (!auth) {
    // Lost a race with a concurrent request for the same key (e.g. duplicate job delivery): the unique index
    // arbitrates, and the loser gets the same answer as a sequential replay.
    const [winner] = await tx`select id from cost_authorizations where idempotency_key = ${input.idempotencyKey}`;
    throw new DomainError('CONFLICT', 'Authorization already issued for this request', { authorizationId: winner?.id });
  }

  if (input.entitlement && input.entitlement.amount > 0) {
    await append(tx, ctx, {
      type: 'CREDIT_RESERVED',
      unit: input.entitlement.unit,
      amount: -input.entitlement.amount,
      authorizationId: auth!.id,
      projectId: input.projectId,
      periodKey: input.entitlement.periodKey ?? null,
      // Keyed on the authorization itself: a retry creates a new authorization and must reserve again. (Keying on
      // the request key let a retried production skip its reservation — found by the chaos suite.)
      idempotencyKey: `reserve:${auth!.id}`,
    });
  }
  return { authorizationId: auth!.id, token, estimate: est, maxCostMicros: est.totalMicros, replayed: false };
}

/**
 * Authorize for a job that may be a redelivery of an earlier attempt with the same idempotency key.
 *  - an active reservation younger than `staleAfterMinutes` belongs to a live duplicate → CONFLICT (no double spend);
 *  - an older active one was stranded by a crashed worker → released, then reserved again;
 *  - a settled/released one (the earlier attempt failed) → retired so the retry can reserve again.
 * Callers must first check their own durable output (a finished attempt is never redone).
 */
export async function authorizeOrTakeOver(tx: Tx, ctx: TenantContext, input: AuthorizeInput, staleAfterMinutes: number): Promise<Authorization> {
  const [prev] = await tx`select id, status, created_at < now() - make_interval(mins => ${staleAfterMinutes}) as stale
                          from cost_authorizations where workspace_id = ${ctx.workspaceId} and idempotency_key = ${input.idempotencyKey}
                          for update`;
  if (prev) {
    if (prev.status === 'active' && !prev.stale) throw new DomainError('CONFLICT', 'Authorization already issued for this request', { authorizationId: prev.id });
    if (prev.status === 'active') await settle(tx, ctx, prev.id as string, 'released');
    await tx`update cost_authorizations set idempotency_key = idempotency_key || ':retired:' || id::text where id = ${prev.id}`;
  }
  return authorize(tx, ctx, input);
}

/**
 * Called by the Model Gateway before each provider call: validates the token and atomically debits the
 * expected cost of this call against the authorization ceiling.
 */
export async function consumeAuthorization(
  tx: Tx,
  token: string,
  expectedMicros: Micros,
): Promise<{ authorizationId: string; projectId: string | null }> {
  const [a] = await tx`
    update cost_authorizations set spent_micros = spent_micros + ${expectedMicros}
    where token_hash = ${hashToken(token)} and status = 'active' and expires_at > now()
      and spent_micros + ${expectedMicros} <= max_cost_micros
    returning id, project_id`;
  if (!a) {
    const [why] = await tx`select status, expires_at, spent_micros, max_cost_micros from cost_authorizations
                           where token_hash = ${hashToken(token)}`;
    throw new DomainError('FORBIDDEN', 'Provider call not authorized', {
      reason: !why ? 'unknown_token' : why.status !== 'active' ? `status_${why.status}` : 'ceiling_or_expired',
    });
  }
  return { authorizationId: a.id as string, projectId: (a.project_id as string) ?? null };
}

/** Return unused expected cost when a call finishes cheaper than estimated (or fails before spend). */
export async function creditBack(tx: Tx, authorizationId: string, micros: Micros): Promise<void> {
  if (micros <= 0) return;
  await tx`update cost_authorizations set spent_micros = greatest(0, spent_micros - ${micros}) where id = ${authorizationId}`;
}

export type Settlement = 'consumed' | 'released' | 'refunded';

/** Settle once. Later duplicates (callbacks, retries) are no-ops thanks to status guard + ledger idempotency. */
export async function settle(tx: Tx, ctx: TenantContext, authorizationId: string, outcome: Settlement): Promise<boolean> {
  const [a] = await tx`
    update cost_authorizations set status = ${outcome === 'consumed' ? 'settled' : outcome === 'released' ? 'released' : 'refunded'},
      settled_at = now()
    where id = ${authorizationId} and status = 'active'
    returning id, project_id, entitlement_unit, entitlement_amount`;
  if (!a) return false;
  if (a.entitlement_unit && Number(a.entitlement_amount) > 0) {
    const [res] = await tx`select period_key from ledger_entries where authorization_id = ${authorizationId}
                           and type = 'CREDIT_RESERVED' limit 1`;
    const base = {
      unit: a.entitlement_unit as LedgerUnit,
      authorizationId,
      projectId: a.project_id as string | null,
      periodKey: (res?.period_key as string | null) ?? null,
    };
    if (outcome === 'consumed') {
      await append(tx, ctx, { ...base, type: 'CREDIT_CONSUMED', amount: Number(a.entitlement_amount), idempotencyKey: `settle:${authorizationId}` });
    } else {
      await append(tx, ctx, {
        ...base,
        type: outcome === 'released' ? 'CREDIT_RELEASED' : 'CREDIT_REFUNDED',
        amount: Number(a.entitlement_amount),
        idempotencyKey: `settle:${authorizationId}`,
      });
    }
  }
  return true;
}

/** Record realized provider cost (COGS) against the ledger. Idempotent per provider job. */
export async function recordProviderCost(
  tx: Tx,
  ctx: TenantContext,
  providerJobId: string,
  micros: Micros,
  projectId: string | null,
  authorizationId: string | null,
): Promise<void> {
  await append(tx, ctx, {
    type: 'PROVIDER_COST_RECORDED',
    unit: 'usd_micros',
    amount: micros,
    providerJobId,
    projectId,
    authorizationId,
    idempotencyKey: `cost:${providerJobId}`,
  });
}

/** Sweeper (§39): crashed workers must not strand entitlement. Runs as system across tenants. */
export async function sweepExpiredAuthorizations(tx: Tx): Promise<number> {
  const rows = await tx`select id, workspace_id from cost_authorizations where status = 'active' and expires_at < now() limit 500`;
  let n = 0;
  for (const r of rows) {
    const ctx: TenantContext = {
      workspaceId: r.workspace_id as string,
      workspaceState: 'ACTIVE_PAID',
      role: 'OWNER',
      actor: { kind: 'system', id: 'sweeper' },
      requestId: 'sweep',
    };
    await tx`select set_config('app.workspace_id', ${r.workspace_id as string}, true)`;
    if (await settle(tx, ctx, r.id as string, 'released')) n++;
  }
  return n;
}
