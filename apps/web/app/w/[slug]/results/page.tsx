import type { Metadata } from 'next';
import Link from 'next/link';
import { withTenant } from '@arkiv/db';
import { measurementContextLabel } from '@arkiv/shared';
import { Empty, SignalChip } from '@arkiv/ui';
import { ActionForm, SheetButton } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Results · Arkiv' };

/** A6: experiments with their signal state, plus learnings — scoped claims, never global truths. */
export default async function Results({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => ({
    exps: await tx`select e.id, e.hypothesis, e.state, e.mode, e.created_at, s.name, s.catalogue_no from experiments e join skus s on s.id = e.sku_id order by e.created_at desc limit 100`,
    learnings: await tx`select l.statement, l.state, l.scope_platform, l.measurement_context, l.confidence, l.confounded, s.name from learnings l join skus s on s.id = l.sku_id order by l.last_revalidated_at desc limit 30`,
    skus: await tx`select id, name from skus where status = 'active' order by catalogue_no`,
  }));
  const canEdit = ['OWNER', 'ADMIN', 'MEMBER'].includes(w.ctx.role);
  return (
    <>
      <div className="ak-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h1 className="ak-h1" style={{ margin: 0 }}>Results</h1>
        {canEdit ? (
          <div className="ak-row">
            <SheetButton label="Mark a confounder" title="Mark a confounder" description="Something outside the ads that could skew results — we’ll exclude or flag the affected days.">
              <ActionForm slug={slug} action="confounder" submit="Save" fields={[
                { name: 'skuId', label: 'Product', type: 'select', options: [{ value: '', label: 'All products' }, ...d.skus.map((s) => ({ value: s.id as string, label: s.name as string }))] },
                { name: 'kind', label: 'What happened', type: 'select', options: [['stockout', 'Stockout'], ['site_outage', 'Site outage'], ['price_change', 'Price change'], ['offer_change', 'Promotion / offer change'], ['influencer_event', 'Influencer spike'], ['viral_event', 'Viral moment'], ['landing_change', 'Landing page change'], ['other', 'Other']].map(([value, label]) => ({ value: value!, label: label! })) },
                { name: 'startsAt', label: 'From', type: 'date', required: true },
                { name: 'endsAt', label: 'To (optional)', type: 'date' },
                { name: 'note', label: 'Note', max: 300 },
              ]} />
            </SheetButton>
            <SheetButton label="Upload CSV" title="Upload performance CSV" description="No ad account connection? Export a daily ad report (Ad name, Day, Spend, Impressions, Clicks, Purchases) and upload it here — one file per platform, so Meta and TikTok results stay separate.">
              <ActionForm slug={slug} action="performance-csv" multipart submit="Upload" fields={[
                { name: 'platform', label: 'Exported from', type: 'select', required: true, options: [{ value: '', label: 'Choose…' }, { value: 'meta', label: 'Meta Ads Manager' }, { value: 'tiktok', label: 'TikTok Ads Manager' }] },
                { name: 'file', label: 'CSV file', type: 'file', accept: '.csv,text/csv', required: true },
              ]} />
            </SheetButton>
          </div>
        ) : null}
      </div>
      {d.exps.length === 0 ? (
        <Empty title="No tests yet" body="Approve a recommendation on This Week to start your first Creative Test." />
      ) : (
        <div style={{ marginTop: 24 }}>
          {d.exps.map((e) => (
            <Link key={e.id as string} href={`/w/${slug}/results/${e.id}`} className="ak-index-row">
              <span>
                <span className="ak-index">No. {String(e.catalogue_no).padStart(3, '0')} · {e.name as string}</span>
                <span style={{ display: 'block' }}>{e.hypothesis as string}</span>
              </span>
              <SignalChip state={String(e.state)} />
            </Link>
          ))}
        </div>
      )}
      <section className="ak-section">
        <h2 className="ak-label">What your tests have taught you</h2>
        {d.learnings.length === 0 ? (
          <p className="ak-small ak-muted">Learnings appear once a test reaches a directional or actionable signal. Each one is scoped to the platform and measurement it came from.</p>
        ) : (
          d.learnings.map((l, i) => (
            <div key={i} className="ak-index-row">
              <span>{l.statement as string}<span className="ak-small ak-muted" style={{ display: 'block' }}>{l.name as string} · {l.scope_platform as string} · {measurementContextLabel(String(l.measurement_context))}{l.confounded ? ' · confounded period — not used for recommendations' : ''}</span></span>
              <SignalChip state={String(l.state)} />
            </div>
          ))
        )}
      </section>
    </>
  );
}
