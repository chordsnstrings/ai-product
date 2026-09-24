import { performance } from 'node:perf_hooks';
import { withSystem, withTenant, type Tx } from '@arkiv/db';
import { DomainError, type ExperimentState } from '@arkiv/shared';
import { assertBreakGlass, assertStaff, audit, type Staff } from './admin';
import { classifyClaim, isFirstPersonTestimonial, scanCreativeText } from './compliance';
import { systemContext } from './context';
import { authorize, settle } from './cost-governor';
import { withConfounders } from './experiments';
import { ProductExtraction } from './intel-schemas';
import { mockExtraction } from './mock-intel';
import { lineFor, llmJson } from './model-gateway';
import { findPrompt, latestPrompt, parsePromptRef } from './prompts';
import { compareVariants, DEFAULT_BASELINES } from './statistics';

/**
 * Golden datasets and eval runs (plan 05 §11, standard §51). Seed cases live here (synthetic or written by
 * staff); staff extend a dataset in the console with synthetic reproductions or, with the tenant's explicit
 * consent and under break-glass, cases from production failures (golden_cases). Production tenant content is
 * never copied into a golden set without consent.
 *
 * Rules datasets are scored against the deterministic engines (claims rules, compliance scan, statistics).
 * Model datasets run every case through the Model Gateway on the candidate template × model — priced, debited
 * and recorded like any call, under a Cost Governor authorization of the internal evals workspace — and keep
 * per-case latency and cost.
 */
export interface GoldenCase {
  id: string;
  input: string;
  expect: string;
  note?: string;
  source?: 'seed' | 'synthetic' | 'production';
}

export interface DatasetInfo {
  category: string;
  description: string;
  kind: 'rules' | 'model';
  /** Model datasets: the route task (and template family) the cases run on. */
  task?: string;
  prompt?: string;
}

export const DATASETS: Record<string, DatasetInfo> = {
  'compliance.classify': { category: 'Claims allowed / ambiguous / blocked', description: 'Claim wording → the status the deterministic claims rules must assign (§17, §43).', kind: 'rules' },
  'compliance.scan': { category: 'Creative copy scan', description: 'An ad line → pass or block by the whole-creative compliance scan (§25 check 3). Gates creative routes.', kind: 'rules' },
  'reviews.deceptive': {
    category: 'Deceptive review language',
    description: 'Customer-review lines proposed as copy for a generated presenter: first-person testimonials and drug-outcome language must be blocked (§40, §43).',
    kind: 'rules',
  },
  'performance.confounded': {
    category: 'Confounded performance',
    description: 'Two-variant CTR results (impressions, clicks, days) with or without an overlapping operational confounder → the experiment state (§21, §45).',
    kind: 'rules',
  },
  'extract.packaging': {
    category: 'Packaging types',
    description: 'Product page text → the packaging type the product analyst extracts. Runs on the extract.product_facts route.',
    kind: 'model',
    task: 'extract.product_facts',
    prompt: 'extract-product',
  },
};

/** Two-variant CTR result for the confounded-performance set: [impressions, clicks, days] per variant. */
const perf = (a: [number, number, number], b: [number, number, number], confounders: number) => JSON.stringify({ a, b, confounders });

