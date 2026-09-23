import { withAdmin } from '@arkiv/db';
import { Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Funnel' };

const STAGES = ['LP_VIEWED', 'UPLOAD_STARTED', 'UPLOAD_COMPLETED', 'CONCEPTS_READY', 'ACCOUNT_CLAIMED', 'STORYBOARD_READY', 'CHECKOUT_STARTED', 'TASTE_PAID', 'ASSET_EXPORTED', 'SUBSCRIPTION_STARTED'];

/** Plan 05 §4: server-side funnel events are the source of truth (ad blockers can't hide them). */
export default async function Funnel({ searchParams }: { searchParams: Promise<{ by?: string; days?: string }> }) {
  await requireStaff('analytics.read');
  const sp = await searchParams;
  const by = (['page', 'variant', 'utm_source', 'utm_campaign', 'utm_content', 'in_app'].includes(sp.by ?? '') ? sp.by : 'page')!;
  const days = Math.min(Math.max(Number(sp.days ?? 30) || 30, 1), 365);
  const d0 = await withAdmin(async (tx) => {
    // Attribute every event of a visitor to the slice of their first landing view.
    const slices = await tx`
      with first_touch as (
        select distinct on (visitor_id) visitor_id,
          case ${by} when 'page' then coalesce(page, '(none)') when 'variant' then coalesce(variant, '(none)')
            when 'in_app' then coalesce(props->>'inApp', 'false') else coalesce(utm->>${by}, '(none)') end as slice
        from funnel_events where type = 'LP_VIEWED' and at > now() - make_interval(days => ${days}) and visitor_id is not null order by visitor_id, at),
      ws_visitor as (select distinct on (workspace_id) workspace_id, visitor_id from funnel_events where visitor_id is not null and workspace_id is not null order by workspace_id, at),
      ev as (
        select f.type, coalesce(f.visitor_id, wv.visitor_id) as vid from funnel_events f left join ws_visitor wv on wv.workspace_id = f.workspace_id
        where f.at > now() - make_interval(days => ${days}) and (f.workspace_id is null or f.workspace_id not in (select id from workspaces where is_test)))
      select coalesce(ft.slice, '(unattributed)') as slice, ev.type, count(distinct ev.vid)::int as n
      from ev left join first_touch ft on ft.visitor_id = ev.vid group by 1, 2`;
    const failures = await tx`select coalesce(props->>'reason', type) as reason, count(*)::int as n from funnel_events where type in ('URL_PARSE_FAILED','SKU_REJECTED') and at > now() - make_interval(days => ${days}) group by 1 order by 2 desc`;
    const abandoned = await tx`select count(distinct visitor_id)::int as n from funnel_events s where s.type = 'UPLOAD_STARTED' and s.at > now() - make_interval(days => ${days})
                                 and not exists (select 1 from funnel_events c where c.type = 'UPLOAD_COMPLETED' and c.visitor_id = s.visitor_id)`;
    const cohort = await tx`select to_char(date_trunc('week', p.paid_at), 'YYYY-MM-DD') as week, count(distinct p.workspace_id)::int as taste,
                                   count(distinct s.workspace_id)::int as subscribed
                            from purchases p left join subscriptions s on s.workspace_id = p.workspace_id and s.created_at > p.paid_at
                            where p.kind = 'taste' and p.status in ('paid','refunded') and p.paid_at > now() - interval '120 days' group by 1 order by 1 desc`;
    return { slices, failures, abandoned: abandoned[0]!.n as number, cohort };
  });
  const names = [...new Set(d0.slices.map((s) => s.slice as string))];
  const get = (slice: string, t: string) => Number(d0.slices.find((s) => s.slice === slice && s.type === t)?.n ?? 0);
  return (
    <Page title="Acquisition & funnel" sub={`Last ${days} days · unique visitors per stage, attributed to first landing view`} actions={['page', 'variant', 'utm_source', 'utm_campaign', 'utm_content', 'in_app'].map((b) => <a key={b} className={`ak-chip${b === by ? ' ak-chip--dec' : ''}`} href={`/funnel?by=${b}&days=${days}`}>{b}</a>)}>
      <Table head={['Slice', ...STAGES.map((s) => s.replace(/_/g, ' ').toLowerCase()), 'LP→Taste']} rows={names.map((n) => [n, ...STAGES.map((s) => get(n, s)), pct(get(n, 'LP_VIEWED') ? get(n, 'TASTE_PAID') / get(n, 'LP_VIEWED') : NaN)])} empty="No funnel events yet." />
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Drop-off: upload"><Table head={['Reason', 'Count']} rows={[['Started but never completed', d0.abandoned], ...d0.failures.map((f) => [f.reason as string, f.n as number])]} /></Section>
        <Section title="Taste → subscription cohorts"><Table head={['Week', 'Taste buyers', 'Subscribed after', 'Rate']} rows={d0.cohort.map((c) => [c.week as string, c.taste as number, c.subscribed as number, pct(Number(c.subscribed) / Number(c.taste))])} /></Section>
      </div>
      <p className="ak-small ak-muted">CAC: import ad spend CSV per campaign under Ledger & COGS → provider invoices; session replay is not built (PostHog, privacy mode, marketing pages only).</p>
    </Page>
  );
}
