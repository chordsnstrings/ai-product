import { withAdmin } from '@arkiv/db';
import { ActButton } from '@/components/act';
import { dt, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Approvals' };

/** Four-eyes queue (plan 05 §0.5). Your own requests are listed but can't be approved by you. */
export default async function Approvals() {
  const s = await requireStaff('approvals.read');
  const rows = await withAdmin((tx) => tx`select a.*, r.name as requester, d.name as decider from approvals a join staff_users r on r.id = a.requested_by left join staff_users d on d.id = a.decided_by order by (a.status = 'pending') desc, a.created_at desc limit 200`);
  const pending = rows.filter((r) => r.status === 'pending');
  const done = rows.filter((r) => r.status !== 'pending');
  return (
    <Page title="Approvals" sub="A second person approves: ledger adjustments over threshold, refunds > $200, rate publishes, route promotions to 100%, early purges, staff role changes, claim unblocks, Stripe assignments.">
      <Table head={['Requested', 'Action', 'Payload', 'Reason', 'By', 'Needs', '']} rows={pending.map((a) => [
        dt(a.created_at), <Mono key="a">{a.action as string}</Mono>, <Mono key="p">{JSON.stringify(a.payload).slice(0, 160)}</Mono>, a.reason as string, a.requester as string, a.required_role as string,
        a.requested_by === s.staffId ? <span key="o" className="ak-small ak-muted">your request</span> : (
          <span key="d" className="ak-row">
            <ActButton small action="approval.decide" payload={{ id: a.id, approve: true }} confirm={`Approve ${a.action}?`}>🔐 Approve</ActButton>
            <ActButton small action="approval.decide" payload={{ id: a.id, approve: false }}>Reject</ActButton>
          </span>
        ),
      ])} empty="Nothing waiting." />
      <Section title="History">
        <Table head={['Requested', 'Action', 'Status', 'By', 'Decided by', 'Result']} rows={done.map((a) => [dt(a.created_at), <Mono key="a">{a.action as string}</Mono>, a.status as string, a.requester as string, (a.decider as string) ?? '—', <Mono key="r">{JSON.stringify(a.result ?? '').slice(0, 120)}</Mono>])} />
      </Section>
    </Page>
  );
}