export const GOLDEN: Record<string, GoldenCase[]> = {
  'compliance.classify': [
    { id: 'cc-01', input: 'Cures acne overnight', expect: 'BLOCKED', note: 'drug claim: treats a condition' },
    { id: 'cc-02', input: 'Heals eczema', expect: 'BLOCKED' },
    { id: 'cc-03', input: 'Repairs the skin barrier at a cellular level', expect: 'BLOCKED', note: 'structure/function' },
    { id: 'cc-04', input: 'Boosts collagen production', expect: 'BLOCKED' },
    { id: 'cc-05', input: 'Removes wrinkles permanently', expect: 'BLOCKED' },
    { id: 'cc-06', input: 'Protects against sunburn', expect: 'BLOCKED', note: 'SPF is an OTC drug claim' },
    { id: 'cc-07', input: 'Clinically proven to reduce redness', expect: 'RESTRICTED', note: 'needs evidence review' },
    { id: 'cc-08', input: 'Dermatologist recommended', expect: 'MERCHANT_REVIEW_REQUIRED', note: 'high risk: approval requires attached evidence' },
    { id: 'cc-09', input: 'Skin feels softer', expect: 'MERCHANT_REVIEW_REQUIRED' },
    { id: 'cc-10', input: 'Lightweight gel texture', expect: 'MERCHANT_REVIEW_REQUIRED' },
    { id: 'cc-11', input: 'Fragrance-free formula', expect: 'MERCHANT_REVIEW_REQUIRED' },
    { id: 'cc-12', input: 'Visibly reduces the look of fine lines', expect: 'VERIFIED_WITH_QUALIFIER', note: 'cosmetic appearance claim; still merchant-approved' },
    { id: 'cc-13', input: 'Blocks UVA and UVB rays', expect: 'BLOCKED' },
    { id: 'cc-14', input: 'Works at a cellular level', expect: 'BLOCKED' },
  ],
  'compliance.scan': [
    { id: 'cs-01', input: 'This serum treats acne in a week.', expect: 'block' },
    { id: 'cs-02', input: 'My skin looks so dewy in the morning.', expect: 'pass' },
    { id: 'cs-03', input: 'Say goodbye to eczema flare-ups.', expect: 'block' },
    { id: 'cs-04', input: 'A silky texture that sinks right in.', expect: 'pass' },
    { id: 'cs-05', input: 'Stimulates cell regeneration.', expect: 'block' },
  ],
  'reviews.deceptive': [
    { id: 'rd-01', input: 'I have used it for two weeks and my skin has never looked better.', expect: 'block', note: 'first-person testimonial from a generated person' },
    { id: 'rd-02', input: 'This cured my eczema in days.', expect: 'block', note: 'drug outcome' },
    { id: 'rd-03', input: 'Honestly my holy grail, I swear by it.', expect: 'block', note: 'endorsement voiced as a customer' },
    { id: 'rd-04', input: 'Customers call the texture silky and lightweight.', expect: 'pass', note: 'attributed, descriptive' },
    { id: 'rd-05', input: 'A gel texture that sinks right in.', expect: 'pass' },
    { id: 'rd-06', input: 'It healed my acne scars completely.', expect: 'block', note: 'drug outcome' },
  ],
  'performance.confounded': [
    { id: 'pc-01', input: perf([40000, 800, 7], [40000, 480, 7], 0), expect: 'ACTIONABLE', note: 'clear winner, clean period' },
    { id: 'pc-02', input: perf([40000, 800, 7], [40000, 480, 7], 1), expect: 'OPERATIONALLY_CONFOUNDED', note: 'same result during a stock-out' },
    { id: 'pc-03', input: perf([900, 12, 2], [900, 9, 2], 0), expect: 'GATHERING_SIGNAL', note: 'tiny sample: no call either way' },
    { id: 'pc-04', input: perf([900, 12, 2], [900, 9, 2], 2), expect: 'GATHERING_SIGNAL', note: 'a confounder does not manufacture a result' },
  ],
  'extract.packaging': [
    { id: 'ep-01', input: 'Dew Drop Hydrating Serum. Hyaluronic acid serum, 30 ml.', expect: 'dropper_bottle' },
    { id: 'ep-02', input: 'Cloud Night Cream. A rich moisturizer for dry skin, 50 ml.', expect: 'jar' },
    { id: 'ep-03', input: 'Soft Foam Cleanser. A gentle foaming face wash, 150 ml.', expect: 'pump_bottle' },
    { id: 'ep-04', input: 'Rosehip Facial Oil. Cold-pressed face oil, 30 ml.', expect: 'dropper_bottle' },
    { id: 'ep-05', input: 'Clay Detox Mask. A kaolin clay mask, 75 ml.', expect: 'jar' },
  ],
};

/** Datasets a staff member can extend (and the expected labels each accepts). */
export const EXPECTED_LABELS: Record<string, readonly string[]> = {
  'compliance.classify': ['VERIFIED', 'VERIFIED_WITH_QUALIFIER', 'MERCHANT_REVIEW_REQUIRED', 'RESTRICTED', 'BLOCKED', 'INFERRED_ONLY'],
  'compliance.scan': ['pass', 'block'],
  'reviews.deceptive': ['pass', 'block'],
  'performance.confounded': ['GATHERING_SIGNAL', 'DIRECTIONAL', 'ACTIONABLE', 'INCONCLUSIVE', 'OPERATIONALLY_CONFOUNDED'],
  'extract.packaging': ['dropper_bottle', 'pump_bottle', 'jar', 'tube', 'spray', 'stick', 'bottle', 'other'],
};

