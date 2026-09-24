import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { auditView, RISK_PLAYBOOKS, staffCan } from '@arkiv/core';
import type { RiskIndicator } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { ago, d, Mono, Page, Section, Table } from '@/components/ui';
import { consolePrefs } from '@/lib/prefs';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Retention' };

/** Churn-risk board (plan 05 §17): indicators with evidence and date, each mapped to a value intervention — never an automatic discount (standard §10). */
export default async function Retention({ searchParams }: { searchParams: Promise<{ since?: string }> }) {
  const s = await requireStaff('retention.read');
  const canSuppress = staffCan(s.roles, 'tenant.flags');
  const today = (await searchParams).since === 'today';
  const prefs = await consolePrefs();
  const d0 = await withAdmin(async (tx) => ({
    audited: await auditView(tx, s, 'retention', { since: today ? 'today' : null, includeTest: prefs.includeTest }),
    flags: await tx`select r.id, r.workspace_id, r.indicator, r.evidence, r.raised_at, r.interventions, w.name, w.plan_code from risk_flags r join workspaces w on w.id = r.workspace_id
                    where r.resolved_at is null ${notTest(tx, prefs, 'r.workspace_id')} and (${!today} or r.raised_at >= date_trunc('day', now(), ${prefs.tz})) order by r.raised_at desc limit 300`,
    suppressed: await tx`select r.workspace_id, r.indicator, r.suppressed_reason, r.suppressed_until, w.name from risk_flags r join workspaces w on w.id = r.workspace_id
                         where r.suppressed_until > now() ${notTest(tx, prefs, 'r.workspace_id')} order by r.suppressed_until limit 100`,
    reasons: await tx`select coalesce(payload->>'reason', 'no reason given') as reason, count(*)::int as n from events where type = 'SUBSCRIPTION_CHANGED' and payload->>'cancelAtPeriodEnd' = 'true' and at > now() - interval '90 days' ${notTest(tx, prefs)} group by 1 order by 2 desc`,
    cohorts: await tx`select to_char(date_trunc('week', created_at, ${prefs.tz}) at time zone ${prefs.tz}, 'YYYY-MM-DD') as week, count(*)::int as n,
                             count(*) filter (where status in ('active','trialing','past_due'))::int as still,
                             count(*) filter (where created_at < now() - interval '28 days' and (status in ('active','trialing','past_due') or updated_at > created_at + interval '28 days'))::int as w4
                      from subscriptions where created_at > now() - interval '120 days' ${notTest(tx, prefs)} group by 1 order by 1 desc`,
  }));
  const pb = (i: unknown) => RISK_PLAYBOOKS[i as RiskIndicator];
  const started = (f: Record<string, unknown>) => ((f.interventions as { at: string }[]) ?? []).map((x) => x.at).sort().at(-1) ?? null;
  return (
    <Page title="Retention & customer success" sub={today ? <>Indicators raised today ({prefs.tz}). <Link href="/retention">Show all open indicators</Link></> : 'Churn-risk board: indicators with evidence and a mapped value intervention.'}>
      <Table head={['Workspace', 'Plan', 'Indicator', 'Evidence', 'Since', 'Playbook', '']} rows={d0.flags.map((f) => [
        <Link key="w" href={`/tenants/${f.workspace_id}?tab=risk`}>{f.name as string}</Link>, (f.plan_code as string)?.toLowerCase() ?? '—', pb(f.indicator)?.label ?? (f.indicator as string),
        <Mono key="e">{JSON.stringify(f.evidence).slice(0, 100)}</Mono>, ago(f.raised_at), <span key="p" className="ak-small">{pb(f.indicator)?.intervention ?? '—'}</span>,
        canSuppress ? (
          <span key="s" className="ak-stack" style={{ ['--stack' as string]: '6px' }}>
            <ActButton small action="intervention.start" payload={{ workspaceId: f.workspace_id, flagId: f.id }} confirm={pb(f.indicator)?.email || pb(f.indicator)?.notice ? `Start the playbook? ${[pb(f.indicator)?.email ? 'Emails the owners and admins' : null, pb(f.indicator)?.notice ? 'posts an in-app notice' : null].filter(Boolean).join(' and ')}.` : 'Record that you started the personal follow-up?'}>
              Start playbook{started(f) ? ` (last ${ago(started(f))})` : ''}
            </ActButton>
            <ActForm inline action="tenant.risk_suppress" extra={{ workspaceId: f.workspace_id, flagId: f.id }} submit="Suppress" fields={[{ name: 'days', label: 'Days', type: 'number', defaultValue: 30, required: true }, { name: 'reason', label: 'Reason', required: true }]} />
          </span>
        ) : null,
      ])} empty="No open churn-risk indicators." />
      <Section title="Suppressed indicators">
        <Table head={['Workspace', 'Indicator', 'Reason', 'Suppressed until']} rows={d0.suppressed.map((x) => [<Link key="w" href={`/tenants/${x.workspace_id}?tab=risk`}>{x.name as string}</Link>, pb(x.indicator)?.label ?? (x.indicator as string), x.suppressed_reason as string, d(x.suppressed_until)])} empty="No active suppressions." />
      </Section>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Cancellation reasons (90d)"><Table head={['Reason', 'Count']} rows={d0.reasons.map((r) => [r.reason as string, r.n as number])} empty="No cancellations." /></Section>
        <Section title="Subscription cohorts (weekly)"><Table head={['Week', 'Started', 'Active now', 'Retained W4']} rows={d0.cohorts.map((c) => [c.week as string, c.n as number, c.still as number, c.w4 as number])} /></Section>
      </div>
    </Page>
  );
}
