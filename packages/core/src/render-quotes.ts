import type { Tx } from '@arkiv/db';
import { COST_LIMITS, DomainError, type Micros } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { authorize, type Purpose } from './cost-governor';
import { hashRequest } from './idempotency';
import { currentPeriodKey } from './ledger';
import { planProjectRun } from './production';
import { estimate } from './rates';
import { OUT_OF_STOCK_COPY, stockState } from './stock';

/** How long a render quote can be approved against. */
export const RENDER_QUOTE_MINUTES = 15;
/** The production reservation made at approval (same TTL as a production run's own). */
const AUTH_TTL_MINUTES = 180;

export interface RenderQuote {
  quoteId: string;
  estimateMicros: Micros;
  ceilingMicros: Micros;
  withinCeiling: boolean;
  entitlementAvailable: boolean;
  /** Customer copy for why approval would be refused right now; null when it would go through. */
  blockedReason: string | null;
  expiresAt: string;
}

class DryRun extends Error {}

/** The experiment's master project, locked. */
async function experimentProject(tx: Tx, experimentId: string) {
  const [e] = await tx`select id, state, approved_at from experiments where id = ${experimentId} for update`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const [v] = await tx`select project_id from variants where experiment_id = ${experimentId} and project_id is not null order by code limit 1`;
  if (!v) throw new DomainError('NOT_FOUND', 'Experiment not found');
  return { e, projectId: v.project_id as string };
}

/** What the storyboard being approved looks like, for "unchanged since the quote". */
const storyboardHash = (scenes: Record<string, unknown>[]) =>
  hashRequest(scenes.map((s) => [s.id, s.position, s.production_mode, s.duration_ms, s.spoken_line ?? null, s.overlay_text ?? null, s.visual_plan ?? null, s.current_version_id ?? null, s.locked ?? false]));

async function priced(tx: Tx, ctx: TenantContext, projectId: string, purpose: Purpose) {
  const run = await planProjectRun(tx, ctx.workspaceId, projectId, purpose);
  if (!run) throw new DomainError('CONFLICT', 'The storyboard isn’t ready yet.');
  const [sb] = await tx`select status from storyboards where id = ${run.storyboardId}`;
  if (sb?.status !== 'ready') throw new DomainError('CONFLICT', 'The storyboard isn’t ready yet.');
  return { ...run, est: estimate(run.rates, run.plan.lines), hash: storyboardHash(run.scenes as unknown as Record<string, unknown>[]) };
}

/**
 * POST render-estimate (standard §38 Production): what producing this test would cost at today's rates, and whether
 * the Cost Governor would authorise it now — ceiling, markup floor, anomaly guard and the Creative Test entitlement
 * are all checked by a dry-run authorization that is rolled back (nothing is reserved). The quote is stored,
 * short-lived and tied to this storyboard and these rate versions; approval must present it.
 */