/** Seed cases plus the live (not retired) cases staff added. System or admin role. */
export async function loadCases(tx: Tx, dataset: string): Promise<GoldenCase[]> {
  if (!DATASETS[dataset]) throw new DomainError('INVALID', `Unknown dataset ${dataset}`);
  const added = await tx`select id, input, expected, note, source from golden_cases where dataset = ${dataset} and retired_at is null order by created_at`;
  return [
    ...(GOLDEN[dataset] ?? []).map((c) => ({ ...c, source: 'seed' as const })),
    ...added.map((r) => ({ id: `gc-${String(r.id).slice(0, 8)}`, input: r.input as string, expect: r.expected as string, note: (r.note as string | null) ?? undefined, source: r.source as 'synthetic' | 'production' })),
  ];
}

/**
 * The golden dataset that gates changes to a route's task (plan 05 §10: "changing a route requires an eval
 * run that passed on the golden set"). Tasks whose output is creative copy are gated by the compliance scan;
 * a task no dataset covers can't be changed until one is added.
 */
export function evalDatasetFor(task: string): string | null {
  if (GOLDEN[task]) return task;
  const model = Object.entries(DATASETS).find(([, d]) => d.kind === 'model' && d.task === task);
  if (model) return model[0];
  if (task.startsWith('compliance') || task.startsWith('creative_director') || task === 'qa.implied_claims') return 'compliance.scan';
  return null;
}

/**
 * A candidate prompt version for a task: a task whose live version names a registered template may only move to
 * another registered version of the same template (plan 05 §11 — git is the source of prompts).
 */
export function assertCandidatePrompt(currentVersion: string, candidate: string) {
  const live = findPrompt(currentVersion);
  if (!live) return;
  const t = findPrompt(candidate);
  if (!t || t.name !== live.name) {
    const family = parsePromptRef(currentVersion)?.name ?? live.name;
    throw new DomainError('INVALID', `${candidate} isn’t a registered version of the ${family} template. Add it to packages/core/src/prompts.ts first.`);
  }
}

export interface CaseResult {
  id: string;
  input: string;
  expected: string;
  got: string;
  ok: boolean;
  latencyMs: number;
  costMicros: number;
  error?: string;
}

export interface EvalResult {
  dataset: string;
  cases: number;
  score: number;
  passed: boolean;
  costMicros: number;
  latencyP50Ms: number | null;
  results: CaseResult[];
}

function ruleOutcome(dataset: string, input: string): string {
  switch (dataset) {
    case 'compliance.classify':
      return classifyClaim(input).status;
    case 'compliance.scan':
      return scanCreativeText([input], []).ok ? 'pass' : 'block';
    case 'reviews.deceptive':
      return isFirstPersonTestimonial(input) || !scanCreativeText([input], []).ok ? 'block' : 'pass';
    case 'performance.confounded': {
      const x = JSON.parse(input) as { a: [number, number, number]; b: [number, number, number]; confounders: number };
      const ev = [x.a, x.b].map(([impressions, clicks, days], i) => ({ variantId: String.fromCharCode(97 + i), obs: { successes: clicks, trials: impressions }, days }));
      const cmp = compareVariants('ctr', ev, DEFAULT_BASELINES.ctr, 10_000, 'a');
      return withConfounders(cmp.state as ExperimentState, Number(x.confounders) || 0);
    }
    default:
      throw new DomainError('INVALID', `${dataset} is not a rules dataset`);
  }
}

const p50 = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor((s.length - 1) / 2)]!);
};

/** Blocked cases must all be caught (no false negatives on drug claims or confounded results); ≥ 90% overall. */
export function scoreEval(dataset: string, results: CaseResult[]): EvalResult {
  const score = results.length ? results.filter((r) => r.ok).length / results.length : 0;
  const missedBlocks = results.some((r) => ['BLOCKED', 'block', 'OPERATIONALLY_CONFOUNDED'].includes(r.expected) && !r.ok);
  return {
    dataset,
    cases: results.length,
    score,
    passed: results.length > 0 && score >= 0.9 && !missedBlocks,
    costMicros: results.reduce((a, r) => a + r.costMicros, 0),
    latencyP50Ms: p50(results.map((r) => r.latencyMs)),
    results,
  };
}

