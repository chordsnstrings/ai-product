import { createHash, randomBytes } from 'node:crypto';
import type { Tx } from '@arkiv/db';
import { COST_LIMITS, DomainError, FREE_EXPLORATION, PLANS, PRICES, type Micros, type PlanCode } from '@arkiv/shared';
import type { TenantContext } from './context';
import { append, available, currentPeriodKey, expirePeriod, lockEntitlement, periodExpired, providerSpendSince, type LedgerUnit } from './ledger';
import { estimate as priceEstimate, loadRates, type CostLine, type Estimate } from './rates';
import { isFlagOn } from './flags';
import { isFreeTier } from './outbox';
import { HEARTBEAT_STALE_MS } from './progress';
import { setting } from './settings';

/**
 * Cost Governor (§37). No creative or agent may call a billable provider directly: the Production Planner
 * requests an estimate, the Governor checks entitlement, ceilings, anomaly caps and kill switches, writes a
 * reservation and returns an authorization token. The Model Gateway accepts only valid tokens.
 */

export type Purpose = 'free_preview' | 'storyboard' | 'taste' | 'standalone' | 'creative_test' | 'premium' | 'repair' | 'eval';

export interface AuthorizeInput {
  projectId?: string | null;
  skuId?: string | null;
  purpose: Purpose;
  lines: CostLine[];
  /** Customer entitlement to reserve (null for free/internal work). */
  entitlement?: { unit: Exclude<LedgerUnit, 'usd_micros'>; amount: number; periodKey?: string | null } | null;
  ttlMinutes?: number;
  idempotencyKey: string;
  /**
   * Reserve even while `kill.renders` is on. Nothing is dispatched (the Model Gateway refuses renders while the
   * switch is on); the caller holds the customer's place and queues (§44 "preserve reservation").
   */
  reserveWhileRendersPaused?: boolean;
  /** Planning data stored with the estimate (e.g. a production's QA repair reserve) for a resumed run to read. */
  meta?: Record<string, unknown>;
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

/** Purposes whose ceiling is the standard Creative Test's: cumulative over one production (a project). */
const PER_TEST_PURPOSES: ReadonlySet<Purpose> = new Set(['creative_test', 'taste', 'standalone']);

async function ceilingFor(tx: Tx, purpose: Purpose): Promise<Micros | null> {
  switch (purpose) {
    case 'creative_test':
    case 'taste':
    case 'standalone':
      return COST_LIMITS.CREATIVE_TEST_CEILING;
    case 'free_preview':
      // Staff-tunable (plan 05 §20 "free-preview COGS cap"); the standard's cap is the fallback.
      return setting(tx, 'free_preview.cogs_cap_micros');
    case 'storyboard':
      return COST_LIMITS.STORYBOARD_CAP;
    default:
      return null;
  }
}

export interface MarginDecision {
  ok: boolean;
  /** Revenue value of the reserved entitlement. */
  revenueMicros: Micros;
  /** Most this work may cost at the floor: revenue × (1 − MIN_VARIABLE_MARGIN). */
  maxCostMicros: Micros;
  estimateMicros: Micros;
  /** Variable margin at the estimate (null without revenue). */
  margin: number | null;
  floor: number;
}

/**
 * Revenue value of one unit of entitlement (markup floor, §37): a Creative Test is worth the plan price over its
 * monthly tests (the lowest per-test price of any plan when the plan is unknown); a Taste or Standalone the
 * amount paid for this project, or the live offer price when nothing was paid (a goodwill credit, a 100% coupon).
 */
export async function revenuePerUnit(tx: Tx, plan: PlanCode | null, unit: Exclude<LedgerUnit, 'usd_micros'>, projectId: string | null): Promise<Micros> {
  if (unit === 'creative_test') {
    const perTest = (p: PlanCode) => Math.floor(PLANS[p].priceMicros / PLANS[p].creativeTestsPerMonth);
    return plan ? perTest(plan) : Math.min(...(Object.keys(PLANS) as PlanCode[]).map(perTest));
  }
  if (projectId) {
    const [pu] = await tx`select amount_micros from purchases where project_id = ${projectId} and status = 'paid' and amount_micros > 0
                          order by paid_at desc nulls last limit 1`;
    if (pu) return Number(pu.amount_micros);
  }
  const type = unit === 'taste' ? 'TASTE' : 'STANDALONE';
  const [d] = await tx`select min(price_micros)::bigint as p from offer_definitions where type = ${type} and active and price_micros > 0`;
  return d?.p != null ? Number(d.p) : unit === 'taste' ? PRICES.TASTE : PRICES.STANDALONE;
}

export async function marginDecision(tx: Tx, plan: PlanCode | null, unit: Exclude<LedgerUnit, 'usd_micros'>, amount: number, projectId: string | null, estimateMicros: Micros): Promise<MarginDecision> {
  const floor = COST_LIMITS.MIN_VARIABLE_MARGIN;
  const revenueMicros = (await revenuePerUnit(tx, plan, unit, projectId)) * amount;
  const maxCostMicros = Math.floor(revenueMicros * (1 - floor));
  return {
    ok: estimateMicros <= maxCostMicros,
    revenueMicros,
    maxCostMicros,
    estimateMicros,
    margin: revenueMicros > 0 ? Math.round((1 - estimateMicros / revenueMicros) * 1000) / 1000 : null,
    floor,
  };
}

export async function authorize(tx: Tx, ctx: TenantContext, input: AuthorizeInput): Promise<Authorization> {
  // Idempotent: a retried request returns the same reservation (no second hold). Concurrent requests for the
  // same key (duplicate job delivery) serialize here, so the second sees the first's authorization instead of
  // racing it to the entitlement check and failing with a spurious PAYMENT_REQUIRED.
  await tx`select pg_advisory_xact_lock(hashtext(${`authorize:${ctx.workspaceId}:${input.idempotencyKey}`}))`;
  const [existing] = await tx`select id from cost_authorizations where idempotency_key = ${input.idempotencyKey}`;
  if (existing) {
    // The token is only ever returned once; a replay must not dispatch again (the project state machine guards this).
    throw new DomainError('CONFLICT', 'Authorization already issued for this request', { authorizationId: existing.id });
  }

  if (!input.reserveWhileRendersPaused && input.purpose !== 'free_preview' && input.purpose !== 'storyboard' && (await isFlagOn(tx, 'kill.renders'))) {
    throw new DomainError('UNAVAILABLE', 'Production is paused for maintenance. Your place is held.');
  }
  if (input.purpose === 'free_preview' && (await isFlagOn(tx, 'kill.free_preview'))) {
    throw new DomainError('UNAVAILABLE', 'Free previews are paused. Please try again shortly.');
  }

  const est = await estimateCost(tx, input.lines);

  // 1. Ceiling per purpose (standard §5 V1.1 Creative Test ceiling; free preview cap per SKU).
  let ceiling = await ceilingFor(tx, input.purpose);
  // §44 "active customer promises handled by commercial policy": a paid production that no longer fits its class
  // ceiling at today's rates (even after re-planning) runs at a loss only with a staff-approved override (four-eyes,
  // FINANCE) recorded on the project; the markup floor is then waived for it.
  let override: Micros | null = null;
  if (ceiling !== null && PER_TEST_PURPOSES.has(input.purpose) && input.projectId) {
    const [pr] = await tx`select ceiling_override_micros from projects where id = ${input.projectId} and workspace_id = ${ctx.workspaceId}`;
    override = pr?.ceiling_override_micros != null ? Number(pr.ceiling_override_micros) : null;
    if (override != null) ceiling = Math.max(ceiling, override);
  }
  if (ceiling !== null) {
    let prior = 0;
    if (input.purpose === 'free_preview' && ctx.workspaceState === 'PROVISIONAL') {
      // Plan 02 §4: the free-preview COGS cap is per provisional workspace, across every product previewed in it.
      // Past it, generating stops and the visitor is asked to sign up (not a dead end).
      const [r] = await tx`select coalesce(sum(case when status = 'active' then max_cost_micros else spent_micros end), 0)::bigint as n
                           from cost_authorizations
                           where workspace_id = ${ctx.workspaceId} and purpose = 'free_preview' and status in ('active','settled')`;
      const spent = Number(r!.n);
      if (spent + est.totalMicros > ceiling) {
        throw new DomainError('PAYMENT_REQUIRED', 'Save your work to continue.', { needsAccount: true, ceilingMicros: ceiling, priorMicros: spent, estimateMicros: est.totalMicros, reason: 'free_preview_workspace_cap' });
      }
    }
    if (PER_TEST_PURPOSES.has(input.purpose) && input.projectId) {
      // Standard §5: the ceiling is per Creative Test, not per authorization. Everything else already authorized
      // for this production counts — the production run, each hook variant's voice-over, any further work under
      // the test (active holds at their ceiling, settled ones at what was actually spent). An earlier, failed
      // attempt that a retry replaced (its key retired) is not part of the plan being checked.
      const [r] = await tx`select coalesce(sum(case when status = 'active' then max_cost_micros else spent_micros end), 0)::bigint as n
                           from cost_authorizations
                           where workspace_id = ${ctx.workspaceId} and project_id = ${input.projectId}
                             and purpose in ${tx([...PER_TEST_PURPOSES])} and status in ('active','settled')
                             and idempotency_key not like ${'produce:%:retired:%'} and idempotency_key <> ${input.idempotencyKey}`;
      prior = Number(r!.n);
    }
    if (input.purpose === 'free_preview' && input.skuId) {
      // Active holds count at their ceiling; settled ones at what was actually spent.
      const [r] = await tx`select coalesce(sum(case when status = 'active' then max_cost_micros else spent_micros end), 0)::bigint as n
                           from cost_authorizations
                           where workspace_id = ${ctx.workspaceId} and purpose = 'free_preview' and estimate->>'skuId' = ${input.skuId}
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

  // 1a. Pre-purchase exploration is cumulative per SKU for workspaces that have not paid (standard §5): every
  //     storyboard, frame and extra concept batch for the product counts (active holds at their ceiling).
  if (input.purpose === 'storyboard' && input.skuId && isFreeTier(ctx)) {
    const [r] = await tx`select coalesce(sum(case when status = 'active' then max_cost_micros else spent_micros end), 0)::bigint as n
                         from cost_authorizations
                         where purpose = 'storyboard' and estimate->>'skuId' = ${input.skuId} and status in ('active','settled')`;
    const prior = Number(r!.n);
    if (prior + est.totalMicros > FREE_EXPLORATION.SKU_COGS_CAP) {
      throw new DomainError('GATE_BLOCKED', 'You’ve explored this product as far as the free preview goes. Produce this one to keep exploring.', {
        ceilingMicros: FREE_EXPLORATION.SKU_COGS_CAP,
        estimateMicros: est.totalMicros,
        priorMicros: prior,
        purpose: input.purpose,
        reason: 'free_exploration_cap',
      });
    }
  }

  const [ws] = await tx`select plan_code from workspaces where id = ${ctx.workspaceId}`;
  const plan = (ws?.plan_code as PlanCode | null) ?? null;

  // 1b. Markup floor (§33, §37): work paid for with an entitlement may not cost more than that entitlement's
  //     revenue allows at the minimum variable margin. Premium and repair work have no standard ceiling, so they
  //     are only ever authorized against an explicit, priced entitlement.
  let margin: MarginDecision | null = null;
  if ((input.purpose === 'premium' || input.purpose === 'repair') && !(input.entitlement && input.entitlement.amount > 0)) {
    throw new DomainError('GATE_BLOCKED', 'Premium and repair work needs a priced entitlement', { purpose: input.purpose, reason: 'unpriced' });
  }
  if (input.entitlement && input.entitlement.amount > 0) {
    margin = await marginDecision(tx, plan, input.entitlement.unit, input.entitlement.amount, input.projectId ?? null, est.totalMicros);
    if (!margin.ok && override == null) {
      throw new DomainError('GATE_BLOCKED', 'This plan costs more than the markup floor allows for its entitlement', { ...margin, purpose: input.purpose, reason: 'markup_floor' });
    }
  }

  // 2. Daily anomaly guard (plan 02 §4): 3x the plan's expected daily COGS.
  const expectedDaily = plan
    ? (PLANS[plan].creativeTestsPerMonth * COST_LIMITS.CREATIVE_TEST_CEILING) / 30
    : COST_LIMITS.CREATIVE_TEST_CEILING;
  const since = new Date(Date.now() - 24 * 3600_000);
  const spent24h = await providerSpendSince(tx, since, ctx.workspaceId);
  const cap = Math.max(expectedDaily * COST_LIMITS.DAILY_ANOMALY_MULTIPLE, COST_LIMITS.CREATIVE_TEST_CEILING * 2);
  if (spent24h + est.totalMicros > cap) {
    throw new DomainError('UNAVAILABLE', "We're reviewing unusual activity on this workspace. Your work is saved.", {
      anomaly: true,
      spent24h,
      cap,
    });
  }

  // 3. Entitlement. Checked and reserved under the workspace's entitlement lock (held to commit), so concurrent
  //    productions can't both reserve the last unit (x-races-01). A Creative Test is reserved against the period
  //    that is current once the lock is held: a renewal that committed meanwhile moved it on (x-races-08).
  let periodKey = input.entitlement?.periodKey ?? null;
  if (input.entitlement && input.entitlement.amount > 0) {
    await lockEntitlement(tx, ctx.workspaceId);
    if (input.entitlement.unit === 'creative_test' && periodKey) periodKey = (await currentPeriodKey(tx, ctx.workspaceId)) ?? periodKey;
    const have = await available(tx, input.entitlement.unit, ctx.workspaceId);
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
      ${tx.json(est.rateVersions)}, ${tx.json({ ...(input.meta ?? {}), ...est, skuId: input.skuId ?? null, margin } as never)}, ${est.totalMicros},
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
      periodKey,
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
 * Resume support (§39 "idempotent resume"): hand a new token to the run that took over a live reservation (the
 * crashed run's token stops working) and extend its expiry. The hold itself — and any reserved entitlement —
 * is unchanged, so a resumed production never reserves twice.
 */
export async function reissueToken(tx: Tx, authorizationId: string, ttlMinutes: number): Promise<string | null> {
  const token = randomBytes(24).toString('base64url');
  const [a] = await tx`update cost_authorizations set token_hash = ${hashToken(token)},
                         expires_at = greatest(expires_at, now() + make_interval(mins => ${ttlMinutes}))
                       where id = ${authorizationId} and status = 'active' returning id`;
  return a ? token : null;
}

/** Keep a reservation alive through a provider outage pause (§44 "preserve reservation"). */
export async function holdAuthorization(tx: Tx, authorizationId: string, until: Date): Promise<void> {
  await tx`update cost_authorizations set expires_at = greatest(expires_at, ${until}) where id = ${authorizationId} and status = 'active'`;
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

/**
 * The rate table versions an authorization was priced on (provider/model → version). The Model Gateway prices each
 * call under it at those versions (§44 "active customer promises handled by commercial policy"): a rate change after
 * the promise was made never makes an in-flight job unaffordable; the real cost is still booked at today's rates.
 */
export async function authorizationRateVersions(tx: Tx, token: string): Promise<Record<string, number>> {
  const [a] = await tx`select rate_table_versions from cost_authorizations where token_hash = ${hashToken(token)}`;
  return ((a?.rate_table_versions as Record<string, number> | null) ?? {}) as Record<string, number>;
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
      // A test returned to a period that has already ended expires with it (no rollover): it never becomes
      // spendable in the next period (x-races-08).
      if (base.unit === 'creative_test' && base.periodKey && (await periodExpired(tx, ctx.workspaceId, base.periodKey))) {
        await expirePeriod(tx, ctx, base.periodKey);
      }
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

/**
 * Sweeper (§39): crashed workers must not strand entitlement. Runs as system across tenants. Suspended
 * workspaces are skipped: their jobs are paused, and a reservation is not released until its job resolves
 * (plan 05 §2.3).
 */
export async function sweepExpiredAuthorizations(tx: Tx): Promise<number> {
  // A reservation whose job still sends heartbeats is in use (§39): never released under a running production.
  const rows = await tx`select a.id, a.workspace_id from cost_authorizations a
                        where a.status = 'active' and a.expires_at < now()
                          and not exists (select 1 from workspaces w where w.id = a.workspace_id and w.state = 'SUSPENDED')
                          and not exists (select 1 from projects p where p.workspace_id = a.workspace_id and p.id = a.project_id
                                          and p.heartbeat_at > now() - make_interval(secs => ${HEARTBEAT_STALE_MS / 1000}))
                        limit 500`;
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
