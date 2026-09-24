import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import type { NormalizedObservation } from '@arkiv/integrations';
import { newId, type Role } from '@arkiv/shared';
import { canExperimentTransition } from './experiment-state';
import {
  approveExperiment,
  autoLinkByCode,
  computeResults,
  createExperiment,
  describeLearning,
  experimentView,
  setExperimentState,
  signalUpdateWindow,
  VARIANT_CODE_RE,
  variantCode,
} from './experiments';
import { costPerUsableExport } from './finance';
import { meaningfulCoverage } from './genome';
import { append } from './ledger';
import { mockConcepts } from './mock-intel';
import { ingestObservations } from './performance';
import { decideFact } from './product-truth';
import { transition } from './projects';
import { scoringContext } from './recommendations';
import { DEFAULT_BASELINES, posterior } from './statistics';
import { generateStoryboard } from './storyboard';
import { ctxFor } from './testing';
import { produceHookVariants } from './variants';

/**
 * Experiment engine and learning integrity (standard §20, §21, §30, §35, §36): the state machine, approval,
 * variant codes, per-window results, baselines, what a learning is about, cross-experiment revision, concurrency.
 */
beforeEach(truncateAll);
afterAll(closeAll);

const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const proposal = () => mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;

function obs(adId: string, adName: string, date: string, holdShare: number, window = '7d_click_1d_view', starts = 2400): NormalizedObservation {
  const impressions = Math.round(starts / 0.6);
  return {
    platform: 'meta', accountId: 'act_1', campaignId: 'c1', adgroupId: 'as1', adId, adName, date, currency: 'USD',
    spendMicros: impressions * 12_000, impressions, reach: null, frequency: null, clicks: 48, outboundClicks: null,
    videoStarts: starts, video25: null, video50: null, video75: Math.round(starts * holdShare), video100: null, avgWatchMs: null,
    addToCart: null, checkout: null, purchases: 1, purchaseValueMicros: 38_000_000,
    attributionModel: 'meta_default', attributionWindow: window, optimizationEvent: 'OFFSITE_CONVERSIONS', campaignType: 'OUTCOME_SALES',
    measurementContext: 'META_PAID_ATTRIBUTED',
  };
}

async function tenant() {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const skuId = await makeSku(t.workspaceId);
  return { t, ctx, skuId };
}

/** A live experiment on the SKU, its variants in code order, and helpers to feed and compute it. */
async function liveExperiment(env: Awaited<ReturnType<typeof tenant>>, p = proposal()) {
  const { t, ctx, skuId } = env;
  const { experimentId } = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: p, slot: 'EXPAND' }));
  await ownerPool()`update experiments set state = 'READY_TO_RUN' where id = ${experimentId}`;
  const variants = await ownerPool()`select id, code, label from variants where experiment_id = ${experimentId} order by code`;
  const ingest = (hold: number[], opts: { window?: string; days?: number; prefix?: string } = {}) => {
    const rows: NormalizedObservation[] = [];
    for (let d = 1; d <= (opts.days ?? 6); d++) variants.forEach((v, i) => rows.push(obs(`${opts.prefix ?? experimentId}-${i}`, `Serum ${v.code}`, day(d + 1), hold[i]!, opts.window)));
    return withTenant(t.workspaceId, (tx) => ingestObservations(tx, ctx, null, rows));
  };
  const compute = () => withTenant(t.workspaceId, (tx) => computeResults(tx, ctx, experimentId));
  return { experimentId, variants, ingest, compute };
}

