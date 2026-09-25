import { withAdmin } from '@arkiv/db';
import { adSpendByAd, cacByCampaign, FUNNEL_SLICES, funnelBySlice, monthTwoPlus, planMix, stageLatency, staffCan, tasteCohorts, uploadDropoff, type CohortBy, type FunnelSlice } from '@arkiv/core';
import { ActForm } from '@/components/act';
import { d, FilterChip, money, Mono, Page, pct, Section, Table } from '@/components/ui';
import { consolePrefs, daysFrom } from '@/lib/prefs';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Funnel' };

// Standard §7 funnel stages, in order.
const STAGES = [
  'LP_VIEWED', 'UPLOAD_STARTED', 'UPLOAD_COMPLETED', 'SKU_VALIDATED', 'CONCEPTS_READY', 'ACCOUNT_CLAIMED', 'STORYBOARD_READY', 'CHECKOUT_STARTED',
  'TASTE_PAID', 'TASTE_DELIVERED', 'ASSET_WATCHED', 'ASSET_EXPORTED', 'AD_ACCOUNT_CONNECTED', 'SUBSCRIPTION_STARTED',
];
const secs = (ms: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);
const COHORTS: [CohortBy, string][] = [['week', 'by week'], ['page', 'by landing page'], ['concept', 'by concept type chosen']];
const SLICE_LABEL: Partial<Record<FunnelSlice, string>> = { ad_id: 'ad creative', returning: 'new vs returning', offer: 'offer variant', in_app: 'in-app browser' };

/**
 * Plan 05 §4: server-side funnel events are the source of truth (ad blockers can't hide them). Funnel by stage and
 * slice, stage timing against the plan 04 §1 targets, upload drop-off by reason, Taste → subscription cohorts (S10:
 * within 14 days), plan mix, Month 2+ (standard §7), and CAC from imported ad spend (Appendix C).
 */
