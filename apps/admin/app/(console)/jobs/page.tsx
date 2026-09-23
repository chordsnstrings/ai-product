import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { canRetryQueue, NO_SPEND_QUEUES, staffCan } from '@arkiv/core';
import { ActButton } from '@/components/act';
import { ago, dt, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Jobs & queues' };

const EXPECTED_MIN: Record<string, number> = { RENDERING: 20, QA_RUNNING: 10, COMPOSING: 10, PLATFORM_VARIANTS: 10, FINAL_QA: 10, RENDER_RESERVED: 10, STORYBOARD_APPROVED: 10, PRODUCT_UPLOADED: 5, CONCEPT_SELECTED: 10 };

/** Plan 05 §12. Reads pg-boss tables directly (read-only grant); mutations go through audited ops_commands. */
export default async function Jobs() {
  const s = await requireStaff('jobs.read');
  // Redrive and cancel need jobs.manage; SUPPORT may retry only queues whose handlers make no provider spend.
  const canManage = staffCan(s.roles, 'jobs.manage');
  const d0 = await withAdmin(async (tx) => {
    let queues: Record<string, unknown>[] = [];
    let failed: Record<string, unknown>[] = [];
    let visible = true;
    try {
      queues = await tx.savepoint((sp) => sp`select name, count(*) filter (where state in ('created','retry'))::int as waiting, count(*) filter (where state = 'active')::int as active,
          count(*) filter (where state = 'completed' and completed_on > now() - interval '1 hour')::int as done_1h, count(*) filter (where state = 'failed')::int as failed,
          extract(epoch from now() - min(created_on) filter (where state in ('created','retry') and start_after <= now()))::int as oldest
        from pgboss.job group by name order by name`);
      failed = await tx.savepoint((sp) => sp`select id, name, data->>'workspaceId' as ws, output, completed_on, retry_count from pgboss.job where state = 'failed' order by completed_on desc nulls last limit 50`);
    } catch {
      visible = false;
    }
    const outbox = await tx`select queue, count(*)::int as n, min(created_at) as oldest from outbox where dispatched_at is null group by queue`;
    const stuck = await tx`select p.id, p.workspace_id, p.state, p.updated_at, w.name from projects p join workspaces w on w.id = p.workspace_id
                           where p.state in ${tx(Object.keys(EXPECTED_MIN))} and p.updated_at < now() - interval '5 minutes' order by p.updated_at limit 100`;
    const commands = await tx`select c.*, s.name from ops_commands c join staff_users s on s.id = c.requested_by order by c.created_at desc limit 30`;
    return { queues, failed, visible, outbox, stuck, commands };
  });
  const stuck = d0.stuck.filter((p) => Date.now() - new Date(p.updated_at as string).getTime() > (EXPECTED_MIN[p.state as string] ?? 10) * 60_000);
  return (
    <Page title="Jobs & queues" sub="Retries only for idempotent handlers; production spend is re-authorised by the Cost Governor, never double-charged.">
      {!d0.visible ? <p className="ak-banner ak-banner--warn">Queue tables aren’t visible yet — the worker grants read access when it starts.</p> : null}
      <Table head={['Queue', 'Waiting', 'Active', 'Completed 1h', 'Failed', 'Oldest waiting', '']} rows={d0.queues.map((q) => [
        <Mono key="n">{q.name as string}</Mono>, q.waiting as number, q.active as number, q.done_1h as number, q.failed as number, q.oldest ? `${Math.round(Number(q.oldest) / 60)} min` : '—',
        canManage && String(q.name).endsWith('-dlq') && Number(q.waiting) > 0 ? <ActButton key="r" small action="dlq.requeue" payload={{ queue: String(q.name).replace(/-dlq$/, '') }} reason>🔐 Redrive</ActButton> : null,
      ])} />
      <Section title="Outbox (committed, not yet dispatched)"><Table head={['Queue', 'Rows', 'Oldest']} rows={d0.outbox.map((o) => [o.queue as string, o.n as number, ago(o.oldest)])} empty="Dispatcher is caught up." /></Section>
      <Section title="Stuck detector">
        <Table head={['Project', 'Workspace', 'State', 'Since', 'Suggested action']} rows={stuck.map((p) => [<Mono key="i">{String(p.id).slice(0, 8)}</Mono>, <Link key="w" href={`/tenants/${p.workspace_id}?tab=projects`}>{p.name as string}</Link>, p.state as string, ago(p.updated_at), p.state === 'RENDERING' ? 'Check provider jobs; circuit-break the provider if widespread' : 'Retry the step (no new spend)'])} empty="Nothing stuck." />
      </Section>
      <Section title="Failed jobs">
        <Table head={['Finished', 'Queue', 'Job', 'Workspace', 'Retries', 'Error', '']} rows={d0.failed.map((j) => [dt(j.completed_on), <Mono key="q">{j.name as string}</Mono>, <Mono key="j">{String(j.id).slice(0, 8)}</Mono>, j.ws ? <Link key="w" href={`/tenants/${j.ws}`}>{String(j.ws).slice(0, 8)}</Link> : '—', j.retry_count as number, <span key="e" className="ak-small">{JSON.stringify(j.output ?? '').slice(0, 140)}</span>,
          canRetryQueue(s.roles, j.name as string) ? <span key="a" className="ak-row"><ActButton small action="job.retry" payload={{ queue: j.name, jobId: j.id, workspaceId: j.ws ?? undefined }} reason>{NO_SPEND_QUEUES.has(j.name as string) ? 'Retry' : 'Retry (may spend)'}</ActButton></span> : null])} empty="No failed jobs retained." />
      </Section>
      <Section title="Staff queue commands">
        <Table head={['When', 'Command', 'Payload', 'By', 'Reason', 'Status', 'Result']} rows={d0.commands.map((c) => [dt(c.created_at), c.kind as string, <Mono key="p">{JSON.stringify(c.payload).slice(0, 100)}</Mono>, c.name as string, c.reason as string, c.status as string, <Mono key="r">{JSON.stringify(c.result ?? '').slice(0, 100)}</Mono>])} />
      </Section>
    </Page>
  );
}
