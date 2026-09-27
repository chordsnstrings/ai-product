import { timingSafeEqual } from 'node:crypto';
import { globalTx } from '@arkiv/db';
import { platformMetrics, prometheusText } from '@arkiv/core';
import { env } from '@arkiv/shared';

/**
 * Prometheus metrics (standard §34): queue depth, dead letters, job failures, held jobs, Stripe backlog, provider
 * calls, latency and cost. Aggregates only, behind a bearer token (METRICS_TOKEN); without one it is a 404.
 */
export async function GET(req: Request) {
  const token = env().METRICS_TOKEN;
  if (!token) return new Response('Not found', { status: 404 });
  const given = Buffer.from((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return new Response('Unauthorized', { status: 401 });
  const rows = await globalTx((tx) => platformMetrics(tx));
  return new Response(prometheusText(rows), { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' } });
}