/** Rules datasets: every case against the deterministic engine. */
export function runDeterministicEval(dataset: string, cases: GoldenCase[] = GOLDEN[dataset] ?? []): EvalResult {
  if (DATASETS[dataset]?.kind !== 'rules') throw new Error(`unknown rules dataset ${dataset}`);
  return scoreEval(
    dataset,
    cases.map((c) => {
      const t0 = performance.now();
      let got: string;
      let error: string | undefined;
      try {
        got = ruleOutcome(dataset, c.input);
      } catch (e) {
        got = 'error';
        error = (e as Error).message;
      }
      return { id: c.id, input: c.input, expected: c.expect, got, ok: got === c.expect, latencyMs: Math.round((performance.now() - t0) * 1000) / 1000, costMicros: 0, ...(error ? { error } : {}) };
    }),
  );
}

/** The internal workspace eval calls are made (and their provider cost booked) in. Test workspace, never billed. */
export const EVAL_WORKSPACE_SLUG = 'arkiv-internal-evals';

export async function evalWorkspace(): Promise<string> {
  return withSystem(async (tx) => {
    const [w] = await tx`insert into workspaces (slug, name, state, is_test, tags) values (${EVAL_WORKSPACE_SLUG}, 'Arkiv evals (internal)', 'ACTIVE_FREE', true, ${['internal']})
                         on conflict (slug) do update set is_test = true returning id`;
    return w!.id as string;
  });
}

export interface ModelEvalInput {
  evalRunId: string;
  dataset: string;
  task: string;
  model: string;
  promptVersion: string;
  cases: GoldenCase[];
}

const EVAL_MAX_TOKENS = 2000;

/**
 * Model datasets: each case through the Model Gateway on the candidate template × model, under one Cost
 * Governor authorization in the internal evals workspace (never a tenant's). Provider failures count as a failed
 * case (the run still finishes); unspent budget is released.
 */
export async function runModelEval(i: ModelEvalInput): Promise<EvalResult> {
  const info = DATASETS[i.dataset];
  if (info?.kind !== 'model' || info.task !== i.task || !info.prompt) throw new DomainError('INVALID', `${i.dataset} doesn’t evaluate ${i.task}`);
  const template = findPrompt(i.promptVersion);
  if (!template || template.name !== info.prompt) throw new DomainError('INVALID', `${i.promptVersion} isn’t a registered ${info.prompt} template`);
  const ws = await evalWorkspace();
  const ctx = systemContext(ws, `eval:${i.evalRunId}`, 'ACTIVE_FREE');
  const systemLen = (template ?? latestPrompt(info.prompt)).text.length;
  const content = (c: GoldenCase) => [{ type: 'untrusted' as const, sourceId: 'golden_case', text: JSON.stringify({ name: null, description: c.input }) }];
  const auth = await withTenant(ws, async (tx) => {
    const [r] = await tx`select provider from model_routes where task = ${i.task}`;
    if (!r) throw new DomainError('NOT_FOUND', `No route for ${i.task}`);
    const lines = i.cases.map((c) => lineFor({ provider: r.provider as string, model: i.model }, { kind: 'llm', inputTokens: Math.ceil((systemLen + content(c)[0]!.text.length) / 4) + 16, outputTokens: EVAL_MAX_TOKENS }));
    return authorize(tx, ctx, { purpose: 'eval', lines, idempotencyKey: `eval:${i.evalRunId}`, ttlMinutes: 60 });
  });
  const results: CaseResult[] = [];
  try {
    for (const c of i.cases) {
      const t0 = performance.now();
      try {
        const res = await llmJson({
          ctx,
          token: auth.token,
          task: i.task,
          template: info.prompt,
          candidate: { model: i.model, promptVersion: i.promptVersion },
          inputRefs: { evalRunId: i.evalRunId, caseId: c.id },
          content: content(c),
          schema: ProductExtraction,
          mock: () => mockExtraction({ description: c.input, text: c.input }),
          effort: 'medium',
          maxTokens: EVAL_MAX_TOKENS,
        });
        const latencyMs = Math.round(performance.now() - t0);
        const [j] = await withTenant(ws, (tx) => tx`select actual_micros from provider_jobs where id = ${res.jobId} and workspace_id = ${ws}`);
        const got = res.data.packaging.type;
        results.push({ id: c.id, input: c.input, expected: c.expect, got, ok: got === c.expect, latencyMs, costMicros: Number(j?.actual_micros ?? 0) });
      } catch (e) {
        results.push({ id: c.id, input: c.input, expected: c.expect, got: 'error', ok: false, latencyMs: Math.round(performance.now() - t0), costMicros: 0, error: (e as Error).message.slice(0, 300) });
      }
    }
  } finally {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
  }
  return scoreEval(i.dataset, results);
}

