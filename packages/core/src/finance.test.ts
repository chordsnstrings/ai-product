import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, usd } from '@arkiv/shared';
import {
  classifySubscriptionEvents,
  cogsBreakdown,
  importProviderInvoice,
  ledgerExplorer,
  mrrReport,
  parseProviderInvoiceCsv,
  providerInvoiceVariance,
  workspaceMargins,
  type SubscriptionEvent,
} from './finance';

beforeEach(truncateAll);
afterAll(closeAll);

const at = (iso: string) => new Date(iso);
const ev = (workspaceId: string, subjectId: string, type: SubscriptionEvent['type'], when: string, payload: Record<string, unknown>): SubscriptionEvent => ({ workspaceId, subjectId, type, at: at(when), payload });

describe('MRR movements (plan 05 §7 revenue)', () => {
  const events = [
    // A: Launch in July, upgraded to Scale in August.
    ev('A', 'sA', 'SUBSCRIPTION_STARTED', '2026-07-03T10:00:00Z', { plan: 'LAUNCH' }),
    ev('A', 'sA', 'SUBSCRIPTION_CHANGED', '2026-08-10T10:00:00Z', { from: 'LAUNCH', to: 'SCALE', effective: 'now' }),
    // B: Growth in July, schedules a downgrade in August that takes effect in September; cancels in September, ends in October.
    ev('B', 'sB', 'SUBSCRIPTION_STARTED', '2026-07-05T10:00:00Z', { plan: 'GROWTH' }),
    ev('B', 'sB', 'SUBSCRIPTION_CHANGED', '2026-08-20T10:00:00Z', { from: 'GROWTH', to: 'LAUNCH', effective: 'period_end' }),
    ev('B', 'sB', 'SUBSCRIPTION_CHANGED', '2026-09-05T10:00:00Z', { from: 'GROWTH', to: 'LAUNCH', effective: 'applied' }),
    ev('B', 'sB', 'SUBSCRIPTION_CHANGED', '2026-09-10T10:00:00Z', { cancelAtPeriodEnd: true }),
    ev('B', 'sB', 'SUBSCRIPTION_ENDED', '2026-10-05T10:00:00Z', { plan: 'LAUNCH' }),
    // B comes back in October: a reactivation, not new revenue.
    ev('B', 'sB2', 'SUBSCRIPTION_STARTED', '2026-10-20T10:00:00Z', { plan: 'GROWTH' }),
    // C: Growth in September.
    ev('C', 'sC', 'SUBSCRIPTION_STARTED', '2026-09-01T10:00:00Z', { plan: 'GROWTH' }),
  ];

  it('classifies new, expansion, contraction when it takes effect, churn when it ends, and reactivation', () => {
    const c = classifySubscriptionEvents(events);
    expect(c.moves.map((m) => [m.workspaceId, m.kind, m.delta])).toEqual([
      ['A', 'new', usd(49)],
      ['B', 'new', usd(99)],
      ['A', 'expansion', usd(150)],
      ['C', 'new', usd(99)],
      ['B', 'contraction', -usd(50)],
      ['B', 'churned', -usd(49)],
      ['B', 'reactivation', usd(99)],
    ]);
    expect(c.scheduled.map((s) => s.kind)).toEqual(['downgrade_scheduled', 'cancel_scheduled']);
  });

  it('builds the monthly bridge with logo churn and revenue churn kept apart, by plan and by cohort', () => {
    const r = mrrReport(classifySubscriptionEvents(events), { months: 4, tz: 'UTC', now: at('2026-10-25T00:00:00Z') });
    const m = Object.fromEntries(r.months.map((x) => [x.month, x]));
    expect(m['2026-07']).toMatchObject({ startMrr: 0, new: usd(148), endMrr: usd(148), newLogos: 2 });
    expect(m['2026-08']).toMatchObject({ startMrr: usd(148), expansion: usd(150), contraction: 0, endMrr: usd(298), downgradesScheduled: 1, cancelsScheduled: 0 });
    // The downgrade scheduled in August moves MRR in September, when it takes effect; the cancel moves nothing yet.
    expect(m['2026-09']).toMatchObject({ startMrr: usd(298), new: usd(99), contraction: usd(50), churned: 0, endMrr: usd(347), cancelsScheduled: 1, startLogos: 2 });
    expect(m['2026-10']).toMatchObject({ startMrr: usd(347), churned: usd(49), reactivation: usd(99), endMrr: usd(397), churnedLogos: 0, startLogos: 3 });
    // B churned and came back in the same month: revenue churn counts the lost plan; the logo never left for the month.
    expect(m['2026-10']!.revenueChurn).toBeCloseTo(49 / 347, 5);
    expect(m['2026-09']!.logoChurn).toBe(0);
    const plan = Object.fromEntries(r.byPlan.map((p) => [p.plan, p]));
    expect(plan.SCALE).toMatchObject({ subscriptions: 1, mrr: usd(199), expansion: usd(150) });
    expect(plan.GROWTH).toMatchObject({ subscriptions: 2, new: usd(99) * 3 });
    expect(r.cohorts).toEqual([
      { cohort: '2026-09', started: 1, active: 1, startMrr: usd(99), mrrNow: usd(99), churnedLogos: 0, netRetention: 1 },
      { cohort: '2026-07', started: 2, active: 2, startMrr: usd(148), mrrNow: usd(199) + usd(99), churnedLogos: 0, netRetention: (199 + 99) / 148 },
    ]);
    expect(r.mrr).toBe(usd(397));
  });
});

