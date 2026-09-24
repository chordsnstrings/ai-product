import Link from 'next/link';
import { auditView, qaQueueSql, type QaReport } from '@arkiv/core';
import { withAdmin } from '@arkiv/db';
import { ago, Mono, Page, pct, Section, Table } from '@/components/ui';
import { consolePrefs } from '@/lib/prefs';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'QA review' };

/** Plan 05 §13: failed-twice outputs, hard fidelity fails, and a 2% random sample of passes for calibration. */
export default async function Qa() {
  const s = await requireStaff('qa.review');
  const prefs = await consolePrefs();
  const d0 = await withAdmin(async (tx) => {
    await auditView(tx, s, 'qa', { includeTest: prefs.includeTest });
    return {
      queue: await tx`select q.*, w.name from (${qaQueueSql(tx, { includeTest: prefs.includeTest })}) q join workspaces w on w.id = q.workspace_id order by q.updated_at desc limit 100`,
      agreement: await tx`select k as check_name, count(*)::int as n, count(*) filter (where v = 'agree')::int as agree from qa_reviews, jsonb_each_text(verdicts) as x(k, v) group by k order by k`,
    };
  });
  return (
    <Page title="QA review" sub="Content view requires break-glass on each tenant. Verdicts calibrate automated checks; they never enter golden sets without consent.">
      <Table head={['Project', 'Workspace', 'Why', 'State', 'Failed checks', 'Updated']} rows={d0.queue.map((p) => [
        <Link key="p" href={`/qa/${p.id}?ws=${p.workspace_id}`}><Mono>{String(p.id).slice(0, 8)}</Mono></Link>, p.name as string, p.why as string, p.state as string,
        <span key="c" className="ak-small">{[...new Set(((p.qa_report as QaReport | null)?.checks ?? []).filter((c) => !c.pass).map((c) => `${c.check}${c.hard ? ' (hard)' : ''}`))].join(', ') || '—'}</span>, ago(p.updated_at),
      ])} empty="Queue is empty." />
      <Section title="Human agreement with automated checks">
        <Table head={['Check', 'Reviews', 'Agree', 'Agreement']} rows={d0.agreement.map((a) => [a.check_name as string, a.n as number, a.agree as number, pct(Number(a.agree) / Number(a.n))])} empty="No reviews yet." />
      </Section>
    </Page>
  );
}
