import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { auditView, canRetryQueue, IN_PRODUCTION, jobErrorClass, NO_SPEND_QUEUES, planQuota, queuePolicy, shouldMaskPii, staffCan } from '@arkiv/core';
import type { PlanCode } from '@arkiv/shared';
import { ActButton } from '@/components/act';
import { ago, dt, Mono, Page, Section, Table } from '@/components/ui';
import { piiView } from '@/lib/mask';
import { consolePrefs } from '@/lib/prefs';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Jobs & queues' };

const EXPECTED_MIN: Record<string, number> = { RENDERING: 20, QA_RUNNING: 10, COMPOSING: 10, PLATFORM_VARIANTS: 10, FINAL_QA: 10, RENDER_RESERVED: 10, STORYBOARD_APPROVED: 10, PRODUCT_UPLOADED: 5, CONCEPT_SELECTED: 10 };

/** Plan 05 §12. Reads pg-boss tables directly (read-only grant); mutations go through audited ops_commands. */
export default async function Jobs({ searchParams }: { searchParams: Promise<{ stuck?: string }> }) {
  const s = await requireStaff('jobs.read');
  const stuckOnly = (await searchParams).stuck === '1';
  // Job errors and payloads can quote customer addresses; SUPPORT sees them masked (plan 05 §0.2).
  const pii = piiView(shouldMaskPii(s.roles));
  const prefs = await consolePrefs();
  // Redrive and cancel need jobs.manage; SUPPORT may retry only queues whose handlers make no provider spend.
  const canManage = staffCan(s.roles, 'jobs.manage');
  const d0 = await withAdmin(async (tx) => {
    await auditView(tx, s, 'jobs', { stuck: stuckOnly });
    let queues: Record<string, unknown>[] = [];
    let failed: Record<string, unknown>[] = [];
    let running: Record<string, unknown>[] = [];
    let concurrency: Record<string, unknown>[] = [];
    let visible = true;
    try {
      queues = await tx.savepoint((sp) => sp`select name, count(*) filter (where state in ('created','retry'))::int as waiting, count(*) filter (where state = 'active')::int as active,
          count(*) filter (where state = 'completed' and completed_on > now() - interval '1 hour')::int as done_1h, count(*) filter (where state = 'failed')::int as failed,
          extract(epoch from now() - min(created_on) filter (where state in ('created','retry') and start_after <= now()))::int as oldest
        from pgboss.job group by name order by name`);
      failed = await tx.savepoint((sp) => sp`select id, name, data->>'workspaceId' as ws, output, completed_on, retry_count from pgboss.job where state = 'failed' order by completed_on desc nulls last limit 500`);
      running = await tx.savepoint((sp) => sp`select id, name, state, data->>'workspaceId' as ws, created_on, started_on from pgboss.job where state in ('created','retry','active')
                                              order by (state = 'active') desc, created_on limit 50`);
      // Per-workspace concurrency usage (§12): jobs running now, by workspace and queue.
      concurrency = await tx.savepoint((sp) => sp`select data->>'workspaceId' as ws, name, count(*)::int as n from pgboss.job
                                                  where state = 'active' and data ? 'workspaceId' group by 1, 2 order by n desc limit 50`);
    } catch {
      visible = false;
    }
    const outbox = await tx`select queue, count(*)::int as n, min(created_at) as oldest from outbox where dispatched_at is null group by queue`;
    const stuck = await tx`select p.id, p.workspace_id, p.state, p.updated_at, w.name from projects p join workspaces w on w.id = p.workspace_id
                           where p.state in ${tx(Object.keys(EXPECTED_MIN))} and p.updated_at < now() - interval '5 minutes' ${notTest(tx, prefs, 'p.workspace_id')} order by p.updated_at limit 100`;
    const commands = await tx`select c.*, s.name from ops_commands c join staff_users s on s.id = c.requested_by order by c.created_at desc limit 30`;
    const wsIds = [...new Set(concurrency.map((c) => c.ws as string).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
    // Renders in flight against each plan's render concurrency (plan 02 §4 quotas).
    const workspaces = wsIds.length
      ? await tx`select w.id, w.name, w.plan_code, (select count(*)::int from projects p where p.workspace_id = w.id and p.state in ('RENDER_RESERVED','RENDERING','QA_RUNNING','COMPOSING','PLATFORM_VARIANTS','FINAL_QA')) as renders
                 from workspaces w where w.id = any(${wsIds}::uuid[])`
      : [];
    const limits = new Map<string, number>();
    for (const w of workspaces) limits.set(w.id as string, (await planQuota(tx, (w.plan_code as PlanCode | null) ?? null)).renderConcurrency);
    return { queues, failed, running, concurrency, workspaces, limits, visible, outbox, stuck, commands };
  });
  const classes = new Map<string, { queue: string; errorClass: string; n: number; last: unknown }>();
  for (const j of d0.failed) {
    const errorClass = jobErrorClass(j.output);
    const key = `${j.name as string}\u0000${errorClass}`;
    const g = classes.get(key) ?? { queue: j.name as string, errorClass, n: 0, last: j.completed_on };
    g.n++;
    classes.set(key, g);
  }
  const failedClasses = [...classes.values()].sort((a, b) => b.n - a.n).slice(0, 30);
  const stuck = d0.stuck.filter((p) => Date.now() - new Date(p.updated_at as string).getTime() > (EXPECTED_MIN[p.state as string] ?? 10) * 60_000);
  const stuckTable = (
    <Section title="Stuck detector">
      <Table head={['Project', 'Workspace', 'State', 'Since', 'Suggested action', '']} rows={stuck.map((p) => [<Mono key="i">{String(p.id).slice(0, 8)}</Mono>, <Link key="w" href={`/tenants/${p.workspace_id}?tab=projects&project=${p.id}`}>{p.name as string}</Link>, p.state as string, ago(p.updated_at), p.state === 'RENDERING' ? 'Check provider jobs; circuit-break the provider if widespread' : 'Resume from where it stopped (no new spend)',
        // §39: a production with no live run resumes from durable state under the reservation it holds.
        canManage && (IN_PRODUCTION as readonly string[]).includes(p.state as string) ? (
          <ActButton key="r" small action="tenant.project_retry" payload={{ workspaceId: p.workspace_id, projectId: p.id }} confirm="Resume this stalled production? It continues from where it stopped under the reservation it already holds; nothing is reserved or charged again." reason="Resume reason (ticket / incident)">Resume</ActButton>
        ) : null])} empty="Nothing stuck." />
    </Section>
  );
  if (stuckOnly) {
    return (
      <Page title="Jobs & queues" sub={<>Showing stuck productions only (from Pulse). <Link href="/jobs">Show all queues</Link></>}>
        {stuckTable}
      </Page>
    );
  }
  return (
    <Page title="Jobs & queues" sub="Retries only for idempotent handlers; production spend is re-authorised by the Cost Governor, never double-charged.">
      {!d0.visible ? <p className="ak-banner ak-banner--warn">Queue tables aren’t visible yet — the worker grants read access when it starts.</p> : null}
      <Table head={['Queue', 'Waiting', 'Active', 'Completed 1h', 'Failed', 'Oldest waiting', '']} rows={d0.queues.map((q) => [
        <Mono key="n">{q.name as string}</Mono>, q.waiting as number, q.active as number, q.done_1h as number, q.failed as number, q.oldest ? `${Math.round(Number(q.oldest) / 60)} min` : '—',
        canManage && String(q.name).endsWith('-dlq') && Number(q.waiting) > 0 ? <ActButton key="r" small action="dlq.requeue" payload={{ queue: String(q.name).replace(/-dlq$/, '') }} reason>🔐 Redrive</ActButton> : null,
      ])} />
      <Section title="Outbox (committed, not yet dispatched)"><Table head={['Queue', 'Rows', 'Oldest']} rows={d0.outbox.map((o) => [o.queue as string, o.n as number, ago(o.oldest)])} empty="Dispatcher is caught up." /></Section>
      {stuckTable}
      <Section title="Per-workspace concurrency (running now)">
        <Table head={['Workspace', 'Queue', 'Active jobs', 'Renders in flight / plan limit']} rows={d0.concurrency.map((c) => {
          const w = d0.workspaces.find((x) => x.id === c.ws);
          const limit = w ? d0.limits.get(w.id as string) : undefined;
          return [w ? <Link key="w" href={`/tenants/${w.id as string}`}>{w.name as string}</Link> : <Mono key="w">{String(c.ws).slice(0, 8)}</Mono>, <Mono key="q">{c.name as string}</Mono>, c.n as number,
            w ? <span key="r" className={limit !== undefined && Number(w.renders) >= limit ? 'ak-chip ak-chip--warn' : ''}>{`${w.renders} / ${limit ?? '—'}`}</span> : '—'];
        })} empty="Nothing running." />
      </Section>
      <Section title="Waiting and running jobs">
        <Table head={['Queued', 'Queue', 'Job', 'Workspace', 'State', '']} rows={d0.running.map((j) => [dt(j.created_on), <Mono key="q">{j.name as string}</Mono>, <Link key="j" href={`/jobs/${j.name as string}/${j.id as string}`}><Mono>{String(j.id).slice(0, 8)}</Mono></Link>, j.ws ? <Link key="w" href={`/tenants/${j.ws}`}>{String(j.ws).slice(0, 8)}</Link> : '—', j.state as string,
          canManage ? <ActButton key="c" small danger action="job.cancel" payload={{ queue: j.name, jobId: j.id, workspaceId: j.ws ?? undefined }} reason confirm={j.state === 'active' ? 'Running: provider calls already sent finish and are reconciled; nothing new is dispatched after its next checkpoint. Cancel?' : 'Not started: nothing was sent to a provider. Cancel?'}>Cancel</ActButton> : null])} empty="Nothing waiting." />
      </Section>
      <Section title="Failed jobs by error class">
        <Table head={['Queue', 'Error class', 'Jobs', 'Last', '']} rows={failedClasses.map((g) => [<Mono key="q">{g.queue}</Mono>, <span key="e" className="ak-small">{pii.text(g.errorClass)}</span>, g.n, dt(g.last),
          canManage && queuePolicy(g.queue)?.idempotent && !queuePolicy(g.queue)?.spends ? <ActButton key="b" small action="job.bulk_retry" payload={{ queue: g.queue, errorClass: g.errorClass }} reason confirm={`Retry all ${g.n} failed ${g.queue} jobs with this error? Held workspaces are skipped.`}>🔐 Retry all</ActButton>
            : queuePolicy(g.queue)?.spends ? <span key="b" className="ak-small ak-muted">spends: retry one by one</span> : null])} empty="No failed jobs retained." />
      </Section>
      <Section title="Failed jobs">
        <Table head={['Finished', 'Queue', 'Job', 'Workspace', 'Retries', 'Error', '']} rows={d0.failed.slice(0, 50).map((j) => [dt(j.completed_on), <Mono key="q">{j.name as string}</Mono>, <Link key="j" href={`/jobs/${j.name as string}/${j.id as string}`}><Mono>{String(j.id).slice(0, 8)}</Mono></Link>, j.ws ? <Link key="w" href={`/tenants/${j.ws}`}>{String(j.ws).slice(0, 8)}</Link> : '—', j.retry_count as number, <span key="e" className="ak-small">{pii.text(JSON.stringify(j.output ?? '')).slice(0, 140)}</span>,
          canRetryQueue(s.roles, j.name as string) ? (NO_SPEND_QUEUES.has(j.name as string) || !queuePolicy(j.name as string)?.spends ? <span key="a" className="ak-row"><ActButton small action="job.retry" payload={{ queue: j.name, jobId: j.id, workspaceId: j.ws ?? undefined }} reason>Retry</ActButton></span> : <Link key="a" href={`/jobs/${j.name as string}/${j.id as string}`}>Retry (may spend) →</Link>) : null])} empty="No failed jobs retained." />
      </Section>
      <Section title="Staff queue commands">
        <Table head={['When', 'Command', 'Payload', 'By', 'Reason', 'Status', 'Result']} rows={d0.commands.map((c) => [dt(c.created_at), c.kind as string, <Mono key="p">{pii.text(JSON.stringify(c.payload)).slice(0, 100)}</Mono>, c.name as string, c.reason as string, c.status as string, <Mono key="r">{pii.text(JSON.stringify(c.result ?? '')).slice(0, 100)}</Mono>])} />
      </Section>
    </Page>
  );
}