describe('ledger explorer (plan 05 §8)', () => {
  it('filters by type, experiment and job while showing each row’s balance before and after', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const other = await makeTenant({ state: 'ACTIVE_PAID' });
    const sku = await makeSku(t.workspaceId);
    const exp = newId();
    const project = newId();
    await ownerPool()`insert into experiments (id, workspace_id, sku_id, hypothesis, primary_variable, mode, created_by) values (${exp}, ${t.workspaceId}, ${sku}, 'h', 'hook', 'CONTROLLED', 'test')`;
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, experiment_id) values (${project}, ${t.workspaceId}, ${sku}, 'creative_test', 'COMPLETE', 'test', ${exp})`;
    const auth = newId();
    const job = newId();
    await ownerPool()`insert into provider_jobs (id, workspace_id, project_id, provider, task, model, request_hash, status, authorization_id, actual_micros) values (${job}, ${t.workspaceId}, ${project}, 'byteplus', 'video.scene', 'm', 'h', 'succeeded', ${auth}, 1200000)`;
    const row = (ws: string, type: string, unit: string, amount: number, extra: { project?: string; auth?: string; job?: string } = {}) =>
      ownerPool()`insert into ledger_entries (workspace_id, type, unit, amount, project_id, authorization_id, provider_job_id, actor, idempotency_key)
                  values (${ws}, ${type}, ${unit}, ${amount}, ${extra.project ?? null}, ${extra.auth ?? null}, ${extra.job ?? null}, 'system:test', ${newId()})`;
    await row(t.workspaceId, 'CREDIT_GRANTED', 'creative_test', 7);
    await row(t.workspaceId, 'CREDIT_RESERVED', 'creative_test', -1, { project, auth });
    await row(t.workspaceId, 'PROVIDER_COST_RECORDED', 'usd_micros', 1200000, { project, auth, job });
    await row(t.workspaceId, 'CREDIT_CONSUMED', 'creative_test', 1, { project, auth });
    await row(t.workspaceId, 'CREDIT_RESERVED', 'creative_test', -1);
    await row(other.workspaceId, 'CREDIT_GRANTED', 'creative_test', 3);

    const byType = await withAdmin((tx) => ledgerExplorer(tx, { type: 'CREDIT_RESERVED' }));
    expect(byType.rows.map((r) => [r.workspace_id, Number(r.balance_before), Number(r.balance_after)])).toEqual([
      [t.workspaceId, 6, 5],
      [t.workspaceId, 7, 6],
    ]);
    const byExp = await withAdmin((tx) => ledgerExplorer(tx, { experimentId: exp }));
    expect(byExp.rows.map((r) => r.type).sort()).toEqual(['CREDIT_CONSUMED', 'CREDIT_RESERVED', 'PROVIDER_COST_RECORDED']);
    // A provider job finds the entries of its reservation too.
    const byJob = await withAdmin((tx) => ledgerExplorer(tx, { jobId: job }));
    expect(byJob.rows.map((r) => r.type).sort()).toEqual(['CREDIT_CONSUMED', 'CREDIT_RESERVED', 'PROVIDER_COST_RECORDED']);
    const consumed = byJob.rows.find((r) => r.type === 'CREDIT_CONSUMED')!;
    expect(consumed.counted).toBe(false); // informational: never changes what the customer can spend

    const one = await withAdmin((tx) => ledgerExplorer(tx, { workspaceId: t.workspaceId }));
    expect(one.rows.every((r) => r.workspace_id === t.workspaceId)).toBe(true);
    expect(one.derivation).toEqual([{ unit: 'creative_test', available: 5, parts: expect.arrayContaining([{ type: 'CREDIT_GRANTED', total: 7, n: 1, counted: true }, { type: 'CREDIT_CONSUMED', total: 1, n: 1, counted: false }]) }]);
    await expect(withAdmin((tx) => ledgerExplorer(tx, { jobId: 'not-an-id' }))).rejects.toThrow(/isn’t an id/);
  });
});

describe('COGS and margin (plan 05 §8)', () => {
  it('breaks spend down by modality, video resolution and duration, plan and experiment, with the fallback rate', async () => {
    const a = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const b = await makeTenant();
    const sku = await makeSku(a.workspaceId);
    const job = (ws: string, task: string, micros: number, units: Record<string, unknown>) =>
      ownerPool()`insert into provider_jobs (workspace_id, provider, task, model, request_hash, status, actual_micros, input_refs) values (${ws}, 'byteplus', ${task}, 'm', 'h', 'succeeded', ${micros}, ${ownerPool().json({ units } as never)})`;
    await job(a.workspaceId, 'video.scene', 3_000_000, { kind: 'video', seconds: 5, resolution: '1080p' });
    await job(a.workspaceId, 'video.scene', 2_000_000, { kind: 'video', seconds: 10, resolution: '720p' });
    await job(a.workspaceId, 'image.storyboard_frame', 40_000, { kind: 'image', images: 1 });
    await job(b.workspaceId, 'extract.product_facts', 60_000, { kind: 'llm' });
    // Scene versions of two scenes; one ended on a fallback technique (its storyboard chain is irrelevant here).
    const [s1, s2] = [newId(), newId()];
    await ownerPool().begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`insert into scene_versions (workspace_id, scene_id, version, kind, status, technique, lineage) values
                (${a.workspaceId}, ${s1}, 1, 'render', 'qa_failed', 'generative', '{}'),
                (${a.workspaceId}, ${s1}, 2, 'frame', 'accepted', 'exact_product_composite', ${sql.json({ fallback: true, reason: 'qa' })}),
                (${a.workspaceId}, ${s2}, 1, 'render', 'accepted', 'generative', '{}')`;
    });
    void sku;
    const r = await withAdmin((tx) => cogsBreakdown(tx, { days: 30 }));
    expect(Object.fromEntries(r.byModality.map((m) => [m.modality, Number(m.spend)]))).toEqual({ video: 5_000_000, image: 40_000, 'text (LLM)': 60_000 });
    expect(r.byVideo.map((v) => [v.resolution, v.duration, Number(v.spend)])).toEqual([['1080p', '≤5s', 3_000_000], ['720p', '6–10s', 2_000_000]]);
    expect(Object.fromEntries(r.byPlan.map((p) => [p.plan, Number(p.spend)]))).toEqual({ GROWTH: 5_040_000, 'no plan (free / one-off)': 60_000 });
    expect(r.fallback).toEqual({ scenes: 2, fallback: 1 });
  });

  it('flags only tenants below 0% margin in both of the last two periods', async () => {
    const cost = (ws: string, micros: number, daysAgo: number) =>
      ownerPool()`insert into ledger_entries (workspace_id, type, unit, amount, actor, idempotency_key, created_at) values (${ws}, 'PROVIDER_COST_RECORDED', 'usd_micros', ${micros}, 'system:test', ${newId()}, now() - make_interval(days => ${daysAgo}))`;
    const buy = (ws: string, micros: number, daysAgo: number) =>
      ownerPool()`insert into purchases (workspace_id, kind, amount_micros, status, created_by, paid_at) values (${ws}, 'taste', ${micros}, 'paid', 'test', now() - make_interval(days => ${daysAgo}))`;
    const losing = await makeTenant({ state: 'ACTIVE_PAID' });
    await buy(losing.workspaceId, usd(19), 5);
    await cost(losing.workspaceId, usd(25), 5);
    await buy(losing.workspaceId, usd(19), 40);
    await cost(losing.workspaceId, usd(22), 40);
    const once = await makeTenant({ state: 'ACTIVE_PAID' });
    await buy(once.workspaceId, usd(19), 5);
    await cost(once.workspaceId, usd(25), 5);
    await buy(once.workspaceId, usd(29), 40);
    await cost(once.workspaceId, usd(8), 40);
    const free = await makeTenant();
    await cost(free.workspaceId, usd(0.2), 5);
    await cost(free.workspaceId, usd(0.2), 40);
    // A subscriber: the mirrored invoice counts in the period it was paid; without one, the plan's list price.
    const sub = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, consent_record_id, created_at) values (${sub.workspaceId}, 'sub_m', 'GROWTH', 'active', gen_random_uuid(), now() - interval '50 days')`;
    await ownerPool()`insert into stripe_invoices (id, workspace_id, status, amount_paid_cents, payment_intent_id, stripe_created_at) values ('in_m', ${sub.workspaceId}, 'paid', 9900, 'pi_m', now() - interval '3 days')`;
    await ownerPool()`insert into refunds (workspace_id, payment_intent_id, amount_micros, reason_code, idempotency_key, status) values (${sub.workspaceId}, 'pi_m', ${usd(9)}, 'goodwill', 'r1', 'succeeded')`;
    await cost(sub.workspaceId, usd(10), 5);
    const m = await withAdmin((tx) => workspaceMargins(tx, {}));
    const by = Object.fromEntries(m.map((x) => [x.workspaceId, x]));
    expect(by[sub.workspaceId]!.periods.map((p) => p.revenue)).toEqual([usd(90), usd(99)]);
    expect(by[losing.workspaceId]!.flagged).toBe(true);
    expect(by[losing.workspaceId]!.periods[0]).toMatchObject({ revenue: usd(19), cogs: usd(25) });
    expect(by[once.workspaceId]!.flagged).toBe(false);
    expect(by[free.workspaceId]).toMatchObject({ flagged: false, periods: [{ revenue: 0, margin: null }, { revenue: 0, margin: null }] });
    expect(m[0]!.workspaceId).toBe(losing.workspaceId); // flagged first
  });
});

