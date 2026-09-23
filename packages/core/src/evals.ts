import { classifyClaim, scanCreativeText, type SuggestedStatus } from './compliance';

/**
 * Golden datasets (plan 05 §11, standard §51). Cases are synthetic or written by staff — production tenant
 * content is never copied here without consent. Deterministic tasks run locally; model-backed tasks are
 * evaluated through the Model Gateway by the worker with a Cost Governor authorization.
 */
export interface GoldenCase {
  id: string;
  input: string;
  expect: SuggestedStatus | 'pass' | 'block';
  note?: string;
}

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
};

/**
 * The golden dataset that gates changes to a route's task (plan 05 §10: "changing a route requires an eval
 * run that passed on the golden set"). Tasks whose output is creative copy are gated by the compliance scan;
 * a task no dataset covers can't be changed until one is added.
 */
export function evalDatasetFor(task: string): string | null {
  if (GOLDEN[task]) return task;
  if (task.startsWith('compliance') || task.startsWith('creative_director') || task === 'qa.implied_claims') return 'compliance.scan';
  return null;
}

export interface EvalResult {
  dataset: string;
  cases: number;
  score: number;
  passed: boolean;
  results: { id: string; input: string; expected: string; got: string; ok: boolean }[];
}

/** Pass threshold: blocked cases must all be caught (no false negatives on drug claims); ≥ 90% overall. */
export function runDeterministicEval(dataset: string): EvalResult {
  const cases = GOLDEN[dataset];
  if (!cases) throw new Error(`unknown dataset ${dataset}`);
  const results = cases.map((c) => {
    const got = dataset === 'compliance.scan' ? (scanCreativeText([c.input], []).ok ? 'pass' : 'block') : classifyClaim(c.input).status;
    return { id: c.id, input: c.input, expected: c.expect, got, ok: got === c.expect };
  });
  const score = results.filter((r) => r.ok).length / results.length;
  const missedBlocks = results.some((r) => (r.expected === 'BLOCKED' || r.expected === 'block') && !r.ok);
  return { dataset, cases: results.length, score, passed: score >= 0.9 && !missedBlocks, results };
}
