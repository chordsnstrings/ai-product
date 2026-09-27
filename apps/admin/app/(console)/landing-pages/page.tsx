import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { landingStats, landingTotals } from '@arkiv/core';
import { DEFAULT_LANDING_BLOCKS, landingBlocksFrom } from '@arkiv/shared';
import { ActForm } from '@/components/act';
import { d, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Landing pages' };

const METRIC = { upload_start: 'upload-start %', taste_cvr: 'Taste CVR' } as const;

/**
 * Plan 05 §5 list: slug, headline, archetype, status, traffic 7d, upload-start %, Taste CVR. Rates are first-touch:
 * a visitor counts for the first page they landed on.
 */
export default async function LandingPages() {
  await requireStaff('growth.manage');
  const { rows, stats } = await withAdmin(async (tx) => ({
    rows: await tx`select slug, archetype, status, version, live_version, utm_match, published_at, content, live_content, experiment, jsonb_array_length(variants) as variants,
                          (select count(*) from platform_alerts a where a.subject_type = 'landing_page' and a.subject_id = p.slug and a.resolved_at is null)::int as alerts
                   from landing_pages p order by slug`,
    stats: landingTotals(await landingStats(tx, { days: 7 })),
  }));
  return (
    <Page title="Landing pages" sub="Structured blocks only. Publishing runs the compliance lint and checks examples and testimonial consent. Paused pages redirect to the default page, keeping UTMs. Rates: first touch, last 7 days.">
      <Table head={['Slug', 'Headline', 'Archetype', 'Status', 'Draft / live', 'Variants', 'Primary metric', 'UTM routing', '7d traffic', 'Upload-start %', 'Taste CVR', 'Published']} rows={rows.map((r) => {
        const s = stats.get(r.slug as string);
        const exp = (r.experiment as { primaryMetric?: keyof typeof METRIC; minSample?: number }) ?? {};
        const unpublished = r.live_version == null || Number(r.live_version) !== Number(r.version);
        return [
          <Link key="s" href={`/landing-pages/${r.slug}`}>{r.slug as string}</Link>,
          landingBlocksFrom(r.live_content ?? r.content).hero.headline,
          String(r.archetype).replace(/_/g, ' '),
          <span key="st">{r.status as string}{Number(r.alerts) ? <span className="ak-chip ak-chip--risk" style={{ marginLeft: 6 }}>alert</span> : null}</span>,
          `v${r.version}${r.live_version != null ? ` / v${r.live_version}` : ' / —'}${unpublished && r.status === 'live' ? ' · unpublished changes' : ''}`,
          r.variants as number,
          `${METRIC[exp.primaryMetric ?? 'upload_start']} · n≥${exp.minSample ?? 400}`,
          ((r.utm_match as string[]) ?? []).join(', ') || '—',
          s?.views ?? 0,
          pct(s?.visitors ? s.uploads / s.visitors : NaN),
          pct(s?.visitors ? s.taste / s.visitors : NaN, 2),
          d(r.published_at),
        ];
      })} />
      <Section title="New page">
        <div className="ak-panel" style={{ maxWidth: 640 }}>
          <p className="ak-small ak-muted">Starts as a draft with the standard blocks; edit and preview it, then publish.</p>
          <ActForm action="lp.save" submit="Create draft" extra={{ variants: [], content: DEFAULT_LANDING_BLOCKS }} fields={[
            { name: 'slug', label: 'Slug', required: true, placeholder: 'e.g. serum-launch' },
            { name: 'archetype', label: 'Archetype', type: 'select', options: ['texture_demo', 'serum_launch', 'ugc', 'creative_fatigue', 'founder', 'general'] },
            { name: 'utmMatch', label: 'UTM content prefixes (comma separated)' },
            { name: 'primaryMetric', label: 'Primary metric (pre-registered)', type: 'select', options: [{ value: 'upload_start', label: 'Upload-start %' }, { value: 'taste_cvr', label: 'Taste CVR' }] },
            { name: 'minSample', label: 'Minimum sample per variant', type: 'number', defaultValue: 400 },
          ]} />
        </div>
      </Section>
    </Page>
  );
}
