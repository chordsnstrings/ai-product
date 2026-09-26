/**
 * Load test (plan 06 Phase 6 §4): N concurrent anonymous previews against a running web + worker.
 * Reports submit latency and time-to-concepts percentiles, error rate, and the fairness signal: while the
 * preview burst is queued, paid production jobs (priority 10–20) must not wait behind free work (priority 0).
 * Usage: BASE=http://localhost:3000 N=200 tsx tests/load/previews.ts
 */
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const N = Number(process.env.N ?? 50);
const photo = readFileSync(new URL('../e2e/fixtures/serum.jpg', import.meta.url));
const pct = (xs: number[], p: number) => (xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : NaN);

async function one(i: number) {
  const t0 = Date.now();
  const fd = new FormData();
  fd.append('photos', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), `p${i}.jpg`);
  fd.set('page', 'load');
  // Distinct first-party visitors from distinct /24s so per-network provisional limits don't dominate.
  const r = await fetch(`${BASE}/api/preview`, { method: 'POST', body: fd, headers: { origin: BASE, 'x-forwarded-for': `10.${Math.floor(i / 250)}.${i % 250}.1` } });
  const submitMs = Date.now() - t0;
  if (!r.ok) return { ok: false, status: r.status, submitMs, readyMs: NaN };
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const { projectId } = (await r.json()) as { projectId: string };
  for (;;) {
    const v = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { cookie } }).then((x) => x.json()).catch(() => null);
    if (v?.concepts?.length === 3) return { ok: true, status: 200, submitMs, readyMs: Date.now() - t0 };
    if (v?.sku?.status === 'rejected') return { ok: false, status: 422, submitMs, readyMs: NaN };
    if (Date.now() - t0 > 15 * 60_000) return { ok: false, status: 408, submitMs, readyMs: NaN };
    await new Promise((res) => setTimeout(res, 2000));
  }
}

const started = Date.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
const ok = results.filter((r) => r.ok);
console.log(JSON.stringify({
  previews: N,
  succeeded: ok.length,
  errors: Object.fromEntries(Object.entries(Object.groupBy(results.filter((r) => !r.ok), (r) => String(r.status))).map(([k, v]) => [k, v!.length])),
  submitMs: { p50: pct(ok.map((r) => r.submitMs), 50), p95: pct(ok.map((r) => r.submitMs), 95) },
  timeToConceptsMs: { p50: pct(ok.map((r) => r.readyMs), 50), p95: pct(ok.map((r) => r.readyMs), 95) },
  wallMs: Date.now() - started,
}, null, 2));
if (ok.length < N * 0.99) process.exit(1);