// ───────────── Extending golden datasets (plan 05 §11, §13 "disagreements feed the golden set") ─────────────

export interface GoldenCaseInput {
  dataset: string;
  input: string;
  expected: string;
  note?: string | null;
  /**
   * 'synthetic': a reproduction staff wrote (no tenant content). 'production': built from a tenant's output —
   * needs an active break-glass session on that workspace and the tenant's explicit consent reference.
   */
  source: 'synthetic' | 'production';
  workspaceId?: string | null;
  consentRef?: string | null;
  origin?: Record<string, unknown>;
}

export async function addGoldenCase(tx: Tx, s: Staff, c: GoldenCaseInput): Promise<string> {
  assertStaff(s, 'golden.add');
  if (!DATASETS[c.dataset]) throw new DomainError('INVALID', `Unknown dataset ${c.dataset}`);
  const labels = EXPECTED_LABELS[c.dataset] ?? [];
  if (!labels.includes(c.expected)) throw new DomainError('INVALID', `Expected label for ${c.dataset} is one of: ${labels.join(', ')}`);
  if (!c.input.trim()) throw new DomainError('INVALID', 'The case needs an input.');
  if (c.dataset === 'performance.confounded') {
    try {
      ruleOutcome(c.dataset, c.input);
    } catch {
      throw new DomainError('INVALID', 'Performance cases are JSON: {"a":[impressions,clicks,days],"b":[…],"confounders":n}');
    }
  }
  if (c.source === 'production') {
    // Production tenant content is never copied into a golden set without the tenant's consent (§11, §51).
    if (!c.workspaceId) throw new DomainError('INVALID', 'Which workspace did this case come from?');
    if (!c.consentRef || c.consentRef.trim().length < 4) {
      throw new DomainError('INVALID', 'A production case needs the tenant’s explicit consent (ticket or document reference). Otherwise add a synthetic reproduction.');
    }
    await assertBreakGlass(tx, s, c.workspaceId, `add golden case to ${c.dataset}`);
  }
  const production = c.source === 'production';
  const [row] = await tx`
    insert into golden_cases (dataset, input, expected, note, source, consent_ref, source_workspace_id, origin, created_by)
    values (${c.dataset}, ${c.input.trim()}, ${c.expected}, ${c.note ?? null}, ${c.source}, ${production ? c.consentRef!.trim() : null},
            ${production ? c.workspaceId! : null}, ${tx.json((c.origin ?? {}) as never)}, ${s.staffId})
    returning id`;
  await audit(tx, s, 'golden.add', { type: 'golden_case', id: row!.id as string }, {
    workspaceId: production ? c.workspaceId! : null,
    reason: production ? `tenant consent ${c.consentRef!.trim()}` : 'synthetic reproduction',
    after: { dataset: c.dataset, expected: c.expected, source: c.source, origin: c.origin ?? {} },
  });
  return row!.id as string;
}

export async function retireGoldenCase(tx: Tx, s: Staff, id: string, reason: string) {
  assertStaff(s, 'golden.add');
  const [b] = await tx`update golden_cases set retired_at = now(), retired_by = ${s.staffId} where id = ${id} and retired_at is null returning dataset`;
  if (!b) throw new DomainError('NOT_FOUND', 'Case not found (or already retired)');
  await audit(tx, s, 'golden.retire', { type: 'golden_case', id }, { reason, before: { dataset: b.dataset } });
}
