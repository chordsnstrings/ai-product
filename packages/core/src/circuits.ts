import type { Tx } from '@arkiv/db';
import { raiseAlert } from './alerts';
import { setting, SETTING_DEFAULTS } from './settings';

/**
 * Automatic circuit breaker (plan 05 §10 "auto-open at error-rate threshold"; standard §44 provider outage).
 * Every few minutes the sweep looks at each route's provider calls since the later of "window ago" and the
 * route's last circuit change. A route whose outage-class error rate crosses the threshold (on enough calls) is
 * opened; so is every route of a provider whose calls, taken together, cross it with failures on two or more
 * routes (the provider itself is down, not one model). While a circuit is open the
 * gateway refuses the route, so an approved fallback answers or the production queues (§44). A circuit the
 * sweep opened closes itself after the cool-down (a half-open trial: if errors continue it trips again); one
 * staff opened stays open until staff close it. Every change is written to the audit log as a system action and
 * raised as a Pulse alert. Platform aggregates only; no tenant content is read.
 */
export const CIRCUIT_BREAKER = {
  windowMinutes: SETTING_DEFAULTS['circuit.window_minutes'] as number,
  /** Don't judge a route (or a provider) on fewer finished calls than this. */
  minCalls: SETTING_DEFAULTS['circuit.min_calls'] as number,
  /** Share of calls that failed outage-class at or above which the circuit opens. */
  errorRate: SETTING_DEFAULTS['circuit.error_rate'] as number,
  /** How long an automatically opened circuit stays open before a trial close. */
  coolDownMinutes: SETTING_DEFAULTS['circuit.cooldown_minutes'] as number,
};

/** Failures that say the provider is down, not that the content was refused (see model-gateway fallbackEligible). */
export const OUTAGE_ERROR_KINDS = ['server', 'timeout', 'rate_limit', 'auth'] as const;

export interface CallStats {
  calls: number;
  failed: number;
}

/** Whether these calls trip the breaker. */
export function circuitTrips(s: CallStats, g: { minCalls: number; errorRate: number } = CIRCUIT_BREAKER): boolean {
  return s.calls >= g.minCalls && s.failed / s.calls >= g.errorRate;
}

export interface CircuitChange {
  task: string;
  action: 'opened' | 'closed';
  why: string;
}

async function thresholds(tx: Tx) {
  return {
    windowMinutes: Math.max(1, await setting(tx, 'circuit.window_minutes')),
    minCalls: Math.max(1, await setting(tx, 'circuit.min_calls')),
    errorRate: Math.min(1, Math.max(0.01, await setting(tx, 'circuit.error_rate'))),
    coolDownMinutes: Math.max(1, await setting(tx, 'circuit.cooldown_minutes')),
  };
}

const systemAudit = (tx: Tx, action: string, task: string, reason: string, before: unknown, after: unknown) =>
  tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, reason, before, after)
     values (null, '{}', ${action}, 'route', ${task}, ${reason}, ${tx.json(before as never)}, ${tx.json(after as never)})`;

/** Sweep (system role): trial-close cooled-down automatic circuits, then open the ones whose error rate tripped. */
export async function evaluateCircuits(tx: Tx): Promise<CircuitChange[]> {
  const g = await thresholds(tx);
  const changes: CircuitChange[] = [];

  const cooled = await tx`
    update model_routes set circuit_open = false, circuit_auto = false, circuit_until = null, circuit_reason = null, circuit_changed_at = now(), updated_at = now()
    where circuit_open and circuit_auto and circuit_until is not null and circuit_until <= now()
    returning task`;
  for (const r of cooled) {
    await systemAudit(tx, 'route.circuit_auto_close', r.task as string, 'automatic trial close after the cool-down', { circuit_open: true }, { circuit_open: false });
    changes.push({ task: r.task as string, action: 'closed', why: 'cool-down elapsed' });
  }

  // Calls per route since the later of the window start and the route's last circuit change: failures from
  // before a close never re-trip it.
  const stats = await tx`
    select r.task, r.provider, r.circuit_open,
           count(j.id)::int as calls,
           count(j.id) filter (where j.status = 'failed' and j.raw_meta->>'errorKind' = any(${[...OUTAGE_ERROR_KINDS]}))::int as failed
    from model_routes r
    left join provider_jobs j on j.task = r.task and j.provider = r.provider and j.status in ('succeeded', 'failed')
      and j.completed_at > greatest(now() - make_interval(mins => ${g.windowMinutes}), coalesce(r.circuit_changed_at, '-infinity'::timestamptz))
    group by r.task, r.provider, r.circuit_open`;
  // A provider counts as failing as a whole only when its failures span at least two routes: one bad model on
  // one route (its own trip) must not take down the provider's unrelated services.
  const byProvider = new Map<string, CallStats & { failingRoutes: number }>();
  for (const s of stats) {
    const p = byProvider.get(s.provider as string) ?? { calls: 0, failed: 0, failingRoutes: 0 };
    p.calls += Number(s.calls);
    p.failed += Number(s.failed);
    if (Number(s.failed) > 0) p.failingRoutes++;
    byProvider.set(s.provider as string, p);
  }
  const pctOf = (s: CallStats) => `${Math.round((s.failed / s.calls) * 100)}% of ${s.calls} calls`;
  for (const s of stats) {
    if (s.circuit_open) continue;
    const own: CallStats = { calls: Number(s.calls), failed: Number(s.failed) };
    const prov = byProvider.get(s.provider as string)!;
    const why = circuitTrips(own, g)
      ? `error rate ${pctOf(own)} in the last ${g.windowMinutes} min`
      : prov.failingRoutes >= 2 && circuitTrips(prov, g)
        ? `${s.provider as string} error rate ${pctOf(prov)} across its routes in the last ${g.windowMinutes} min`
        : null;
    if (!why) continue;
    const [opened] = await tx`
      update model_routes set circuit_open = true, circuit_auto = true, circuit_reason = ${why}, circuit_changed_at = now(),
        circuit_until = now() + make_interval(mins => ${g.coolDownMinutes}), updated_at = now()
      where task = ${s.task as string} and not circuit_open
      returning circuit_until`;
    if (!opened) continue;
    await systemAudit(tx, 'route.circuit_auto_open', s.task as string, `automatic: ${why}`, { circuit_open: false, route: own, provider: prov }, { circuit_open: true, circuit_until: opened.circuit_until });
    await raiseAlert(tx, {
      kind: 'circuit_auto_open',
      severity: 'risk',
      subject: { type: 'route', id: s.task as string },
      message: `Circuit opened automatically on ${s.task as string}: ${why}. Fallback or queue is in effect; it tries again in ${g.coolDownMinutes} min.`,
      details: { provider: s.provider, route: own, providerStats: prov },
    });
    changes.push({ task: s.task as string, action: 'opened', why });
  }
  return changes;
}
