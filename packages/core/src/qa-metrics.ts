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