export default async function Funnel({ searchParams }: { searchParams: Promise<{ by?: string; days?: string; cohort?: string }> }) {
  const s = await requireStaff('analytics.read');
  const sp = await searchParams;
  const prefs = await consolePrefs();
  const by: FunnelSlice = (FUNNEL_SLICES as readonly string[]).includes(sp.by ?? '') ? (sp.by as FunnelSlice) : 'page';
  const cohortBy: CohortBy = COHORTS.some(([k]) => k === sp.cohort) ? (sp.cohort as CohortBy) : 'week';
  const days = daysFrom(sp.days, prefs);
  const d0 = await withAdmin(async (tx) => ({
    // Attribute every event of a visitor to the slice of their first landing view.
    slices: await funnelBySlice(tx, { by, days, includeTest: prefs.includeTest }),
    dropoff: await uploadDropoff(tx, { days, includeTest: prefs.includeTest }),
    cohort: await tasteCohorts(tx, { by: cohortBy, days: Math.max(days, 120), tz: prefs.tz, includeTest: prefs.includeTest }),
    cac: await cacByCampaign(tx, { days, includeTest: prefs.includeTest }),
    byAd: await adSpendByAd(tx, { days, limit: 30 }),
    latency: await stageLatency(tx, { days, includeTest: prefs.includeTest }),
    plans: await planMix(tx, { includeTest: prefs.includeTest }),
    month2: await monthTwoPlus(tx, { includeTest: prefs.includeTest }),
    imports: await tx`select import_batch, min(date) as from_date, max(date) as to_date, count(*)::int as n, sum(spend_micros)::bigint as micros, max(created_at) as at
                      from ad_spend group by import_batch order by max(created_at) desc limit 5`,
  }));
  const names = [...new Set(d0.slices.map((x) => x.slice))];
  const get = (slice: string, t: string) => d0.slices.find((x) => x.slice === slice && x.type === t)?.n ?? 0;
  const q = (p: Record<string, string>) => `/funnel?${new URLSearchParams({ by, days: String(days), cohort: cohortBy, ...p })}`;
  const cacRow = (r: typeof d0.cac.total) => [
    r.campaign === '' ? '(no campaign)' : r.campaign, money(r.spendMicros, 0), r.tasteBuyers, r.subscribers,
    r.mediaCacPerTaste != null ? money(r.mediaCacPerTaste) : '—', money(r.previewCogsMicros), money(r.tasteContributionMicros), r.effectiveSubscriberCac != null ? money(r.effectiveSubscriberCac) : '—',
    r.paybackMonths != null ? `${r.paybackMonths} mo` : '—',
  ];
  const optMoney = (m: number | null, dp?: number) => (m == null ? '—' : money(m, dp));
  const acqRow = (r: typeof d0.cac.total) => [
    r.campaign === '' ? '(no campaign)' : r.campaign, r.impressions ? r.impressions.toLocaleString('en-US') : '—', optMoney(r.cpmMicros), r.clicks ? r.clicks.toLocaleString('en-US') : '—',
    r.ctr == null ? '—' : pct(r.ctr), optMoney(r.cpcMicros), r.landingViews, r.lpvPerClick == null ? '—' : pct(r.lpvPerClick),
  ];
  return (
    <Page
      title="Acquisition & funnel"
      sub={`Last ${days} days · unique visitors per stage, attributed to first landing view · test accounts ${prefs.includeTest ? 'included' : 'excluded'} · weeks in ${prefs.tz}`}
      actions={<nav aria-label="Slice by" className="ak-row" style={{ flexWrap: 'wrap', gap: 6 }}>{FUNNEL_SLICES.map((b) => <FilterChip key={b} on={b === by} href={q({ by: b })}>{SLICE_LABEL[b] ?? b.replace('_', ' ')}</FilterChip>)}</nav>}
    >
      <Table head={['Slice', ...STAGES.map((x) => x.replace(/_/g, ' ').toLowerCase()), 'LP→Taste']} rows={names.map((n) => [n, ...STAGES.map((x) => get(n, x)), pct(get(n, 'LP_VIEWED') ? get(n, 'TASTE_PAID') / get(n, 'LP_VIEWED') : NaN)])} empty="No funnel events yet." />
      {by === 'offer' ? <p className="ak-small ak-muted">Offer is set when the storyboard is priced, so earlier stages fall under “(no offer yet)”.</p> : null}
      <Section title="Stage timing (plan 04 §1 targets)">
        <Table
          head={['Stage', 'Target', 'p50', 'p90', 'Within target', 'Workspaces']}
          rows={d0.latency.map((l) => [l.label, `≤ ${secs(l.targetMs)}`, secs(l.p50Ms), secs(l.p90Ms), l.withinTarget == null ? '—' : pct(l.withinTarget), l.n])}
          empty="No timings yet."
        />
      </Section>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Drop-off: upload → concepts">
          <Table head={['Reason', 'Visitors / workspaces']} rows={d0.dropoff.map((f) => [f.reason.replace(/_/g, ' '), f.n])} empty="No drop-off recorded." />
        </Section>
        <Section title="Taste → subscription cohorts" right={<span className="ak-row" style={{ gap: 6 }}>{COHORTS.map(([k, label]) => <FilterChip key={k} on={k === cohortBy} href={q({ cohort: k })}>{label}</FilterChip>)}</span>}>
          <Table
            head={[cohortBy === 'week' ? 'Week' : cohortBy === 'page' ? 'Landing page' : 'Concept type', 'Taste buyers', 'Subscribed ≤ 14 days (S10)', 'Rate ≤ 14 days', 'Subscribed ever']}
            rows={d0.cohort.map((c) => [c.cohort, c.taste, c.subscribedWithin14d, pct(c.subscribedWithin14d / c.taste), c.subscribed])}
            empty="No Taste buyers yet."
          />
        </Section>
      </div>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Plan mix (live subscriptions)">
          <Table head={['Plan', 'Subscribers', 'Share']} rows={d0.plans.map((p) => [p.plan, p.subscribers, pct(p.share)])} empty="No subscribers yet." />
        </Section>
        <Section title="Month 2+ (retention and workflow)">
          <Table
            head={['Measure', 'Value']}
            rows={[
              ['Subscribers past month one', d0.month2.subscribersPastMonthOne],
              ['Still subscribed', d0.month2.retention == null ? '—' : `${d0.month2.retained} (${pct(d0.month2.retention)})`],
              ['Tests per retained subscriber, last 30 days', d0.month2.experimentsPerSubscriberMonth == null ? '—' : d0.month2.experimentsPerSubscriberMonth.toFixed(1)],
              ['Tests with performance linked (last 90 days)', d0.month2.performanceLinkedShare == null ? '—' : `${pct(d0.month2.performanceLinkedShare)} of ${d0.month2.experiments90d}`],
            ]}
          />
        </Section>
      </div>
      <Section title="CAC by campaign (Appendix C)">
        <Table
          head={['Campaign (utm_campaign)', 'Ad spend', 'Taste buyers', 'New subscribers', 'Media CAC / Taste', 'Free-preview COGS', 'Taste contribution', 'Effective subscriber CAC', 'Payback']}
          rows={[...d0.cac.rows.map(cacRow), ...(d0.cac.rows.length > 1 ? [cacRow(d0.cac.total).map((c, i) => (i === 0 ? <strong key="t">all campaigns</strong> : c))] : [])]}
          empty="No ad spend or attributed buyers in this window. Import ad spend below."
        />
        <p className="ak-small ak-muted">Payback = effective subscriber CAC ÷ a new subscriber’s monthly contribution (plan price − payment fee − their last 30 days of provider cost). Effective subscriber CAC = (paid media + free-preview COGS − Taste contribution) ÷ new subscribers, floored at zero. Spend matches visitors by their first landing view’s utm_campaign; payment fees use the finance.payment_fee_* settings.</p>
      </Section>
      <Section title="Impressions → clicks → landing views (standard §7)">
        <Table
          head={['Campaign', 'Impressions', 'CPM', 'Clicks', 'CTR', 'CPC', 'Landing views', 'LPV / click']}
          rows={[...d0.cac.rows.map(acqRow), ...(d0.cac.rows.length > 1 ? [acqRow(d0.cac.total).map((c, i) => (i === 0 ? <strong key="t">all campaigns</strong> : c))] : [])]}
          empty="No ad spend in this window."
        />
        <p className="ak-small ak-muted">Impressions and clicks come from the imported Ads Manager export (columns impressions, clicks); CPM and CPC use only the spend on rows that reported them. Landing views are unique visitors whose landing view carried the campaign’s utm_campaign.</p>
      </Section>
      <Section title="By ad (creative ID)">
        <Table
          head={['Source', 'Campaign', 'Ad id', 'Spend', 'Impressions', 'CPM', 'Clicks', 'CTR', 'CPC']}
          rows={d0.byAd.map((a) => [a.source, a.campaign || '—', <Mono key="a">{a.adId}</Mono>, money(a.spendMicros, 0), a.impressions ?? '—', optMoney(a.cpmMicros), a.clicks ?? '—', a.ctr == null ? '—' : pct(a.ctr), optMoney(a.cpcMicros)])}
          empty="No imported rows carry an ad id in this window."
        />
      </Section>
      <Section title="Ad spend imports">
        {staffCan(s.roles, 'adspend.manage') ? (
          <div className="ak-panel" style={{ maxWidth: 720 }}>
            <p className="ak-small ak-muted" style={{ marginTop: 0 }}>Paste a CSV exported from Ads Manager: a header with date (YYYY-MM-DD), campaign and spend (USD), plus source, ad_id, impressions and clicks when you have them. Re-importing a day replaces it.</p>
            <ActForm action="adspend.import" submit="Import ad spend" fields={[
              { name: 'source', label: 'Source for rows without one (e.g. meta, tiktok)', placeholder: 'meta' },
              { name: 'csv', label: 'CSV', type: 'textarea', required: true, placeholder: 'date,campaign,ad_id,spend,impressions,clicks\n2026-09-20,texture-launch,120201,84.20,21000,310' },
              { name: 'reason', label: 'Note (optional)' },
            ]} />
          </div>
        ) : null}
        <Table head={['Imported', 'Rows', 'Dates', 'Total', 'Batch']} rows={d0.imports.map((b) => [d(b.at), b.n as number, `${d(b.from_date)} → ${d(b.to_date)}`, money(b.micros, 0), <Mono key="b">{String(b.import_batch).slice(0, 8)}</Mono>])} empty="No ad spend imported yet." />
      </Section>
      <p className="ak-small ak-muted">Session replay is not built (PostHog, privacy mode, marketing pages only).</p>
    </Page>
  );
}
