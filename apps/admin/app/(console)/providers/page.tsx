import { withAdmin } from '@arkiv/db';
import { staffCan } from '@arkiv/core';
import { env } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { dt, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Providers & routes' };

/** Plan 05 §10. Secrets live in DigitalOcean; the console shows key *names* and whether they're set, never values. */
export default async function Providers() {
  const s = await requireStaff('providers.read');
  const e = env();
  const d0 = await withAdmin(async (tx) => ({
    routes: await tx`select * from model_routes order by task`,
    health: await tx`select provider, count(*)::int as n, count(*) filter (where status = 'failed')::int as failed,
                            percentile_cont(0.5) within group (order by latency_ms)::int as p50, percentile_cont(0.95) within group (order by latency_ms)::int as p95,
                            count(*) filter (where error ilike '%moderation%' or error ilike '%sensitive%')::int as moderated
                     from provider_jobs where created_at > now() - interval '24 hours' group by provider`,
    drift: await tx`select task, model, model_version_returned, count(*)::int as n, max(created_at) as last from provider_jobs
                    where model_version_returned is not null and model_version_returned <> model and created_at > now() - interval '7 days' group by 1, 2, 3`,
    arms: await tx`select task, arm, count(*)::int as n, count(*) filter (where status = 'failed')::int as failed from provider_jobs
                   where arm is not null and created_at > now() - interval '7 days' group by 1, 2 order by 1, 2`,
    // The audit log is SUPER_ADMIN-only (§0.4); others see a rollback as the canary disappearing from the route.
    rollbacks: staffCan(s.roles, 'audit.read') ? await tx`select target_id, reason, at from admin_audit_log where action = 'route.canary_rollback' order by at desc limit 10` : [],
    kills: await tx`select key, enabled from feature_flags where key like 'kill.provider.%' order by key`,
  }));
  const keys: [string, string, boolean][] = [
    ['anthropic', 'ANTHROPIC_API_KEY', !!e.ANTHROPIC_API_KEY],
    ['byteplus (Seedream/Seedance)', 'ARK_API_KEY', !!e.ARK_API_KEY],
    ['minimax (TTS)', 'MINIMAX_API_KEY', !!e.MINIMAX_API_KEY],
    ['byteplus speech (fallback TTS)', 'BYTEPLUS_SPEECH_TOKEN', !!e.BYTEPLUS_SPEECH_TOKEN],
  ];
  return (
    <Page title="Providers & model routing" sub={`Mode: ${e.PROVIDERS_MODE}. Pinned ids — Seedream ${e.SEEDREAM_MODEL}, Seedance ${e.SEEDANCE_MODEL}, TTS ${e.MINIMAX_TTS_MODEL}.`}>
      <Table head={['Provider', 'Secret (name only)', 'Configured']} rows={keys.map(([p, k, set]) => [p, <Mono key="k">{k}</Mono>, set ? 'yes' : 'no (mock)'])} />
      <Section title="Health (24h)"><Table head={['Provider', 'Calls', 'Error rate', 'p50', 'p95', 'Moderation rejects']} rows={d0.health.map((h) => [h.provider as string, h.n as number, pct(Number(h.failed) / Number(h.n)), `${h.p50 ?? '—'}ms`, `${h.p95 ?? '—'}ms`, h.moderated as number])} empty="No calls in 24h." /></Section>
      <Section title="Routes">
        <Table head={['Task', 'Provider', 'Model', 'Prompt', 'Rollout', 'Canary', 'Approved fallback', 'Circuit', '']} rows={d0.routes.map((r) => [
          <Mono key="t">{r.task as string}</Mono>, r.provider as string, <Mono key="m">{r.model as string}</Mono>, <Mono key="p">{r.prompt_version as string}</Mono>, `${r.rollout_pct}%`, r.canary ? <Mono key="c">{JSON.stringify(r.canary)}</Mono> : '—',
          r.fallback_task ? <Mono key="f">{r.fallback_task as string}</Mono> : 'queue on outage',
          r.circuit_open ? <span key="o" className="ak-chip ak-chip--risk">open{r.circuit_until ? ` · back ~${dt(r.circuit_until)}` : ''}</span> : 'closed',
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
      <Section title="Rollout arms (7d)">
        <Table head={['Task', 'Arm', 'Calls', 'Failed']} rows={d0.arms.map((a) => [<Mono key="t">{a.task as string}</Mono>, a.arm as string, a.n as number, a.failed as number])} empty="No calls in 7 days." />
        <Table head={['Rolled back', 'Route', 'Why']} rows={d0.rollbacks.map((r) => [dt(r.at), <Mono key="t">{r.target_id as string}</Mono>, r.reason as string])} empty="No automatic canary rollbacks." />
      </Section>
      <Section title="Provider kill switches"><Table head={['Switch', 'State']} rows={d0.kills.map((k) => [<Mono key="k">{k.key as string}</Mono>, k.enabled ? <span key="s" className="ak-chip ak-chip--risk">ON — calls refused</span> : 'off'])} empty="—" /><p className="ak-small ak-muted">Toggle in Flags & config (🔐).</p></Section>
      <Section title="Version drift (7d)"><Table head={['Task', 'Pinned', 'Returned', 'Calls', 'Last']} rows={d0.drift.map((x) => [x.task as string, <Mono key="p">{x.model as string}</Mono>, <Mono key="r">{x.model_version_returned as string}</Mono>, x.n as number, dt(x.last)])} empty="No drift detected." /></Section>
    </Page>
  );
}
