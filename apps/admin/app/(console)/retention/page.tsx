import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { auditView, clusterFreeText, day30ReviewDelivery, RETENTION_POINTS, retentionCohorts, RISK_PLAYBOOKS, staffCan, type RetentionDimension } from '@arkiv/core';
import type { RiskIndicator } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { ago, d, dt, FilterChip, Mono, Page, pct, Section, Table } from '@/components/ui';
import { consolePrefs } from '@/lib/prefs';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Retention' };

/** Churn-risk board (plan 05 §17): indicators with evidence and date, each mapped to a value intervention — never an automatic discount (standard §10). */
const DIMENSIONS: [RetentionDimension, string][] = [['plan', 'By plan'], ['page', 'By acquisition page'], ['ad_account', 'By ad account connected']];

export default async function Retention({ searchParams }: { searchParams: Promise<{ since?: string; by?: string }> }) {
  const s = await requireStaff('retention.read');
  const canSuppress = staffCan(s.roles, 'tenant.flags');
  const sp = await searchParams;
  const today = sp.since === 'today';
  const by: RetentionDimension = DIMENSIONS.some(([k]) => k === sp.by) ? (sp.by as RetentionDimension) : 'plan';
  const prefs = await consolePrefs();
  const d0 = await withAdmin(async (tx) => ({
    audited: await auditView(tx, s, 'retention', { since: today ? 'today' : null, includeTest: prefs.includeTest }),
    flags: await tx`select r.id, r.workspace_id, r.indicator, r.evidence, r.raised_at, r.interventions, w.name, w.plan_code from risk_flags r join workspaces w on w.id = r.workspace_id
                    where r.resolved_at is null ${notTest(tx, prefs, 'r.workspace_id')} and (${!today} or r.raised_at >= date_trunc('day', now(), ${prefs.tz})) order by r.raised_at desc limit 300`,
    suppressed: await tx`select r.workspace_id, r.indicator, r.suppressed_reason, r.suppressed_until, w.name from risk_flags r join workspaces w on w.id = r.workspace_id
                         where r.suppressed_until > now() ${notTest(tx, prefs, 'r.workspace_id')} order by r.suppressed_until limit 100`,
    // The cancel flow's reason code (older events carried code and text merged in `reason`), with the free-text
    // details given under each code.
    reasons: await tx`select coalesce(payload->>'reasonCode', payload->>'reason', 'no reason given') as reason, count(*)::int as n,
                             coalesce(array_agg(payload->>'detail' order by at desc) filter (where coalesce(payload->>'detail', '') <> ''), '{}') as details
                      from events where type = 'SUBSCRIPTION_CHANGED' and (payload->>'cancelAtPeriodEnd' = 'true' or payload->>'immediate' = 'true')
                        and at > now() - interval '90 days' ${notTest(tx, prefs)} group by 1 order by 2 desc`,
    cohorts: await tx`select to_char(date_trunc('week', created_at, ${prefs.tz}) at time zone ${prefs.tz}, 'YYYY-MM-DD') as week, count(*)::int as n,
                             count(*) filter (where status in ('active','trialing','past_due'))::int as still
                      from subscriptions where created_at > now() - interval '120 days' ${notTest(tx, prefs)} group by 1 order by 1 desc`,
    // Plan 05 §17: W1/W4/M2/M3 retention by plan, acquisition page or ad account connected.
    retention: await retentionCohorts(tx, { by, days: 180, includeTest: prefs.includeTest }),
    day30: await day30ReviewDelivery(tx, { days: 90, includeTest: prefs.includeTest }),
  }));
  // Free-text answers from the cancel flow, clustered into themes (deterministic; no model spend).
  const themes = clusterFreeText(d0.reasons.flatMap((r) => (r.details as string[]) ?? []));
  const cell = (p: { eligible: number; retained: number }) => (p.eligible ? `${pct(p.retained / p.eligible, 0)} (${p.retained}/${p.eligible})` : '—');
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
      <Section title="Cohort retention (customers who started a plan in the last 180 days)">
        <div className="ak-row" style={{ margin: '4px 0 12px' }}>{DIMENSIONS.map(([k, l]) => <FilterChip key={k} href={`/retention?by=${k}${today ? '&since=today' : ''}`} on={k === by}>{l}</FilterChip>)}</div>
        <Table head={['Segment', 'Customers', ...RETENTION_POINTS.map((p) => `${p.label} (day ${p.days})`)]} rows={d0.retention.map((r) => [r.segment.toLowerCase().replace(/_/g, ' '), r.customers, ...RETENTION_POINTS.map((p) => cell(r.points[p.key]))])} empty="No plan starts in the last 180 days." />
        <p className="ak-small ak-muted">Retained = had a plan on that day. Only customers old enough for a checkpoint count toward it (the denominator).</p>
      </Section>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Cancellation reasons (90d)"><Table head={['Reason', 'Count', 'What they said']} rows={d0.reasons.map((r) => [(r.reason as string).replace(/_/g, ' '), r.n as number, <span key="d" className="ak-small">{((r.details as string[]) ?? []).slice(0, 5).map((x) => `“${x.slice(0, 140)}”`).join(' · ') || '—'}</span>])} empty="No cancellations." /></Section>
        <Section title="Free-text themes (90d)"><Table head={['Theme', 'Answers', 'Examples']} rows={themes.map((t) => [t.theme, t.count, <span key="e" className="ak-small">{t.examples.map((x) => `“${x.slice(0, 120)}”`).join(' · ')}</span>])} empty="No free-text answers." /></Section>
      </div>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title={`Day-30 SKU Reviews (90d) · ${d0.day30.summary.written} written · ${d0.day30.summary.delivered} delivered · ${d0.day30.summary.notSent} not emailed · ${d0.day30.summary.bounced} bounced`}>
          <Table head={['Written', 'Workspace', 'SKU', 'Email']} rows={d0.day30.reviews.map((r) => [dt(r.created_at), <Link key="w" href={`/tenants/${r.workspace_id}`}>{r.workspace as string}</Link>, (r.sku as string) ?? '—', r.email_status ? `${r.email_status as string}${Number(r.emails) > 1 ? ` (${r.emails} recipients)` : ''}` : <strong key="n">not sent</strong>])} empty="No Day-30 reviews in 90 days." />
        </Section>
        <Section title="Subscription starts (weekly)"><Table head={['Week', 'Started', 'Active now']} rows={d0.cohorts.map((c) => [c.week as string, c.n as number, c.still as number])} /></Section>
      </div>
    </Page>
  );
}
