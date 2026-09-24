import type { Tx } from '@arkiv/db';
import type { CheckResult } from './qa';

/** A stored QA report (summarize() of the QA Gateway's checks). */
export interface QaReport {
  pass?: boolean;
  hardFail?: boolean;
  checks?: CheckResult[];
  error?: string;
}

/** Standard §10 retention guard: repeated product-fidelity failure on under 3% of paid projects. */
export const REPEATED_FIDELITY_TARGET = 0.03;

/**
 * Paid projects (Taste, Standalone, Creative Test) that reserved production in the last `days`, and how many of
 * them had a scene fail product fidelity hard at least twice (its render and its repair, §25/§44). Scene QA
 * events are tied to their project through the storyboard. Test workspaces are excluded unless `includeTest`.
 * Admin/system scope: reads across tenants.
 */
export async function repeatedFidelityFailures(tx: Tx, days: number, opts: { includeTest?: boolean } = {}): Promise<{ paid: number; repeated: number; rate: number }> {
  const [r] = await tx`
    with paid as (
      select distinct a.project_id, a.workspace_id from cost_authorizations a
      join projects p on p.id = a.project_id and p.workspace_id = a.workspace_id
      where a.purpose in ('taste','standalone','creative_test') and a.idempotency_key like 'produce:%'
        and a.created_at > now() - make_interval(days => ${days})
        and p.kind in ('taste','standalone','creative_test')
        and (${!!opts.includeTest} or a.workspace_id not in (select id from workspaces where is_test))
    ),
    repeated as (
      select distinct sb.project_id, e.workspace_id from events e
      join scenes s on s.id = e.subject_id and s.workspace_id = e.workspace_id
      join storyboards sb on sb.id = s.storyboard_id and sb.workspace_id = s.workspace_id
      where e.type = 'QA_FAILED' and e.subject_type = 'scene' and e.payload->>'hardFail' = 'true'
      group by sb.project_id, e.workspace_id, e.subject_id
      having count(*) >= 2
    )
    select (select count(*) from paid)::int as paid,
           (select count(*) from paid join repeated r on r.project_id = paid.project_id and r.workspace_id = paid.workspace_id)::int as repeated`;
  const paid = Number(r?.paid ?? 0);
  const repeated = Number(r?.repeated ?? 0);
  return { paid, repeated, rate: paid ? repeated / paid : NaN };
}

/**
 * Appendix C "First-render acceptance": paid projects (Taste, Standalone, Creative Test) delivered in the last
 * `days` that the customer exported without asking for their creative to be generated again (automatic QA repairs
 * and system or staff retries don't count against it), over all paid projects delivered then. Admin/system scope.
 */
export async function firstRenderAcceptance(tx: Tx, days: number, opts: { includeTest?: boolean } = {}): Promise<{ delivered: number; accepted: number; rate: number }> {
  const [r] = await tx`
    with delivered as (
      select distinct p.id, p.workspace_id from events e
      join projects p on p.id = e.subject_id and p.workspace_id = e.workspace_id
      where e.type = 'COMPOSITION_COMPLETED' and e.at > now() - make_interval(days => ${days})
        and p.kind in ('taste','standalone','creative_test') and p.state = 'COMPLETE'
        and (${!!opts.includeTest} or p.workspace_id not in (select id from workspaces where is_test))
    ),
    accepted as (
      select d.id, d.workspace_id from delivered d
      where exists (select 1 from events x join assets a on a.id = x.subject_id and a.workspace_id = x.workspace_id and a.kind = 'final_export'
                    where x.type = 'ASSET_EXPORTED' and x.workspace_id = d.workspace_id and a.lineage->>'projectId' = d.id::text)
        and not exists (select 1 from events g where g.type = 'CREATIVE_REGENERATION_REQUESTED' and g.workspace_id = d.workspace_id
                        and g.subject_id = d.id and g.payload->>'by' = 'user')
    )
    select (select count(*) from delivered)::int as delivered, (select count(*) from accepted)::int as accepted`;
  const delivered = Number(r?.delivered ?? 0);
  const accepted = Number(r?.accepted ?? 0);
  return { delivered, accepted, rate: delivered ? accepted / delivered : NaN };
}

// ───────────── QA calibration against human verdicts (plan 05 §13) ─────────────

/** One reviewed automated check: what QA decided, what the reviewer said, and a numeric score if it had one. */
export interface ReviewedCheck {
  check: string;
  provider: string;
  /** Automated verdict: true = the check passed. */
  autoPass: boolean;
  agree: boolean;
  /** e.g. the product-fidelity palette distance. */
  score?: number | null;
}

