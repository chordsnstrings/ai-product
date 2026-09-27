import type { Tx } from '@arkiv/db';

/**
 * Platform metrics (standard §34 Observability): job queue depth and failures, dead letters, held jobs, Stripe
 * backlog, provider calls, latency and cost — aggregates only, never tenant identifiers.
 */
export interface MetricRow {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export async function platformMetrics(tx: Tx): Promise<MetricRow[]> {
  const rows = await tx`select name, labels, value from arkiv_platform_metrics()`;
  return rows.map((r) => ({ name: r.name as string, labels: (r.labels as Record<string, string>) ?? {}, value: Number(r.value) }));
}

const HELP: Record<string, string> = {
  arkiv_outbox_pending: 'Jobs committed to the outbox and not yet dispatched',
  arkiv_outbox_oldest_pending_seconds: 'Age of the oldest due, undispatched outbox job',
  arkiv_held_jobs: 'Jobs parked while their workspace is held',
  arkiv_stripe_events: 'Stored Stripe events not yet processed, by status',
  arkiv_provider_calls_15m: 'Provider calls in the last 15 minutes, by task and status',
  arkiv_provider_latency_ms_p95_1h: 'p95 provider latency over the last hour, by task',
  arkiv_provider_cost_micros_1h: 'Realized provider cost over the last hour (USD micros), by task',
  arkiv_jobs: 'pg-boss jobs by queue and state (failed: last hour)',
};

const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** Prometheus text exposition format (0.0.4). */
export function prometheusText(rows: MetricRow[]): string {
  const byName = new Map<string, MetricRow[]>();
  for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  const out: string[] = [];
  for (const [name, list] of byName) {
    if (HELP[name]) out.push(`# HELP ${name} ${HELP[name]}`);
    out.push(`# TYPE ${name} gauge`);
    for (const r of list) {
      const labels = Object.entries(r.labels).map(([k, v]) => `${k}="${escape(String(v))}"`).join(',');
      out.push(`${name}${labels ? `{${labels}}` : ''} ${Number.isFinite(r.value) ? r.value : 0}`);
    }
  }
  return out.join('\n') + '\n';
}