describe('provider invoice reconciliation (plan 05 §8)', () => {
  it('parses an invoice CSV, replaces a re-imported month, and reports the variance against recorded cost', async () => {
    expect(() => parseProviderInvoiceCsv('model,amount\nx,1')).toThrow(/month/);
    expect(() => parseProviderInvoiceCsv('month,model,amount\n2026-13,x,1')).toThrow(/Line 2/);
    const month = new Date().toISOString().slice(0, 7);
    const lines = parseProviderInvoiceCsv(`Billing Month,Model,Quantity,Unit,Amount (USD)\n${month},dreamina-seedance-2-5,300,seconds,"$1,010.00"\n${month}-28,seedream-5-0-pro,1000,images,40\n${month},dreamina-seedance-2-5,10,seconds,0.50`);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ period: `${month}-01`, amountMicros: 1_010_000_000, quantity: 300, unit: 'seconds' });
    const s = newId();
    await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${s}, 'fin@arkiv.test', 'Fin', 'x', '{FINANCE}')`;
    expect(await withAdmin((tx) => importProviderInvoice(tx, 'byteplus', lines, { staffId: s, batchId: newId() }))).toBe(2);
    const t = await makeTenant();
    const job = (model: string, micros: number) => ownerPool()`insert into provider_jobs (workspace_id, provider, task, model, request_hash, status, actual_micros) values (${t.workspaceId}, 'byteplus', 'video.scene', ${model}, 'h', 'succeeded', ${micros})`;
    await job('dreamina-seedance-2-5', 900_000_000);
    await job('dreamina-seedance-2-5', 100_000_000);
    await job('seedream-5-0-pro', 40_000_000);
    await job('seed-speech-2-0', 5_000_000); // recorded but not on the invoice
    const v = await withAdmin((tx) => providerInvoiceVariance(tx));
    const by = Object.fromEntries(v.map((x) => [x.model, x]));
    expect(by['dreamina-seedance-2-5']).toMatchObject({ invoicedMicros: 1_010_500_000, recordedMicros: 1_000_000_000, calls: 2, varianceMicros: 10_500_000 });
    expect(by['seedream-5-0-pro']).toMatchObject({ varianceMicros: 0, variancePct: 0 });
    expect(by['seed-speech-2-0']).toMatchObject({ invoicedMicros: null, recordedMicros: 5_000_000 });
    // A corrected invoice for the month replaces the old lines.
    await withAdmin((tx) => importProviderInvoice(tx, 'byteplus', parseProviderInvoiceCsv(`month,model,amount\n${month},dreamina-seedance-2-5,1000`), { staffId: s, batchId: newId() }));
    const [line] = await ownerPool()`select amount_micros from provider_invoice_lines where model = 'dreamina-seedance-2-5'`;
    expect(Number(line!.amount_micros)).toBe(1_000_000_000);
  });
});
