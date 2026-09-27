import { withAdmin } from '@arkiv/db';
import { armComparison, CIRCUIT_BREAKER, staffCan } from '@arkiv/core';
import { env } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { dt, money, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Providers & routes' };

/** Plan 05 §10. Secrets live in DigitalOcean; the console shows key *names* and whether they're set, never values. */
export default async function Providers() {
  const s = await requireStaff('providers.read');
  const e = env();
  const d0 = await withAdmin(async (tx) => ({
    registry: await tx`select p.*, u.name as updated_by_name from providers p left join staff_users u on u.id = p.updated_by order by p.name`,
    routes: await tx`select * from model_routes order by task`,
    health: await tx`select provider, count(*)::int as n, count(*) filter (where status = 'failed')::int as failed,
                            percentile_cont(0.5) within group (order by latency_ms)::int as p50, percentile_cont(0.95) within group (order by latency_ms)::int as p95,
                            count(*) filter (where moderation_status = 'rejected')::int as moderated
                     from provider_jobs where created_at > now() - interval '24 hours' group by provider`,
    // §48 drift: what providers answered pinned routes with, when it isn't the pinned version (alerts go to Pulse);
    // for unpinned routes, the versions actually served (pin one of them to freeze behaviour).
    drift: await tx`select j.task, r.pinned_model_version as pinned, j.model, j.model_version_returned, count(*)::int as n, max(j.created_at) as last
                    from provider_jobs j join model_routes r on r.task = j.task
                    where j.model_version_returned is not null and j.created_at > now() - interval '7 days'
                      and (r.pinned_model_version is null or (j.model_version_returned <> r.pinned_model_version and j.model_version_returned <> r.pinned_model_version || '-mock'))
                    group by 1, 2, 3, 4 order by max(j.created_at) desc limit 50`,
    driftAlerts: await tx`select subject_id, message, created_at from platform_alerts where kind = 'version_drift' and resolved_at is null order by created_at desc`,
    arms: await armComparison(tx, 7),
    // The audit log is SUPER_ADMIN-only (§0.4); others see a rollback as the canary disappearing from the route.
    rollbacks: staffCan(s.roles, 'audit.read') ? await tx`select target_id, reason, at from admin_audit_log where action = 'route.canary_rollback' order by at desc limit 10` : [],
    kills: await tx`select key, enabled from feature_flags where key like 'kill.provider.%' order by key`,
  }));
  // Secrets live in the platform's secret store: the console shows their names and whether they're set, never values.
  const isSet = (k: string) => !!(e as unknown as Record<string, unknown>)[k];
  const canManage = staffCan(s.roles, 'providers.manage');
  const health = (name: string) => d0.health.find((h) => h.provider === name);
  return (
    <Page title="Providers & model routing" sub={`Mode: ${e.PROVIDERS_MODE}. Pinned ids — Seedream ${e.SEEDREAM_MODEL}, Seedance ${e.SEEDANCE_MODEL}, TTS ${e.MINIMAX_TTS_MODEL}.`}>
      <Section title="Provider registry">
        <p className="ak-small ak-muted">The Model Gateway applies these on every call: a disabled provider is refused (approved fallbacks take over), each request times out after its limit, transient errors retry with exponential backoff, and in-flight requests per worker process are capped.</p>
        <Table head={['Provider', 'Status', 'Secrets (names only)', 'Region', 'Concurrency', 'Timeout', 'Retries', 'Health 24h (p50 / p95 · errors · moderation)', 'Updated', '']} rows={d0.registry.map((p) => {
          const h = health(p.name as string);
          return [
            <span key="n"><Mono>{p.name as string}</Mono><br /><span className="ak-small ak-muted">{p.display_name as string}</span></span>,
            p.status === 'active' ? 'active' : <span key="s" className={`ak-chip ${p.status === 'disabled' ? 'ak-chip--risk' : ''}`}>{p.status as string}</span>,
            <span key="k" className="ak-small">{((p.secret_names as string[]) ?? []).map((k) => `${k} ${isSet(k) ? '✓' : '(not set: mock)'}`).join(' · ')}</span>,
            (p.region as string) ?? '—', p.concurrency_limit as number, `${Math.round(Number(p.timeout_ms) / 1000)}s`, `${p.retry_attempts} × ${p.retry_backoff_ms}ms backoff`,
            h ? `${h.p50 ?? '—'} / ${h.p95 ?? '—'}ms · ${pct(Number(h.failed) / Number(h.n))} · ${pct(Number(h.moderated) / Number(h.n))} of ${h.n}` : 'no calls',
            <span key="u" className="ak-small">{dt(p.updated_at)}{p.updated_by_name ? ` · ${p.updated_by_name as string}` : ''}</span>,
            canManage ? (
              <details key="e">
                <summary className="ak-small">Edit</summary>
                <ActForm action="provider.update" extra={{ name: p.name }} submit="🔐 Save" fields={[
                  { name: 'status', label: 'Status', type: 'select', options: ['active', 'degraded', 'disabled'], defaultValue: p.status as string },
                  { name: 'region', label: 'Region', defaultValue: (p.region as string) ?? '' },
                  { name: 'concurrencyLimit', label: 'Concurrency limit (in-flight per worker)', type: 'number', defaultValue: p.concurrency_limit as number },
                  { name: 'timeoutMs', label: 'Timeout per request (ms)', type: 'number', defaultValue: p.timeout_ms as number },
                  { name: 'retryAttempts', label: 'Attempts on transient errors', type: 'number', defaultValue: p.retry_attempts as number },
                  { name: 'retryBackoffMs', label: 'First backoff (ms, doubles)', type: 'number', defaultValue: p.retry_backoff_ms as number },
                  { name: 'notes', label: 'Notes', defaultValue: (p.notes as string) ?? '' },
                  { name: 'reason', label: 'Reason (audit)', required: true },
                ]} />
              </details>
            ) : null,
          ];
        })} />
      </Section>
      <Section title="Routes">
        <p className="ak-small ak-muted">The breaker opens a route automatically when {pct(CIRCUIT_BREAKER.errorRate, 0)} or more of at least {CIRCUIT_BREAKER.minCalls} calls in {CIRCUIT_BREAKER.windowMinutes} min fail outage-class (or its provider does across routes), and tries again after {CIRCUIT_BREAKER.coolDownMinutes} min (defaults; tune under Flags &amp; config → circuit.*). Circuits staff open stay open until closed.</p>
        <Table head={['Task', 'Provider', 'Model', 'Pinned version', 'Prompt', 'Rollout', 'Canary', 'Approved fallback', 'Circuit', '']} rows={d0.routes.map((r) => [
          <Mono key="t">{r.task as string}</Mono>, r.provider as string, <Mono key="m">{r.model as string}</Mono>, r.pinned_model_version ? <Mono key="v">{r.pinned_model_version as string}</Mono> : '—', <Mono key="p">{r.prompt_version as string}</Mono>, `${r.rollout_pct}%`, r.canary ? <Mono key="c">{JSON.stringify(r.canary)}</Mono> : '—',
          r.fallback_task ? <Mono key="f">{r.fallback_task as string}</Mono> : 'queue on outage',
          r.circuit_open ? <span key="o" title={(r.circuit_reason as string) ?? ''} className="ak-chip ak-chip--risk">{r.circuit_auto ? 'auto-opened' : 'open'}{r.circuit_until ? ` · ${r.circuit_auto ? 'retries' : 'back'} ~${dt(r.circuit_until)}` : ''}</span> : 'closed',
          <span key="a" className="ak-row">
            {staffCan(s.roles, 'providers.circuit') ? <ActButton small action="route.circuit" payload={{ task: r.task, open: !r.circuit_open }} reason danger={!r.circuit_open}>{r.circuit_open ? 'Close circuit' : 'Open circuit'}</ActButton> : null}
          </span>,
        ])} />
      </Section>
      {staffCan(s.roles, 'providers.circuit') && d0.routes.some((r) => r.circuit_open) ? (
        <Section title="Queue ETA for an open circuit">
          <div className="ak-panel" style={{ maxWidth: 560 }}>
            <p className="ak-small ak-muted">Customers whose ads wait behind an open circuit see “Queued: our … partner is busy. Your place is held.” Add when you expect it back and they see that too.</p>
            <ActForm action="route.circuit" extra={{ open: true }} submit="Set ETA" fields={[
              { name: 'task', label: 'Route', type: 'select', options: d0.routes.filter((r) => r.circuit_open).map((r) => r.task as string) },
              { name: 'reopenMinutes', label: 'Expected back in (minutes)', type: 'number', required: true },
              { name: 'reason', label: 'Reason', required: true },
            ]} />
          </div>
        </Section>
      ) : null}
      {staffCan(s.roles, 'routes.manage') ? (
        <Section title="Change a route (needs a passing eval for this template × model; 100% also needs a second approver)">
          <div className="ak-panel" style={{ maxWidth: 560 }}>
            <p className="ak-small ak-muted">Canary traffic is split per workspace; each call records its arm. A canary whose QA first-pass or claim-block rate regresses is rolled back automatically. 0% ends the canary.</p>
            <ActForm action="route.update" submit="🔐 Apply" fields={[
              { name: 'task', label: 'Task', type: 'select', options: d0.routes.map((r) => r.task as string) },
              { name: 'rolloutPct', label: 'Rollout %', type: 'select', options: ['5', '25', '100', '0'] },
              { name: 'model', label: 'Model (optional)' },
              { name: 'promptVersion', label: 'Prompt version (optional)' },
              { name: 'reason', label: 'Reason', required: true },
            ]} />
          </div>
        </Section>
      ) : null}
      {staffCan(s.roles, 'routes.manage') ? (
        <Section title="Fallback and version pin (🔐)">
          <div className="ak-grid-2" style={{ alignItems: 'start' }}>
            <div className="ak-panel">
              <p className="ak-small ak-muted">When a route’s circuit is open or its provider is down, the gateway retries the call once on its approved fallback (its own job and rate); without one, productions queue. Same kind of task, priced on a published rate. Leave empty to remove.</p>
              <ActForm action="route.fallback" submit="🔐 Set fallback" fields={[
                { name: 'task', label: 'Route', type: 'select', options: d0.routes.map((r) => r.task as string) },
                { name: 'fallbackTask', label: 'Fallback route (empty = none)', type: 'select', options: ['', ...d0.routes.map((r) => r.task as string)] },
                { name: 'reason', label: 'Reason', required: true },
              ]} />
            </div>
            <div className="ak-panel">
              <p className="ak-small ak-muted">Pin the exact provider version a route sends, so a silent provider upgrade can’t change output (§48). Pin to what “Version drift” shows is live. Leave empty to unpin.</p>
              <ActForm action="route.pin" submit="🔐 Pin version" fields={[
                { name: 'task', label: 'Route', type: 'select', options: d0.routes.map((r) => r.task as string) },
                { name: 'version', label: 'Provider version (empty = unpin)' },
                { name: 'driftPolicy', label: 'If the provider answers with another version', type: 'select', options: [{ value: 'alert', label: 'Alert + run the golden set' }, { value: 'hold', label: 'Also hold the route until re-pinned' }] },
                { name: 'reason', label: 'Reason', required: true },
              ]} />
            </div>
          </div>
        </Section>
      ) : null}
      <Section title="Rollout arms (7d)">
        <Table
          head={['Task', 'Arm', 'Calls', 'Error rate', 'p50', 'Avg cost / call', 'QA first-pass', 'Claim blocks']}
          rows={d0.arms.map((a) => [
            <Mono key="t">{a.task}</Mono>, a.arm, a.calls, pct(a.errorRate), a.p50LatencyMs != null ? `${a.p50LatencyMs}ms` : '—', a.avgCostMicros != null ? money(a.avgCostMicros, 4) : '—',
            a.qaFirst ? `${pct(Number(a.qaFirstPassed) / a.qaFirst)} of ${a.qaFirst}` : '—', a.projects ? `${pct(Number(a.blocked) / a.projects)} of ${a.projects}` : '—',
          ])}
          empty="No calls in 7 days."
        />
        <Table head={['Rolled back', 'Route', 'Why']} rows={d0.rollbacks.map((r) => [dt(r.at), <Mono key="t">{r.target_id as string}</Mono>, r.reason as string])} empty="No automatic canary rollbacks." />
      </Section>
      <Section title="Provider kill switches"><Table head={['Switch', 'State']} rows={d0.kills.map((k) => [<Mono key="k">{k.key as string}</Mono>, k.enabled ? <span key="s" className="ak-chip ak-chip--risk">ON — calls refused</span> : 'off'])} empty="—" /><p className="ak-small ak-muted">Toggle in Flags & config (🔐).</p></Section>
      <Section title="Version drift (7d)">
        {d0.driftAlerts.length ? <p className="ak-banner ak-banner--risk">Pinned routes answered with another version: {d0.driftAlerts.map((a) => a.subject_id as string).join(', ')}. Resolve the alert on Pulse once re-pinned or rolled back.</p> : null}
        <Table head={['Task', 'Pinned', 'Configured', 'Returned', 'Calls', 'Last']} rows={d0.drift.map((x) => [x.task as string, x.pinned ? <Mono key="p">{x.pinned as string}</Mono> : <span key="p" className="ak-muted">not pinned</span>, <Mono key="m">{x.model as string}</Mono>, <Mono key="r">{x.model_version_returned as string}</Mono>, x.n as number, dt(x.last)])} empty="No drift detected." />
      </Section>
    </Page>
  );
}
