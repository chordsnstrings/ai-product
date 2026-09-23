import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { ActButton } from '@/components/act';
import { ago, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Retention' };

/** Value interventions, never automatic discounts (standard §10). */
const PLAYBOOK: Record<string, string> = {
  idle_7d: 'Email the week’s top recommendation with a one-click approve link.',
  paid_no_export: '“Your ad is ready — here’s how to upload it to Meta in 2 minutes.” (email + in-app)',
  repeated_qa_rejects: 'OPS reviews the SKU’s fingerprint and reference photos; offer a better-photo guide.',
  ignored_recommendations: 'Ask one question: “Are these the wrong kind of tests?”',
  ad_account_disconnected: 'Reconnect prompt with the exact scope explanation.',
  low_utilisation: 'Suggest the plan that fits usage (downgrade is fine).',
  no_performance_linked_test: 'Walk through variant codes in ad names / CSV upload.',
};

export default async function Retention() {
  await requireStaff('retention.read');
  const d0 = await withAdmin(async (tx) => ({
    flags: await tx`select r.id, r.workspace_id, r.indicator, r.evidence, r.raised_at, w.name, w.plan_code from risk_flags r join workspaces w on w.id = r.workspace_id
                    where r.resolved_at is null and not w.is_test order by r.raised_at desc limit 300`,
    reasons: await tx`select coalesce(payload->>'reason', 'no reason given') as reason, count(*)::int as n from events where type = 'SUBSCRIPTION_CHANGED' and payload->>'cancelAtPeriodEnd' = 'true' and at > now() - interval '90 days' group by 1 order by 2 desc`,
    cohorts: await tx`select to_char(date_trunc('week', created_at), 'YYYY-MM-DD') as week, count(*)::int as n,
                             count(*) filter (where status in ('active','trialing','past_due'))::int as still,
                             count(*) filter (where created_at < now() - interval '28 days' and (status in ('active','trialing','past_due') or updated_at > created_at + interval '28 days'))::int as w4
                      from subscriptions where created_at > now() - interval '120 days' group by 1 order by 1 desc`,
  }));
  return (
    <Page title="Retention & customer success" sub="Churn-risk board: indicators with evidence and a mapped value intervention.">
      <Table head={['Workspace', 'Plan', 'Indicator', 'Evidence', 'Since', 'Playbook', '']} rows={d0.flags.map((f) => [
        <Link key="w" href={`/tenants/${f.workspace_id}?tab=risk`}>{f.name as string}</Link>, (f.plan_code as string)?.toLowerCase() ?? '—', f.indicator as string,
        <Mono key="e">{JSON.stringify(f.evidence).slice(0, 100)}</Mono>, ago(f.raised_at), <span key="p" className="ak-small">{PLAYBOOK[f.indicator as string] ?? '—'}</span>,
        <ActButton key="s" small action="tenant.risk_suppress" payload={{ workspaceId: f.workspace_id, flagId: f.id }} reason>Resolve</ActButton>,
      ])} empty="No open churn-risk indicators." />
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Cancellation reasons (90d)"><Table head={['Reason', 'Count']} rows={d0.reasons.map((r) => [r.reason as string, r.n as number])} empty="No cancellations." /></Section>
        <Section title="Subscription cohorts (weekly)"><Table head={['Week', 'Started', 'Active now', 'Retained W4']} rows={d0.cohorts.map((c) => [c.week as string, c.n as number, c.still as number, c.w4 as number])} /></Section>
      </div>
    </Page>
  );
}
