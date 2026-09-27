/**
 * Build check (plan 06 Phase 0 D2 "bundle-size check"): after `next build`, fail if a marketing or funnel route's
 * first-load JS (gzip) is over its budget in <app>/bundle-budget.json. Usage: tsx scripts/bundle-budget.ts apps/web
 * `--report` prints every route's size without failing (to set budgets).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstLoadKb, overBudget, type Budget } from './bundle-budget-lib';

const args = process.argv.slice(2);
const report = args.includes('--report');
const app = args.find((a) => !a.startsWith('--')) ?? 'apps/web';
const budgets = JSON.parse(readFileSync(join(app, 'bundle-budget.json'), 'utf8')) as { routes: Budget[] };
let measured: { route: string; kb: number; maxKb: number; targetKb?: number }[];
try {
  measured = budgets.routes.map((b) => ({ route: b.route, kb: firstLoadKb(join(app, '.next'), b.entry), maxKb: b.maxKb, targetKb: b.targetKb }));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
for (const m of measured) {
  const target = m.targetKb != null && m.kb > m.targetKb ? ` · design target ${m.targetKb} kB not met yet` : '';
  console.log(`${m.kb > m.maxKb ? 'OVER' : 'ok  '} ${m.route.padEnd(28)} ${m.kb.toFixed(1).padStart(7)} kB gzip (budget ${m.maxKb} kB)${target}`);
}
const over = overBudget(measured);
if (over.length && !report) {
  console.error(`${over.length} route(s) over their first-load JS budget: ${over.map((o) => o.route).join(', ')}`);
  process.exit(1);
}
