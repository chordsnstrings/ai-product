import Link from 'next/link';
import type { QaReport } from '@arkiv/core';
import { withAdmin } from '@arkiv/db';
import { ago, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'QA review' };

/** Plan 05 §13: failed-twice outputs, hard fidelity fails, and a 2% random sample of passes for calibration. */
export default async function Qa() {
  await requireStaff('qa.review');
  const d0 = await withAdmin(async (tx) => ({
    queue: await tx`select p.id, p.workspace_id, p.state, p.qa_report, p.updated_at, w.name, 'failed' as why from projects p join workspaces w on w.id = p.workspace_id
                    where (p.state in ('PROVIDER_FAILED','NEEDS_USER_ACTION','REFUNDED') or (p.qa_report->>'hardFail')::boolean) and not exists (select 1 from qa_reviews r where r.project_id = p.id)
                    union all
                    select p.id, p.workspace_id, p.state, p.qa_report, p.updated_at, w.name, 'sample' from projects p join workspaces w on w.id = p.workspace_id
                    where p.state = 'COMPLETE' and abs(hashtext(p.id::text)) % 50 = 0 and not exists (select 1 from qa_reviews r where r.project_id = p.id)
                    order by updated_at desc limit 100`,
    agreement: await tx`select k as check_name, count(*)::int as n, count(*) filter (where v = 'agree')::int as agree from qa_reviews, jsonb_each_text(verdicts) as x(k, v) group by k order by k`,
  }));
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