export interface CalibrationRow {
  check: string;
  provider: string;
  /** A "positive" is a defect: the check failed the output. */
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  /** Median score of outputs reviewers judged good / defective (null when unscored). */
  goodScoreMedian: number | null;
  badScoreMedian: number | null;
  /** A threshold between the two (null without both sides or when they overlap the wrong way). */
  suggestedThreshold: number | null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * QA precision/recall vs human verdicts, by check and provider (plan 05 §13 Metrics). The human truth is the
 * automated verdict when the reviewer agreed and its opposite when they disagreed. Precision: of the outputs QA
 * failed, how many were really defective; recall: of the really defective ones, how many QA caught. Scored checks
 * also get the median score of good and defective outputs and a threshold between them — input for QA threshold
 * tuning ("disagreements feed … QA threshold tuning").
 */
export function qaCalibration(rows: ReviewedCheck[]): CalibrationRow[] {
  const groups = new Map<string, ReviewedCheck[]>();
  for (const r of rows) {
    const k = `${r.check}\u0000${r.provider}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()]
    .map((g) => {
      let tp = 0, fp = 0, fn = 0, tn = 0;
      const good: number[] = [];
      const bad: number[] = [];
      for (const r of g) {
        const defective = r.agree ? !r.autoPass : r.autoPass;
        if (!r.autoPass && defective) tp++;
        else if (!r.autoPass && !defective) fp++;
        else if (r.autoPass && defective) fn++;
        else tn++;
        if (typeof r.score === 'number' && Number.isFinite(r.score)) (defective ? bad : good).push(r.score);
      }
      const gm = median(good);
      const bm = median(bad);
      return {
        check: g[0]!.check,
        provider: g[0]!.provider,
        tp,
        fp,
        fn,
        tn,
        precision: tp + fp ? tp / (tp + fp) : null,
        recall: tp + fn ? tp / (tp + fn) : null,
        goodScoreMedian: gm,
        badScoreMedian: bm,
        // Higher distance = worse: a threshold only makes sense when defective outputs score above good ones.
        suggestedThreshold: gm !== null && bm !== null && bm > gm ? Math.round(((gm + bm) / 2) * 10) / 10 : null,
      };
    })
    .sort((a, b) => a.check.localeCompare(b.check) || a.provider.localeCompare(b.provider));
}

/**
 * Reviewed checks for calibration (admin/system role, cross-tenant aggregates): each verdict joined to the stored
 * QA report check it judged and to the provider(s) that rendered the project's scenes.
 */
export async function reviewedChecks(tx: Tx, opts: { includeTest?: boolean } = {}): Promise<ReviewedCheck[]> {
  const rows = await tx`
    select r.verdicts, p.qa_report,
           coalesce((select string_agg(distinct j.provider, '+' order by j.provider) from provider_jobs j
                     where j.workspace_id = r.workspace_id and j.project_id = r.project_id and (j.task like 'video.%' or j.task like 'image.%')), 'none') as provider
    from qa_reviews r join projects p on p.id = r.project_id and p.workspace_id = r.workspace_id
    where (${!!opts.includeTest} or r.workspace_id not in (select id from workspaces where is_test))`;
  const out: ReviewedCheck[] = [];
  for (const r of rows) {
    const checks = ((r.qa_report as QaReport | null)?.checks ?? []) as CheckResult[];
    for (const [key, verdict] of Object.entries((r.verdicts ?? {}) as Record<string, string>)) {
      const n = Number(key.split(':')[0]);
      const c = checks[n - 1];
      if (!c || `${n}:${c.check}` !== key) continue;
      const score = typeof c.data?.paletteDistance === 'number' ? (c.data.paletteDistance as number) : null;
      out.push({ check: c.check, provider: r.provider as string, autoPass: !!c.pass, agree: verdict === 'agree', score });
    }
  }
  return out;
}

/** Label-OCR diff for QA review (plan 05 §13): reference label words vs the words read on the output. */
export function labelDiff(reference: string | null | undefined, read: string | null | undefined): { word: string; status: 'same' | 'missing' | 'extra' }[] {
  const words = (s: string | null | undefined) => (s ?? '').split(/\s+/).map((w) => w.trim()).filter(Boolean);
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9%]/g, '');
  const ref = words(reference);
  const got = words(read);
  // Longest common subsequence on normalised words, so a reordered or dropped word shows where it went wrong.
  const L = Array.from({ length: ref.length + 1 }, () => new Array<number>(got.length + 1).fill(0));
  for (let i = ref.length - 1; i >= 0; i--) for (let j = got.length - 1; j >= 0; j--) L[i]![j] = norm(ref[i]!) === norm(got[j]!) ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { word: string; status: 'same' | 'missing' | 'extra' }[] = [];
  let i = 0, j = 0;
  while (i < ref.length && j < got.length) {
    if (norm(ref[i]!) === norm(got[j]!)) {
      out.push({ word: got[j]!, status: 'same' });
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ word: ref[i++]!, status: 'missing' });
    else out.push({ word: got[j++]!, status: 'extra' });
  }
  while (i < ref.length) out.push({ word: ref[i++]!, status: 'missing' });
  while (j < got.length) out.push({ word: got[j++]!, status: 'extra' });
  return out;
}

const CUSTOMER_LABEL: Partial<Record<CheckResult['check'], string>> = {
  product_fidelity: 'Product accuracy',
  visual: 'Visual quality',
  audio: 'Voice and audio',
  platform: 'Platform formats and safe zones',
  experiment_integrity: 'Test integrity (only the hook changes)',
  asset_integrity: 'Files stored and verified',
};

/**
 * The QA summary shown under a delivered ad (plan 03 P10: "Product accuracy ✓ · Claims: 3 used, all verified ✓"):
 * one line per kind of check, in the customer's words, passed when every check of that kind passed.
 */
export function customerQaSummary(report: QaReport | null | undefined): { label: string; ok: boolean }[] {
  const checks = report?.checks ?? [];
  const order: CheckResult['check'][] = ['product_fidelity', 'claims', 'visual', 'audio', 'platform', 'experiment_integrity', 'asset_integrity'];
  const out: { label: string; ok: boolean }[] = [];
  for (const kind of order) {
    const of = checks.filter((c) => c.check === kind);
    if (!of.length) continue;
    if (kind === 'experiment_integrity' && of.every((c) => /Standalone production/.test(c.detail))) continue;
    const ok = of.every((c) => c.pass);
    if (kind === 'claims') {
      const used = Math.max(0, ...of.map((c) => Number((c.data as { claimsUsed?: number } | undefined)?.claimsUsed ?? 0)));
      out.push({ label: used ? `Claims: ${used} used, ${ok ? 'all verified' : 'reviewed'}` : ok ? 'Claims: none made — descriptive wording only' : 'Claims reviewed', ok });
    } else out.push({ label: CUSTOMER_LABEL[kind]!, ok });
  }
  return out;
}
