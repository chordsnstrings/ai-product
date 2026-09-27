import Link from 'next/link';
import { auditView, qaCalibration, qaQueueSql, reviewedChecks, type QaReport } from '@arkiv/core';
import { withAdmin } from '@arkiv/db';
import { ago, Mono, Page, pct, Section, Table } from '@/components/ui';
import { consolePrefs } from '@/lib/prefs';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'QA review' };

/**
 * Plan 05 §13: failed-twice outputs (technique switched), hard fidelity fails, and a 2% random sample of passes for
 * calibration. Metrics: QA precision/recall against human verdicts by check and provider, with the score
 * distribution of good vs defective outputs for threshold tuning.
 */
export default async function Qa() {
  const s = await requireStaff('qa.review');
  const prefs = await consolePrefs();
  const d0 = await withAdmin(async (tx) => {
    await auditView(tx, s, 'qa', { includeTest: prefs.includeTest });
    return {
      queue: await tx`select q.*, w.name from (${qaQueueSql(tx, { includeTest: prefs.includeTest })}) q join workspaces w on w.id = q.workspace_id order by q.updated_at desc limit 100`,
      reviewed: await reviewedChecks(tx, { includeTest: prefs.includeTest }),
    };
  });
  const calibration = qaCalibration(d0.reviewed);
  const rate = (x: number | null) => (x === null ? '—' : pct(x));
  return (
    <Page title="QA review" sub="Content view requires break-glass on each tenant. Verdicts calibrate automated checks; they enter golden sets only with the tenant’s consent.">
      <Table head={['Project', 'Workspace', 'Why', 'State', 'Failed checks', 'Updated']} rows={d0.queue.map((p) => [
        <Link key="p" href={`/qa/${p.id}?ws=${p.workspace_id}`}><Mono>{String(p.id).slice(0, 8)}</Mono></Link>, p.name as string, p.why as string, p.state as string,
        <span key="c" className="ak-small">{[...new Set(((p.qa_report as QaReport | null)?.checks ?? []).filter((c) => !c.pass).map((c) => `${c.check}${c.hard ? ' (hard)' : ''}`))].join(', ') || '—'}</span>, ago(p.updated_at),
      ])} empty="Queue is empty." />
      <Section title="QA precision / recall vs human verdicts">
        <p className="ak-small ak-muted">A positive is a defect the check flagged. Precision: of the outputs QA failed, the share reviewers confirmed. Recall: of the outputs reviewers judged defective, the share QA caught. Provider = who rendered the reviewed output.</p>
        <Table
          head={['Check', 'Provider', 'Reviewed', 'TP', 'FP', 'FN', 'TN', 'Precision', 'Recall', 'Score: good / defective (median)', 'Suggested threshold']}
          rows={calibration.map((c) => [
            <Mono key="c">{c.check}</Mono>, c.provider, c.tp + c.fp + c.fn + c.tn, c.tp, c.fp, c.fn, c.tn, rate(c.precision), rate(c.recall),
            c.goodScoreMedian === null && c.badScoreMedian === null ? '—' : `${c.goodScoreMedian ?? '—'} / ${c.badScoreMedian ?? '—'}`,
            c.suggestedThreshold === null ? '—' : <span key="t" title="Midpoint of the medians; tune the check's threshold toward it after enough reviews">palette distance ≤ {c.suggestedThreshold}</span>,
          ])}
          empty="No reviews yet."
        />
      </Section>
    </Page>
  );
}