async function addMember(workspaceId: string, role: Role) {
  const [u] = await ownerPool()`insert into users (email) values (${`m-${newId().slice(-10)}@example.com`}) returning id`;
  await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${u!.id}, ${role})`;
  return u!.id as string;
}

describe('experiment state machine (§35)', () => {
  it('lists every edge: no going live before the ads exist, no rewinding a side state, terminal states stay put', () => {
    expect(canExperimentTransition('RECOMMENDED', 'APPROVED')).toBe(true);
    expect(canExperimentTransition('APPROVED', 'GATHERING_SIGNAL')).toBe(false);
    expect(canExperimentTransition('PRODUCING', 'GATHERING_SIGNAL')).toBe(false);
    expect(canExperimentTransition('READY_TO_RUN', 'GATHERING_SIGNAL')).toBe(true);
    expect(canExperimentTransition('INCONCLUSIVE', 'DRAFT')).toBe(false);
    expect(canExperimentTransition('OPERATIONALLY_CONFOUNDED', 'PRODUCING')).toBe(false);
    expect(canExperimentTransition('ACTIONABLE', 'DIRECTIONAL')).toBe(true); // late conversions revise
    expect(canExperimentTransition('PRODUCING', 'APPROVED')).toBe(true); // failed production, retryable
    expect(canExperimentTransition('ARCHIVED', 'GATHERING_SIGNAL')).toBe(false);
    expect(canExperimentTransition('INVALIDATED', 'READY_TO_RUN')).toBe(false);
  });

  it('a recommendation becomes a RECOMMENDED experiment; the project moves through its guarded, evented transition', async () => {
    const env = await tenant();
    const [rec] = await ownerPool()`insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, basis)
                                    values (${env.t.workspaceId}, ${env.skuId}, '2026-09-21', 'EXPAND', ${ownerPool().json(proposal() as never)}, 0.5, '{}', 'cold_start') returning id`;
    const r = await withTenant(env.t.workspaceId, (tx) => createExperiment(tx, env.ctx, { skuId: env.skuId, proposal: proposal(), recommendationId: rec!.id as string, slot: 'EXPAND' }));
    const [e] = await ownerPool()`select state from experiments where id = ${r.experimentId}`;
    expect(e!.state).toBe('RECOMMENDED');
    const draft = await withTenant(env.t.workspaceId, (tx) => createExperiment(tx, env.ctx, { skuId: env.skuId, proposal: { ...proposal(), angle: 'ROUTINE' } }));
    expect((await ownerPool()`select state from experiments where id = ${draft.experimentId}`)[0]!.state).toBe('DRAFT');
    // arch-12: the project's state change is evented and versioned like every other transition.
    const [p] = await ownerPool()`select state, state_version from projects where id = ${r.projectId}`;
    expect(p!.state).toBe('CONCEPT_SELECTED');
    expect(Number(p!.state_version)).toBeGreaterThan(Number((await ownerPool()`select column_default from information_schema.columns where table_name = 'projects' and column_name = 'state_version'`)[0]!.column_default));
    const ev = await ownerPool()`select payload from events where type = 'PROJECT_STATE_CHANGED' and subject_id = ${r.projectId}`;
    expect(ev.map((x) => x.payload)).toEqual([expect.objectContaining({ from: 'CONCEPTS_READY', to: 'CONCEPT_SELECTED' })]);
  });

  it('approval is its own evented step, once; a failed master production returns the test to APPROVED, a retry resumes it, a cancel archives it', async () => {
    const env = await tenant();
    const { t, ctx, skuId } = env;
    await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 3, periodKey: '2026-09-01', idempotencyKey: 'grant:x' }));
    const r = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal: proposal() }));
    const [c] = await ownerPool()`select selected_concept_id from projects where id = ${r.projectId}`;
    await generateStoryboard(ctx, r.projectId, r.storyboardId, c!.selected_concept_id as string);

    // Not before the ads exist: the merchant can't mark a draft as live.
    await expect(withTenant(t.workspaceId, (tx) => setExperimentState(tx, ctx, r.experimentId, 'GATHERING_SIGNAL', 'merchant marked as running'))).rejects.toMatchObject({ code: 'CONFLICT' });
    // Viewers can't approve spend.
    const viewer = ctxFor(t.workspaceId, await addMember(t.workspaceId, 'VIEWER'), 'VIEWER', 'ACTIVE_PAID');
    await expect(withTenant(t.workspaceId, (tx) => approveExperiment(tx, viewer, r.experimentId))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await withTenant(t.workspaceId, (tx) => approveExperiment(tx, ctx, r.experimentId))).toMatchObject({ changed: true, projectId: r.projectId });
    expect(await withTenant(t.workspaceId, (tx) => approveExperiment(tx, ctx, r.experimentId))).toMatchObject({ changed: false });
    const [e] = await ownerPool()`select state, approved_by, approved_at from experiments where id = ${r.experimentId}`;
    expect(e).toMatchObject({ state: 'PRODUCING', approved_by: `user:${t.userId}` });
    expect(e!.approved_at).toBeTruthy();
    const approved = await ownerPool()`select payload, refs from events where type = 'EXPERIMENT_APPROVED' and subject_id = ${r.experimentId}`;
    expect(approved).toHaveLength(1);
    expect(approved[0]!.payload).toMatchObject({ projectId: r.projectId, entitlementUnit: 'creative_test' });
    expect(approved[0]!.refs).toMatchObject({ experimentId: r.experimentId, projectId: r.projectId, skuId });
    const states = async () => (await ownerPool()`select payload->>'to' as to from events where type = 'EXPERIMENT_STATE_CHANGED' and subject_id = ${r.experimentId} order by seq`).map((x) => x.to);
    expect(await states()).toEqual(['APPROVED', 'PRODUCING']);

    const sys = { workspaceId: t.workspaceId, actor: { kind: 'system' as const, id: 'job' } };
    await withTenant(t.workspaceId, (tx) => transition(tx, sys, r.projectId, 'PROVIDER_FAILED', { reason: 'x', code: 'provider_outage' }));
    expect((await ownerPool()`select state from experiments where id = ${r.experimentId}`)[0]!.state).toBe('APPROVED');
    await withTenant(t.workspaceId, (tx) => transition(tx, sys, r.projectId, 'STORYBOARD_APPROVED'));
    expect((await ownerPool()`select state from experiments where id = ${r.experimentId}`)[0]!.state).toBe('PRODUCING');
    await withTenant(t.workspaceId, (tx) => transition(tx, sys, r.projectId, 'CANCELLED'));
    expect((await ownerPool()`select state from experiments where id = ${r.experimentId}`)[0]!.state).toBe('ARCHIVED');
    expect(await states()).toEqual(['APPROVED', 'PRODUCING', 'APPROVED', 'PRODUCING', 'ARCHIVED']);
    expect(await ownerPool()`select 1 from events where type = 'EXPERIMENT_APPROVED' and subject_id = ${r.experimentId}`).toHaveLength(1);
  }, 60_000);

  it('a test whose hook variants could not be made is INVALIDATED, not launched as a one-ad test', async () => {
    const { t, ctx, skuId } = await tenant();
    const [e] = await ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, primary_metric, mode, state, created_by)
                                  values (${t.workspaceId}, ${skuId}, 'h', 'hook', 'hold_rate', 'CONTROLLED', 'PRODUCING', 'test') returning id`;
    const [cr] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin) values (${t.workspaceId}, ${skuId}, 'generated') returning id`;
    const projectId = newId();
    const [m] = await ownerPool()`insert into variants (workspace_id, experiment_id, label, code, role, project_id, creative_id)
                                  values (${t.workspaceId}, ${e!.id}, 'Hook A', 'AK-001-A', 'variant', ${projectId}, ${cr!.id}) returning id`;
    await ownerPool()`insert into variants (workspace_id, experiment_id, label, code, role) values (${t.workspaceId}, ${e!.id}, 'Hook B', 'AK-001-B', 'variant'), (${t.workspaceId}, ${e!.id}, 'Hook C', 'AK-001-C', 'variant')`;
    await ownerPool()`insert into projects (id, workspace_id, sku_id, experiment_id, variant_id, kind, state, created_by, final_creative_id)
                      values (${projectId}, ${t.workspaceId}, ${skuId}, ${e!.id}, ${m!.id}, 'creative_test', 'COMPLETE', 'test', ${cr!.id})`;
    expect(await produceHookVariants(ctx, projectId)).toBe(0); // the master has no composition record: nothing to hold constant
    expect((await ownerPool()`select state from experiments where id = ${e!.id}`)[0]!.state).toBe('INVALIDATED');
  });
});

describe('variant codes (§30: observations attribute to the right variant)', () => {
  it('codes never repeat across experiments on a SKU, 4-digit catalogue numbers auto-link, and only live tests receive results', async () => {
    const env = await tenant();
    expect(variantCode(14, 1)).toBe('AK-014-B');
    expect(variantCode(14, 0, 3)).toBe('AK-014-3A');
    expect(VARIANT_CODE_RE.exec('SERUM AK-1000-2B TEXTURE')?.[0]).toBe('AK-1000-2B');
    await ownerPool()`update skus set catalogue_no = 1000 where id = ${env.skuId}`;
    const a = await liveExperiment(env);
    const b = await liveExperiment(env, { ...proposal(), angle: 'ROUTINE' });
    expect(a.variants.map((v) => v.code)).toEqual(['AK-1000-A', 'AK-1000-B', 'AK-1000-C']);
    expect(b.variants.map((v) => v.code)).toEqual(['AK-1000-2A', 'AK-1000-2B', 'AK-1000-2C']);
    await expect(ownerPool()`insert into variants (workspace_id, experiment_id, label, code, role) values (${env.t.workspaceId}, ${a.experimentId}, 'dup', 'AK-1000-A', 'variant')`).rejects.toThrow(/variants_workspace_code/);

    await b.ingest([0.2, 0.2, 0.2], { days: 1 });
    await a.ingest([0.2, 0.2, 0.2], { days: 1 });
    const linked = await ownerPool()`select o.ad_id, v.code from performance_observations o join variants v on v.id = o.variant_id order by v.code`;
    expect(linked.map((l) => l.code)).toEqual(['AK-1000-2A', 'AK-1000-2B', 'AK-1000-2C', 'AK-1000-A', 'AK-1000-B', 'AK-1000-C']);
    expect(linked.find((l) => l.code === 'AK-1000-2A')!.ad_id).toBe(`${b.experimentId}-0`);

    // An archived test's code no longer captures new ads.
    await ownerPool()`update experiments set state = 'ARCHIVED' where id = ${a.experimentId}`;
    expect(await withTenant(env.t.workspaceId, (tx) => autoLinkByCode(tx, 'meta', 'late-ad', 'Serum AK-1000-A'))).toBeNull();
  });
});

describe('results per measurement context and attribution window (§30, §21)', () => {
  it('never pools two attribution windows, and shrinks toward the account baseline rather than a fixed default', async () => {
    const env = await tenant();
    // Account history in this context: unlinked ads with a much higher hold rate than the default assumption.
    const history: NormalizedObservation[] = [];
    for (let d = 10; d < 20; d++) history.push(obs(`hist-${d}`, 'Old ad', day(d), 0.5, '7d_click_1d_view', 2000));
    await withTenant(env.t.workspaceId, (tx) => ingestObservations(tx, env.ctx, null, history));

    const x = await liveExperiment(env);
    await x.ingest([0.1, 0.12, 0.1], { days: 2 });
    await x.ingest([0.3, 0.1, 0.1], { days: 2, window: '1d_view', prefix: `view-${x.experimentId}` });
    await x.compute();
    const rows = await ownerPool()`select variant_id, attribution_window, trials::float8 as trials, successes::float8 as successes, posterior_mean::float8 as mean
                                   from experiment_results where experiment_id = ${x.experimentId} and metric = 'hold_rate' order by attribution_window, variant_id`;
    expect(new Set(rows.map((r) => r.attribution_window))).toEqual(new Set(['1d_view', '7d_click_1d_view']));
    for (const r of rows) expect(r.trials).toBe(2 * 2400); // each window only its own rows
    // Pulled toward the account's 50% hold rate, not the default 18%.
    const r0 = rows.find((r) => r.attribution_window === '7d_click_1d_view')!;
    expect(r0.mean).toBeGreaterThan(posterior({ successes: r0.successes, trials: r0.trials }, DEFAULT_BASELINES.hold_rate).mean + 0.01);
  });
});

describe('learnings say what the comparison showed (§20, §21)', () => {
  it('a hook comparison is worded and keyed on the winning hook, never as the angle winning', () => {
    const variants = [
      { id: 'a', role: 'variant', label: 'Watch it disappear', genes: { angle: 'TEXTURE_SENSORY', hook: 'Watch it disappear' } },
      { id: 'b', role: 'variant', label: 'No sticky finish', genes: { angle: 'TEXTURE_SENSORY', hook: 'No sticky finish' } },
      { id: 'c', role: 'variant', label: 'Layers under makeup', genes: { angle: 'TEXTURE_SENSORY', hook: 'Layers under makeup' } },
    ];
    const d = describeLearning({ variants, comparedIds: ['a', 'b', 'c'], leaderId: 'b', primaryVariable: 'hook', mode: 'EXPLORATORY', experimentGenes: { angle: 'TEXTURE_SENSORY' }, state: 'ACTIONABLE', metric: 'hold_rate', context: 'META_PAID_ATTRIBUTED' });
    expect(d.variable).toBe('hook');
    expect(d.winnerGenes).toEqual({ hook: 'No sticky finish' });
    expect(d.loserGenes).toEqual({ hook: ['Watch it disappear', 'Layers under makeup'] });
    expect(d.statement).toContain('the hook “No sticky finish” is stronger on hold rate than “Watch it disappear” and “Layers under makeup”');
    expect(d.statement).not.toMatch(/texture sensory direction/i);
    expect(d.statement).toMatch(/wider direction is still untested/);

    // With the merchant's control in the comparison, the master differs from it on the declared variable.
    const withControl = describeLearning({ variants: [...variants, { id: 'k', role: 'control', label: 'Current control' }], comparedIds: ['a', 'k'], leaderId: 'a', primaryVariable: 'angle', mode: 'CONTROLLED', experimentGenes: { angle: 'TEXTURE_SENSORY' }, state: 'DIRECTIONAL', metric: 'ctr', context: 'TIKTOK_PAID_ATTRIBUTED' });
    expect(withControl).toMatchObject({ variable: 'angle', winnerGenes: { angle: 'TEXTURE_SENSORY' }, loserGenes: { angle: ['current control'] } });
    expect(withControl.statement).toBe('For this SKU on TikTok, the new angle (TEXTURE_SENSORY) is ahead of the current control on ctr.');
  });

  it('a learning records its variable, winner/loser genes, shrunk effect and a confidence equal to the leader’s P(best)', async () => {
    const env = await tenant();
    const x = await liveExperiment(env);
    await x.ingest([0.1, 0.32, 0.1]);
    expect((await x.compute()).state).toBe('ACTIONABLE');
    const [l] = await ownerPool()`select statement, variable, winner_genes, loser_genes, effect::float8 as effect, confidence::float8 as confidence, attribution_window from learnings`;
    expect(l).toMatchObject({ variable: 'hook', winner_genes: { hook: x.variants[1]!.label }, attribution_window: '7d_click_1d_view' });
    expect((l!.loser_genes as { hook: string[] }).hook.sort()).toEqual([x.variants[0]!.label, x.variants[2]!.label].sort());
    expect(l!.effect).toBeGreaterThan(0.5);
    const [pb] = await ownerPool()`select prob_best::float8 as p from experiment_results where variant_id = ${x.variants[1]!.id} and metric = 'hold_rate'`;
    expect(l!.confidence).toBeCloseTo(pb!.p, 6);
    // Recomputing with unchanged numbers is not new evidence: no second history entry.
    await x.compute();
    const [again] = await ownerPool()`select history from learnings`;
    expect(again!.history).toHaveLength(1);
  });

  it('another experiment that reverses the learning’s winning and losing hooks contradicts and invalidates it', async () => {
    const env = await tenant();
    const p = proposal();
    const first = await liveExperiment(env, p);
    await first.ingest([0.1, 0.32, 0.1]);
    await first.compute();
    const [l] = await ownerPool()`select id, state from learnings`;
    expect(l!.state).toBe('ACTIONABLE');
    // A second test re-runs the winning hook (B's) against a losing one (A's) plus a new hook: A's hook wins clearly.
    const second = await liveExperiment(env, { ...p, angle: 'ROUTINE', hookOptions: [p.hookOptions[1]!, p.hookOptions[0]!, 'A brand new opening'] });
    await second.ingest([0.1, 0.32, 0.1]);
    await second.compute();
    const [after] = await ownerPool()`select state, contradicting_experiments, supporting_experiments from learnings where id = ${l!.id}`;
    expect(after!.state).toBe('INVALIDATED');
    expect(after!.contradicting_experiments).toEqual([second.experimentId]);
    expect(after!.supporting_experiments).toEqual([first.experimentId]);
    expect(await ownerPool()`select 1 from events where type = 'LEARNING_INVALIDATED' and subject_id = ${l!.id}`).toHaveLength(1);
  });

  it('two concurrent computations never create the same learning twice (x-races-15)', async () => {
    const env = await tenant();
    const x = await liveExperiment(env);
    await x.ingest([0.1, 0.32, 0.1]);
    await Promise.all([x.compute(), x.compute(), x.compute()]);
    expect(await ownerPool()`select id from learnings`).toHaveLength(1);
    expect(await ownerPool()`select 1 from events where type = 'LEARNING_CREATED'`).toHaveLength(1);
  });

  it('a price change weakens the SKU’s learnings and marks running tests as confounded (§21, §45)', async () => {
    const env = await tenant();
    const x = await liveExperiment(env);
    await x.ingest([0.1, 0.32, 0.1]);
    await x.compute();
    await withTenant(env.t.workspaceId, (tx) => decideFact(tx, env.ctx, env.skuId, 'price', { number: 38 }));
    expect((await ownerPool()`select state from learnings`)[0]!.state).toBe('ACTIONABLE'); // a first price is not a change
    await withTenant(env.t.workspaceId, (tx) => decideFact(tx, env.ctx, env.skuId, 'price', { number: 44 }));
    const [l] = await ownerPool()`select id, state from learnings`;
    expect(l!.state).toBe('WEAKENING');
    expect(await ownerPool()`select payload from events where type = 'LEARNING_WEAKENED' and subject_id = ${l!.id}`).toEqual([{ payload: expect.objectContaining({ reason: 'price changed' }) }]);
    const [c] = await ownerPool()`select kind, source, ends_at from confounders`;
    expect(c).toMatchObject({ kind: 'price_change', source: 'automatic' });
    expect((await ownerPool()`select state from experiments where id = ${x.experimentId}`)[0]!.state).toBe('OPERATIONALLY_CONFOUNDED');
  });
});

describe('midweek signal update (§11)', () => {
  it('belongs to this week’s Wednesday window, or next week’s from Friday on', () => {
    expect(signalUpdateWindow(new Date('2026-09-21T09:00:00Z'))).toMatchObject({ key: '2026-09-23', runAt: new Date('2026-09-23T15:00:00Z') }); // Monday
    const thu = new Date('2026-09-24T10:00:00Z');
    expect(signalUpdateWindow(thu)).toMatchObject({ key: '2026-09-23', runAt: thu }); // Thursday: now
    expect(signalUpdateWindow(new Date('2026-09-26T10:00:00Z')).key).toBe('2026-09-30'); // Saturday → next Wednesday
  });

  it('a threshold crossing queues one signal update per workspace per window', async () => {
    const env = await tenant();
    const x = await liveExperiment(env);
    await x.ingest([0.1, 0.32, 0.1]);
    await x.compute();
    const y = await liveExperiment(env, { ...proposal(), angle: 'ROUTINE' });
    await y.ingest([0.1, 0.32, 0.1]);
    await y.compute();
    const q = await ownerPool()`select payload, singleton_key from outbox where queue = 'send-email' and payload->>'template' = 'signal_update'`;
    expect(q).toHaveLength(1);
    expect(q[0]!.singleton_key).toBe(`signal:${signalUpdateWindow().key}`);
  });
});

describe('connections and coverage (§31, §20)', () => {
  it('a removed ad account neither downgrades the basis nor raises the results banner; a stale one does', async () => {
    const env = await tenant();
    const x = await liveExperiment(env);
    const [i] = await ownerPool()`insert into integrations (workspace_id, provider, external_account_id, status, last_success_at)
                                  values (${env.t.workspaceId}, 'meta', 'act_old', 'disconnected', now() - interval '30 days') returning id`;
    const sc = await withTenant(env.t.workspaceId, (tx) => scoringContext(tx, env.skuId));
    expect(sc.basis).toBe('cold_start');
    expect((await withTenant(env.t.workspaceId, (tx) => experimentView(tx, x.experimentId))).freshness).toBeNull();
    await ownerPool()`update integrations set status = 'active' where id = ${i!.id}`; // connected again, last synced a month ago
    expect((await withTenant(env.t.workspaceId, (tx) => scoringContext(tx, env.skuId))).basis).toBe('context_limited');
    expect((await withTenant(env.t.workspaceId, (tx) => experimentView(tx, x.experimentId))).freshness).toMatchObject({ stale: true, degraded: false });
    await ownerPool()`update integrations set last_success_at = now() where id = ${i!.id}`;
    expect((await withTenant(env.t.workspaceId, (tx) => experimentView(tx, x.experimentId))).freshness).toMatchObject({ stale: false });
  });

  it('only readable or delivered tests count as coverage; archived, unlaunched and trivial ones do not', async () => {
    const { t, skuId } = await tenant();
    const exp = (angle: string, hook: string, state: string) =>
      ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, primary_metric, mode, state, created_by, genes)
                  values (${t.workspaceId}, ${skuId}, 'h', 'hook', 'ctr', 'CONTROLLED', ${state}, 'test', ${ownerPool().json({ angle, hookMechanism: hook, treatment: 'HYBRID' })}) returning id`;
    await exp('ROUTINE', 'LIST', 'ARCHIVED'); // never launched
    await exp('TEXTURE_SENSORY', 'DEMONSTRATION', 'DIRECTIONAL');
    const [g] = await exp('SOCIAL_PROOF', 'QUESTION', 'GATHERING_SIGNAL');
    const [small] = await exp('MYTH_BUSTING', 'MYTH', 'GATHERING_SIGNAL');
    const [v] = await ownerPool()`insert into variants (workspace_id, experiment_id, label, code, role) values (${t.workspaceId}, ${g!.id}, 'x', 'AK-9-A', 'variant') returning id`;
    const [v2] = await ownerPool()`insert into variants (workspace_id, experiment_id, label, code, role) values (${t.workspaceId}, ${small!.id}, 'y', 'AK-9-B', 'variant') returning id`;
    await ownerPool()`insert into experiment_results (workspace_id, experiment_id, variant_id, measurement_context, metric, successes, trials, state)
                      values (${t.workspaceId}, ${g!.id}, ${v!.id}, 'META_PAID_ATTRIBUTED', 'ctr', 120, 12000, 'GATHERING_SIGNAL'),
                             (${t.workspaceId}, ${small!.id}, ${v2!.id}, 'META_PAID_ATTRIBUTED', 'ctr', 3, 300, 'GATHERING_SIGNAL')`;
    const imported = async (angle: string, impressions: number) => {
      const [c] = await ownerPool()`insert into creatives (workspace_id, sku_id, origin, genome) values (${t.workspaceId}, ${skuId}, 'imported', ${ownerPool().json({ angle, hookMechanism: 'QUESTION', treatment: 'RAW_UGC' })}) returning id`;
      await ownerPool()`insert into performance_observations (workspace_id, platform, account_id, ad_id, creative_id, date, currency, impressions, measurement_context)
                        values (${t.workspaceId}, 'meta', 'act', ${`imp-${angle}`}, ${c!.id}, ${day(3)}, 'USD', ${impressions}, 'META_PAID_ATTRIBUTED')`;
    };
    await imported('PROBLEM_SOLUTION', 9000);
    await imported('FAQ_RESPONSE', 200);
    const cov = await withTenant(t.workspaceId, (tx) => meaningfulCoverage(tx, skuId));
    expect(Object.fromEntries(cov.angles)).toEqual({ TEXTURE_SENSORY: 1, SOCIAL_PROOF: 1, PROBLEM_SOLUTION: 1 });
    expect(cov.cells.has('TEXTURE_SENSORY|DEMONSTRATION')).toBe(true);
    expect(cov.cells.has('PROBLEM_SOLUTION|t:RAW_UGC')).toBe(true);
  });
});

