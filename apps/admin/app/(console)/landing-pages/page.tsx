import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { ActForm } from '@/components/act';
import { d, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Landing pages' };

export default async function LandingPages() {
  await requireStaff('growth.manage');
  const rows = await withAdmin((tx) => tx`
    select p.slug, p.archetype, p.status, p.version, p.utm_match, p.published_at, p.content->>'headline' as headline, jsonb_array_length(p.variants) as variants,
      (select count(distinct visitor_id) from funnel_events f where f.type = 'LP_VIEWED' and f.page = p.slug and f.at > now() - interval '7 days')::int as views,
      (select count(distinct u.visitor_id) from funnel_events u where u.type = 'UPLOAD_STARTED' and u.at > now() - interval '7 days'
         and u.visitor_id in (select visitor_id from funnel_events v where v.type = 'LP_VIEWED' and v.page = p.slug))::int as uploads
    from landing_pages p order by p.slug`);
  return (
    <Page title="Landing pages" sub="Structured blocks only. Publishing runs a compliance lint (no unsubstantiated results, no fake proof). Paused pages redirect to the default page, keeping UTMs.">
      <Table head={['Slug', 'Headline', 'Archetype', 'Status', 'Version', 'Variants', 'UTM routing', '7d views', 'Upload-start %', 'Published']} rows={rows.map((r) => [
        <Link key="s" href={`/landing-pages/${r.slug}`}>{r.slug as string}</Link>, r.headline as string, r.archetype as string, r.status as string, `v${r.version}`, r.variants as number,
        ((r.utm_match as string[]) ?? []).join(', ') || '—', r.views as number, pct(Number(r.views) ? Number(r.uploads) / Number(r.views) : NaN), d(r.published_at),
      ])} />
      <Section title="New page">
        <div className="ak-panel" style={{ maxWidth: 640 }}>
          <ActForm action="lp.save" submit="Create draft" extra={{ variants: [] }} fields={[
            { name: 'slug', label: 'Slug', required: true, placeholder: 'e.g. serum-launch' },
            { name: 'archetype', label: 'Archetype', type: 'select', options: ['texture_demo', 'serum_launch', 'ugc', 'creative_fatigue', 'founder', 'general'] },
            { name: 'content', label: 'Content (JSON blocks)', type: 'json', required: true, defaultValue: JSON.stringify({ label: 'Skincare · Ad testing', headline: '', sub: '', proof: 'Built only for skincare brands' }, null, 2) },
            { name: 'utmMatch', label: 'UTM content prefixes (comma separated)' },
          ]} />
        </div>
      </Section>
    </Page>
  );
}
