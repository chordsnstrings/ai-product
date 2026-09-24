import { withAdmin } from '@arkiv/db';
import { FUNNEL_SLICES, funnelBySlice, type FunnelSlice } from '@arkiv/core';
import { FilterChip, Page, pct, Section, Table } from '@/components/ui';
import { consolePrefs, daysFrom } from '@/lib/prefs';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Funnel' };

const STAGES = ['LP_VIEWED', 'UPLOAD_STARTED', 'UPLOAD_COMPLETED', 'CONCEPTS_READY', 'ACCOUNT_CLAIMED', 'STORYBOARD_READY', 'CHECKOUT_STARTED', 'TASTE_PAID', 'ASSET_EXPORTED', 'SUBSCRIPTION_STARTED'];

/** Plan 05 §4: server-side funnel events are the source of truth (ad blockers can't hide them). */
export default async function Funnel({ searchParams }: { searchParams: Promise<{ by?: string; days?: string }> }) {
  await requireStaff('analytics.read');
  const sp = await searchParams;
  const prefs = await consolePrefs();
  const by: FunnelSlice = (FUNNEL_SLICES as readonly string[]).includes(sp.by ?? '') ? (sp.by as FunnelSlice) : 'page';
  const days = daysFrom(sp.days, prefs);
  const d0 = await withAdmin(async (tx) => {
    // Attribute every event of a visitor to the slice of their first landing view.
    const slices = await funnelBySlice(tx, { by, days, includeTest: prefs.includeTest });
    const failures = await tx`select coalesce(props->>'reason', type) as reason, count(*)::int as n from funnel_events where type in ('URL_PARSE_FAILED','SKU_REJECTED') and at > now() - make_interval(days => ${days}) ${notTest(tx, prefs)} group by 1 order by 2 desc`;
    const abandoned = await tx`select count(distinct visitor_id)::int as n from funnel_events s where s.type = 'UPLOAD_STARTED' and s.at > now() - make_interval(days => ${days})
                                 and not exists (select 1 from funnel_events c where c.type = 'UPLOAD_COMPLETED' and c.visitor_id = s.visitor_id) ${notTest(tx, prefs, 's.workspace_id')}`;
    const cohort = await tx`select to_char(date_trunc('week', p.paid_at, ${prefs.tz}) at time zone ${prefs.tz}, 'YYYY-MM-DD') as week, count(distinct p.workspace_id)::int as taste,
                                   count(distinct s.workspace_id)::int as subscribed
                            from purchases p left join subscriptions s on s.workspace_id = p.workspace_id and s.created_at > p.paid_at
                            where p.kind = 'taste' and p.status in ('paid','refunded') and p.paid_at > now() - interval '120 days' ${notTest(tx, prefs, 'p.workspace_id')} group by 1 order by 1 desc`;
    return { slices, failures, abandoned: abandoned[0]!.n as number, cohort };
  });
  const names = [...new Set(d0.slices.map((s) => s.slice))];
  const get = (slice: string, t: string) => d0.slices.find((s) => s.slice === slice && s.type === t)?.n ?? 0;
  return (
    <Page title="Acquisition & funnel" sub={`Last ${days} days · unique visitors per stage, attributed to first landing view · test accounts ${prefs.includeTest ? 'included' : 'excluded'} · weeks in ${prefs.tz}`} actions={<nav aria-label="Slice by" className="ak-row" style={{ flexWrap: 'wrap', gap: 6 }}>{FUNNEL_SLICES.map((b) => <FilterChip key={b} on={b === by} href={`/funnel?by=${b}&days=${days}`}>{b}</FilterChip>)}</nav>}>
      <Table head={['Slice', ...STAGES.map((s) => s.replace(/_/g, ' ').toLowerCase()), 'LP→Taste']} rows={names.map((n) => [n, ...STAGES.map((s) => get(n, s)), pct(get(n, 'LP_VIEWED') ? get(n, 'TASTE_PAID') / get(n, 'LP_VIEWED') : NaN)])} empty="No funnel events yet." />
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Drop-off: upload"><Table head={['Reason', 'Count']} rows={[['Started but never completed', d0.abandoned], ...d0.failures.map((f) => [f.reason as string, f.n as number])]} /></Section>
        <Section title="Taste → subscription cohorts"><Table head={['Week', 'Taste buyers', 'Subscribed after', 'Rate']} rows={d0.cohort.map((c) => [c.week as string, c.taste as number, c.subscribed as number, pct(Number(c.subscribed) / Number(c.taste))])} /></Section>
      </div>
      <p className="ak-small ak-muted">CAC: import ad spend CSV per campaign under Ledger & COGS → provider invoices; session replay is not built (PostHog, privacy mode, marketing pages only).</p>
    </Page>
  );
}
