import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { env } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { dt, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Landing page' };

/**
 * Editor + variant results. A/B/n winners are never called on tiny samples: we show counts and a
 * directional badge only past a minimum sample (same discipline as the product, standard §21).
 */
export default async function LandingPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireStaff('growth.manage');
  const { slug } = await params;
  const d0 = await withAdmin(async (tx) => {
    const [p] = await tx`select * from landing_pages where slug = ${slug}`;
    if (!p) return null;
    const variants = await tx`
      with views as (select distinct coalesce(variant, 'control') as variant, visitor_id from funnel_events where type = 'LP_VIEWED' and page = ${slug}),
           ups as (select distinct visitor_id from funnel_events where type = 'UPLOAD_STARTED')
      select v.variant, count(distinct v.visitor_id)::int as views, count(distinct u.visitor_id)::int as uploads
      from views v left join ups u on u.visitor_id = v.visitor_id group by v.variant order by v.variant`;
    return { p, variants };
  });
  if (!d0) notFound();
  const { p } = d0;
  const MIN = 400;
  return (
    <Page title={`/${p.slug === 'default' ? '' : `for/${p.slug}`}`} sub={`${p.archetype} · ${p.status} · v${p.version}`} actions={
      <>
        <a className="ak-btn ak-btn--secondary" href={`${env().APP_URL}${p.slug === 'default' ? '/' : `/for/${p.slug}`}`} target="_blank" rel="noreferrer">Preview</a>
        {p.status !== 'live' ? <ActButton action="lp.status" payload={{ slug, status: 'live' }} confirm="Publish? Compliance lint ran on save.">Publish</ActButton> : <ActButton action="lp.status" payload={{ slug, status: 'paused' }}>Pause</ActButton>}
      </>
    }>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <div className="ak-panel">
          <ActForm action="lp.save" submit="Save (versioned)" extra={{ slug, archetype: p.archetype }} fields={[
            { name: 'content', label: 'Content', type: 'json', defaultValue: JSON.stringify(p.content, null, 2), required: true },
            { name: 'variants', label: 'Variants [{ key, weight, content }]', type: 'json', defaultValue: JSON.stringify(p.variants, null, 2) },
            { name: 'utmMatch', label: 'UTM content prefixes', defaultValue: ((p.utm_match as string[]) ?? []).join(', ') },
          ]} />
        </div>
        <div>
          <Section title="Variant results (upload-start %)">
            <Table head={['Variant', 'Views', 'Upload starts', 'Rate', 'Signal']} rows={d0.variants.map((v) => [v.variant as string, v.views as number, v.uploads as number, pct(Number(v.views) ? Number(v.uploads) / Number(v.views) : NaN), Number(v.views) < MIN ? `gathering (${v.views}/${MIN})` : 'enough sample'])} empty="No traffic yet." />
          </Section>
          <Section title="History (rollback)">
            <Table head={['Version', 'Saved', 'By', '']} rows={((p.history as { version: number; at: string; by?: string }[]) ?? []).slice().reverse().map((h) => [`v${h.version}`, dt(h.at), h.by ?? '—', <ActButton key="r" small action="lp.rollback" payload={{ slug, version: h.version }} confirm={`Roll back to v${h.version}?`}>Roll back</ActButton>])} empty="No previous versions." />
          </Section>
        </div>
      </div>
    </Page>
  );
}
