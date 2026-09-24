import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { auditView, canRetryQueue, jobErrorClass, jobRetryEstimate, queuePolicy, setting, shouldMaskPii, staffCan } from '@arkiv/core';
import { ActButton } from '@/components/act';
import { dt, money, Mono, Page, Section, Table } from '@/components/ui';
import { maskJobPayload, piiView } from '@/lib/mask';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Job' };

const UUID = /^[0-9a-f-]{36}$/i;
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(v[k] ?? ''));

/**
 * Plan 05 §12 job detail: payload (secrets and PII masked), state history, attempts, the outbox row that created it,
 * linked provider jobs (request ids), ledger rows and the related project state, with links out to logs and traces.
 * Metadata only — no tenant content — so no break-glass; the view is audited.
 */
export default async function JobDetail({ params }: { params: Promise<{ queue: string; id: string }> }) {
  const s = await requireStaff('jobs.read');
  const { queue, id } = await params;
  if (!UUID.test(id) || !/^[a-z0-9-]{2,60}$/.test(queue)) notFound();
  const pii = piiView(shouldMaskPii(s.roles));
  const d0 = await withAdmin(async (tx) => {
    let job: Record<string, unknown> | null = null;
    try {
      const rows = (await tx.savepoint((sp) => sp`select id, name, data, state, priority, retry_count, retry_limit, retry_delay, start_after, started_on, created_on, completed_on,
                                                    keep_until, singleton_key, output, dead_letter from pgboss.job where name = ${queue} and id = ${id}::uuid`)) as Record<string, unknown>[];
      job = rows[0] ?? null;
    } catch {
      job = null; // queue tables not visible yet: the outbox row still tells most of the story
    }
    const [outbox] = await tx`select workspace_id, queue, run_after, priority, created_at, dispatched_at, singleton_key, payload->>'requestId' as request_id from outbox where id = ${id}`;
    if (!job && !outbox) return null;
    const data = (job?.data as Record<string, unknown> | undefined) ?? {};
    const ws = (typeof data.workspaceId === 'string' ? data.workspaceId : (outbox?.workspace_id as string | undefined)) ?? null;
    await auditView(tx, s, 'job', { queue, id }, ws);
    const projectId = typeof data.projectId === 'string' && UUID.test(data.projectId) ? data.projectId : null;
    const skuId = typeof data.skuId === 'string' && UUID.test(data.skuId) ? data.skuId : null;
    const [workspace] = ws ? await tx`select id, name, state from workspaces where id = ${ws}` : [];
    const [project] = ws && projectId ? await tx`select id, kind, state, updated_at, failure_reason, outage, authorization_id from projects where id = ${projectId} and workspace_id = ${ws}` : [];
    // Provider calls this job made: same workspace and subject (project or SKU), while the job ran.
    const from = (job?.started_on ?? job?.created_on ?? outbox?.created_at ?? null) as string | null;
    const to = (job?.completed_on ?? null) as string | null;
    const providerJobs = ws && (projectId || skuId) && from
      ? await tx`select id, task, provider, model, model_version_returned, status, provider_request_id, authorization_id, estimate_micros, actual_micros, latency_ms, error, created_at
                 from provider_jobs where workspace_id = ${ws}
                   and (project_id = ${projectId} or (${skuId}::uuid is not null and subject_id = ${skuId}::uuid))
                   and created_at >= ${from}::timestamptz - interval '1 minute' and created_at <= coalesce(${to}::timestamptz, now()) + interval '1 minute'
                 order by created_at limit 100`
      : [];
    const authIds = [...new Set([...providerJobs.map((j) => j.authorization_id as string | null), (project?.authorization_id as string | null) ?? null].filter((x): x is string => !!x))];
    const ledger = ws && authIds.length ? await tx`select id, type, unit, amount, authorization_id, provider_job_id, reason, actor, created_at from ledger_entries where workspace_id = ${ws} and authorization_id = any(${authIds}::uuid[]) order by id limit 100` : [];
    const policy = queuePolicy(queue);
    const estimate = policy?.spends && job?.state === 'failed' ? await jobRetryEstimate(tx, { ...data, workspaceId: ws }).catch(() => null) : null;
    const templates = { log: await setting(tx, 'ops.log_url_template'), trace: await setting(tx, 'ops.trace_url_template') };
    return { job, outbox, data, ws, workspace, project, providerJobs, ledger, policy, estimate, templates };
  });
  if (!d0) notFound();
  const { job, outbox } = d0;
  const state = (job?.state as string | undefined) ?? (outbox?.dispatched_at ? 'dispatched (not visible)' : 'in outbox');
  const vars = { jobId: id, queue, requestId: (outbox?.request_id as string | undefined) ?? String(d0.data.requestId ?? '') };
  const canManage = staffCan(s.roles, 'jobs.manage');
  const history: [string, unknown, string][] = [
    ['Committed to outbox', outbox?.created_at, outbox ? `run after ${dt(outbox.run_after)}` : '—'],
    ['Dispatched to queue', outbox?.dispatched_at ?? job?.created_on, job ? `priority ${job.priority}` : ''],
    ['Start after', job?.start_after, job?.singleton_key ? `singleton ${job.singleton_key as string}` : ''],
    ['Started (last attempt)', job?.started_on, job ? `attempt ${Number(job.retry_count) + 1} of ${Number(job.retry_limit) + 1}` : ''],
    [`Finished (${state})`, job?.completed_on, job?.dead_letter ? `dead letter → ${job.dead_letter as string}` : ''],
  ];
  return (
    <Page title={`Job ${id.slice(0, 8)}`} sub={<><Link href="/jobs">Jobs & queues</Link> · <Mono>{queue}</Mono> · {state}{d0.workspace ? <> · <Link href={`/tenants/${d0.workspace.id as string}`}>{d0.workspace.name as string}</Link> ({d0.workspace.state as string})</> : null}</>}>
      <div className="ak-row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {d0.templates.log ? <a className="ak-btn ak-btn--secondary ak-btn--sm" href={fill(d0.templates.log, vars)} target="_blank" rel="noreferrer">Logs ↗</a> : null}
        {d0.templates.trace ? <a className="ak-btn ak-btn--secondary ak-btn--sm" href={fill(d0.templates.trace, vars)} target="_blank" rel="noreferrer">Trace ↗</a> : null}
        {!d0.templates.log && !d0.templates.trace ? <span className="ak-small ak-muted">Set ops.log_url_template / ops.trace_url_template in Flags &amp; config to link out (placeholders {'{jobId}'}, {'{queue}'}, {'{requestId}'}).</span> : null}
        {job?.state === 'failed' && canRetryQueue(s.roles, queue) && d0.policy?.idempotent ? (
          d0.policy.spends ? (
            <ActButton action="job.retry" payload={{ queue, jobId: id, ...(d0.estimate ? { confirmEstimateMicros: d0.estimate.micros } : { confirmSpend: true }) }} reason
              confirm={d0.estimate ? `Retry at a fresh estimate of ${money(d0.estimate.micros)} (first authorized at ${money(d0.estimate.previousMicros)}${d0.estimate.rateChanged ? '; rates changed since' : ''})? The handler takes a new Cost Governor authorization.` : 'This job never reached an authorization; on retry the handler asks the Cost Governor for one at current rates, within its class ceiling. Retry?'}>
              Retry (spends ~{d0.estimate ? money(d0.estimate.micros) : 'fresh estimate'})
            </ActButton>
          ) : <ActButton action="job.retry" payload={{ queue, jobId: id }} reason>Retry (no spend)</ActButton>
        ) : null}
        {canManage && job && ['created', 'retry', 'active'].includes(job.state as string) ? (
          <ActButton action="job.cancel" payload={{ queue, jobId: id }} reason danger confirm={job.state === 'active' ? 'This job is running: provider calls already sent finish and are reconciled; nothing new is dispatched after its next checkpoint. Cancel?' : 'This job has not started: nothing was sent to a provider. Cancel?'}>Cancel job</ActButton>
        ) : null}
      </div>
      {d0.policy ? <p className="ak-small ak-muted">Queue policy: {d0.policy.idempotent ? 'idempotent handler' : 'not idempotent — never retried from here'} · {d0.policy.spends ? 'spends on providers (retry needs a fresh estimate)' : 'no provider spend'}.</p> : null}
      <Section title="State history">
        <Table head={['Step', 'When', '']} rows={history.map(([k, v, note]) => [k, dt(v), <span key="n" className="ak-small">{note}</span>])} />
        {job?.output && job.state === 'failed' ? <p className="ak-small">Error class <Mono>{jobErrorClass(job.output)}</Mono>: <span className="ak-mono">{pii.text(JSON.stringify(job.output)).slice(0, 600)}</span></p> : null}
      </Section>
      <Section title="Payload (secrets and PII masked)">
        <pre className="ak-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--paper-sunk)', padding: 12 }}>{JSON.stringify(maskJobPayload(d0.data, pii.mask), null, 2)}</pre>
      </Section>
      {d0.project ? (
        <Section title="Related project">
          <Table head={['Project', 'Kind', 'State', 'Updated', 'Why']} rows={[[<Link key="p" href={`/tenants/${d0.ws}?tab=projects&project=${d0.project.id as string}`}><Mono>{String(d0.project.id).slice(0, 8)}</Mono></Link>, d0.project.kind as string, d0.project.state as string, dt(d0.project.updated_at), <span key="w" className="ak-small">{pii.text((d0.project.failure_reason as string) ?? (d0.project.outage ? `outage: ${JSON.stringify(d0.project.outage)}` : ''))}</span>]]} />
        </Section>
      ) : null}
      <Section title="Provider jobs (request ids)">
        <Table head={['When', 'Task', 'Provider · model', 'Status', 'Provider request id', 'Estimate / actual', 'Latency', 'Error']} rows={d0.providerJobs.map((j) => [
          dt(j.created_at), <Mono key="t">{j.task as string}</Mono>, <Mono key="m">{`${j.provider} · ${(j.model_version_returned as string) ?? j.model}`}</Mono>, j.status as string,
          j.provider_request_id ? <Mono key="r">{j.provider_request_id as string}</Mono> : '—', `${money(Number(j.estimate_micros), 4)} / ${j.actual_micros == null ? '—' : money(Number(j.actual_micros), 4)}`,
          j.latency_ms == null ? '—' : `${j.latency_ms}ms`, <span key="e" className="ak-small">{pii.text((j.error as string) ?? '').slice(0, 160)}</span>,
        ])} empty="No provider calls linked to this job." />
      </Section>
      <Section title="Ledger rows">
        <Table head={['#', 'When', 'Type', 'Unit', 'Amount', 'Authorization', 'Actor', 'Reason']} rows={d0.ledger.map((l) => [String(l.id), dt(l.created_at), l.type as string, l.unit as string, l.unit === 'usd_micros' ? money(Number(l.amount), 4) : String(l.amount), <Mono key="a">{String(l.authorization_id).slice(0, 8)}</Mono>, <span key="c" className="ak-small">{l.actor as string}</span>, <span key="r" className="ak-small">{pii.text((l.reason as string) ?? '')}</span>])} empty="No ledger rows for this job's authorizations." />
      </Section>
    </Page>
  );
}