export async function renderQuote(tx: Tx, ctx: TenantContext, experimentId: string): Promise<RenderQuote> {
  assertCan(ctx, 'spend.creative_test');
  const { e, projectId } = await experimentProject(tx, experimentId);
  if (e.approved_at || !['DRAFT', 'RECOMMENDED', 'APPROVED'].includes(e.state as string)) throw new DomainError('CONFLICT', 'This test has already moved past approval.');
  const q = await priced(tx, ctx, projectId, 'creative_test');
  const ceiling = COST_LIMITS.CREATIVE_TEST_CEILING;
  let blocked: DomainError | null = null;
  try {
    await tx.savepoint(async (sp) => {
      await authorize(sp as unknown as Tx, ctx, {
        purpose: 'creative_test',
        projectId,
        lines: q.plan.lines,
        entitlement: { unit: 'creative_test', amount: 1, periodKey: await currentPeriodKey(sp as unknown as Tx, ctx.workspaceId) },
        idempotencyKey: `quote-dry-run:${projectId}:${Date.now()}`,
        ttlMinutes: 1,
        reserveWhileRendersPaused: true,
      });
      throw new DryRun();
    });
  } catch (err) {
    if (!(err instanceof DryRun)) {
      if (!(err instanceof DomainError)) throw err;
      blocked = err;
    }
  }
  const entitlementAvailable = !(blocked?.code === 'PAYMENT_REQUIRED');
  const withinCeiling = q.est.totalMicros <= ceiling;
  // §42: an out-of-stock product is flagged here, before production (approval refuses it until the merchant says
  // the ad is for a waitlist or launch).
  const [sku] = await tx`select sku_id from projects where id = ${projectId}`;
  const outOfStock = sku ? (await stockState(tx, sku.sku_id as string)).needsIntent : false;
  const blockedReason = outOfStock
    ? OUT_OF_STOCK_COPY
    : blocked
    ? blocked.code === 'PAYMENT_REQUIRED'
      ? 'No Creative Tests left this period. Upgrade or wait for your plan to renew.'
      : blocked.code === 'GATE_BLOCKED'
        ? 'This storyboard costs more to produce than a Creative Test allows. Simplify a generated scene and try again.'
        : blocked.message
    : null;
  const [row] = await tx`insert into render_quotes (workspace_id, project_id, experiment_id, storyboard_id, storyboard_hash, rate_versions, estimate_micros, ceiling_micros,
                           within_ceiling, entitlement_available, blocked_reason, created_by, expires_at)
                         values (${ctx.workspaceId}, ${projectId}, ${experimentId}, ${q.storyboardId}, ${q.hash}, ${tx.json(q.est.rateVersions)}, ${q.est.totalMicros}, ${ceiling},
                           ${withinCeiling}, ${entitlementAvailable}, ${blockedReason}, ${`${ctx.actor.kind}:${ctx.actor.id}`}, now() + make_interval(mins => ${RENDER_QUOTE_MINUTES}))
                         returning id, expires_at`;
  return { quoteId: row!.id as string, estimateMicros: q.est.totalMicros, ceilingMicros: ceiling, withinCeiling, entitlementAvailable, blockedReason, expiresAt: new Date(row!.expires_at as string).toISOString() };
}

/**
 * At approval: the quote must be this project's, unused, unexpired, for the storyboard as it is now and the rate
 * versions in effect now. Then the Cost Governor authorization is created in the same transaction (refusals roll the
 * approval back, so the merchant sees them now, not later as NEEDS_USER_ACTION); the production run takes it over.
 */
export async function authorizeFromQuote(tx: Tx, ctx: TenantContext, experimentId: string, quoteId: string): Promise<{ projectId: string; authorizationId: string }> {
  const { projectId } = await experimentProject(tx, experimentId);
  const [qt] = await tx`select * from render_quotes where id = ${quoteId} and project_id = ${projectId} for update`;
  if (!qt) throw new DomainError('NOT_FOUND', 'That estimate isn’t for this test. Get a fresh estimate.');
  if (qt.used_at) throw new DomainError('CONFLICT', 'That estimate was already used.');
  if (new Date(qt.expires_at as string) < new Date()) throw new DomainError('CONFLICT', 'The estimate expired. Review the new one before approving.', { requote: true });
  const q = await priced(tx, ctx, projectId, 'creative_test');
  if (q.storyboardId !== qt.storyboard_id || q.hash !== qt.storyboard_hash) throw new DomainError('CONFLICT', 'The storyboard changed since the estimate. Review the new one before approving.', { requote: true });
  if (hashRequest(q.est.rateVersions) !== hashRequest(qt.rate_versions)) throw new DomainError('CONFLICT', 'Prices changed since the estimate. Review the new one before approving.', { requote: true });
  await tx`update cost_authorizations set idempotency_key = idempotency_key || ':retired:' || id::text
           where workspace_id = ${ctx.workspaceId} and project_id = ${projectId} and idempotency_key = ${'produce:' + projectId} and status <> 'active'`;
  const a = await authorize(tx, ctx, {
    purpose: 'creative_test',
    projectId,
    lines: q.plan.lines,
    entitlement: { unit: 'creative_test', amount: 1, periodKey: await currentPeriodKey(tx, ctx.workspaceId) },
    // The run's own key: produceProject finds this live authorization and takes it over instead of reserving again.
    idempotencyKey: `produce:${projectId}`,
    ttlMinutes: AUTH_TTL_MINUTES,
    reserveWhileRendersPaused: true,
    meta: { reserveSeconds: q.plan.reserveSeconds, generative: q.plan.generative, quoteId },
  });
  await tx`update projects set authorization_id = ${a.authorizationId} where id = ${projectId}`;
  await tx`update render_quotes set used_at = now() where id = ${quoteId}`;
  return { projectId, authorizationId: a.authorizationId };
}