describe('cost per usable export (Appendix C)', () => {
  it('divides all variable cost but the free preview by the distinct paid ads customers exported', async () => {
    const { t, skuId } = await tenant();
    const ws = t.workspaceId;
    const project = async (kind: string) => {
      const id = newId();
      await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by) values (${id}, ${ws}, ${skuId}, ${kind}, 'COMPLETE', 'test')`;
      return id;
    };
    const exportOf = async (projectId: string, aspect: string, variantId?: string, times = 1) => {
      const [a] = await ownerPool()`insert into assets (workspace_id, sku_id, kind, mime, bytes, checksum_sha256, storage_key, source, lineage)
                                    values (${ws}, ${skuId}, 'final_export', 'video/mp4', 1, ${newId()}, ${newId()}, 'composed', ${ownerPool().json({ projectId, aspect, ...(variantId ? { variantId } : {}) })}) returning id`;
      for (let i = 0; i < times; i++) await ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${ws}, 'ASSET_EXPORTED', 'user:x', 'asset', ${a!.id}, '{}')`;
    };
    const test = await project('creative_test');
    await exportOf(test, '9x16', undefined, 2); // downloaded twice
    await exportOf(test, '4x5'); // same ad, another format
    await exportOf(test, '9x16', newId()); // a hook variant: its own output
    const taste = await project('taste');
    await exportOf(taste, '9x16');
    await project('standalone'); // composed, never downloaded
    const preview = await project('preview');
    await exportOf(preview, '9x16');
    const cost = async (purpose: string, amount: number) => {
      const [a] = await ownerPool()`insert into cost_authorizations (workspace_id, purpose, token_hash, idempotency_key, rate_table_versions, estimate, max_cost_micros, expires_at)
                                    values (${ws}, ${purpose}, ${newId()}, ${newId()}, '{}', '{}', ${amount}, now() + interval '1 hour') returning id`;
      await ownerPool()`insert into ledger_entries (workspace_id, type, unit, amount, authorization_id, actor, idempotency_key)
                        values (${ws}, 'PROVIDER_COST_RECORDED', 'usd_micros', ${amount}, ${a!.id}, 'system:x', ${newId()})`;
    };
    await cost('creative_test', 6_000_000);
    await cost('taste', 3_000_000);
    await cost('free_preview', 900_000);
    const r = await withAdmin((tx) => costPerUsableExport(tx, { days: 30, includeTest: true }));
    expect(r).toEqual({ costMicros: 9_000_000, outputs: 3, perOutputMicros: 3_000_000 });
  });
});
