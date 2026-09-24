import type { Metadata } from 'next';
import Link from 'next/link';
import { withTenant } from '@arkiv/db';
import { measurementContextLabel } from '@arkiv/shared';
import { Empty, SignalChip } from '@arkiv/ui';
import { ActionButton, ActionForm, SheetButton } from '@/components/actions';
import { ConnectAdsCard } from '@/components/connect-ads-card';
import { workspacePage } from '@/lib/tenant';
import { formatDate } from '@arkiv/shared/format';

export const metadata: Metadata = { title: 'Results' };

/** A6: experiments with their signal state, plus learnings — scoped claims, never global truths. */
export default async function Results({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => ({
    exps: await tx`select e.id, e.hypothesis, e.state, e.mode, e.created_at, s.name, s.catalogue_no from experiments e join skus s on s.id = e.sku_id order by e.created_at desc limit 100`,
    learnings: await tx`select l.statement, l.state, l.scope_platform, l.measurement_context, l.confidence, l.confounded, s.name from learnings l join skus s on s.id = l.sku_id order by l.last_revalidated_at desc limit 30`,
    skus: await tx`select id, name from skus where status = 'active' order by catalogue_no`,
    adAccounts: (await tx`select count(*)::int as n from integrations where provider in ('meta','tiktok') and status <> 'disconnected'`)[0]!.n as number,
    tz: (await tx`select timezone from workspaces where id = ${w.ctx.workspaceId}`)[0]?.timezone as string | undefined,
    // Operational signals of the last 60 days (§45): merchant-marked and automatic, with their source.
    signals: await tx`select c.id, c.kind, c.source, c.status, c.starts_at, c.ends_at, c.note, s.name from confounders c left join skus s on s.id = c.sku_id
                      where c.status <> 'dismissed' and coalesce(c.ends_at, now()) > now() - interval '60 days' order by c.starts_at desc limit 20`,
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
                { name: 'timezone', label: 'Ad account timezone', defaultValue: d.tz ?? '', placeholder: 'e.g. America/New_York', max: 64, hint: 'The timezone your ad account reports days in, so each day lines up with stock-outs and price changes.' },
              ]} />
            </SheetButton>
          </div>
        ) : null}
      </div>
      {d.adAccounts === 0 ? <div style={{ marginTop: 24 }}><ConnectAdsCard slug={slug} userKey={w.user?.id ?? w.ctx.actor.id} /></div> : null}
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
      {d.signals.length ? (
        <section className="ak-section">
          <h2 className="ak-label">Things that affect results</h2>
          {d.signals.map((c) => (
            <div key={c.id as string} className="ak-index-row">
              <span>
                {String(c.kind).replace(/_/g, ' ')}{c.name ? ` · ${c.name as string}` : ' · all products'}{c.note ? ` — ${c.note as string}` : ''}
                <span className="ak-small ak-muted" style={{ display: 'block' }}>
                  {formatDate(c.starts_at as string)}{c.ends_at ? ` – ${formatDate(c.ends_at as string)}` : ' – ongoing'}
                  {' · '}{c.source === 'automatic' ? 'detected automatically' : c.source === 'staff' ? 'marked by Arkiv' : 'marked by your team'}
                  {c.status === 'pending_confirmation' ? ' · waiting for your confirmation' : ''}
                </span>
              </span>
              {canEdit ? (
                <span className="ak-row">
                  {c.status === 'pending_confirmation' ? <ActionButton slug={slug} action="confounder-decide" body={{ id: c.id, decision: 'confirm' }} variant="text">It happened</ActionButton> : null}
                  <ActionButton slug={slug} action="confounder-decide" body={{ id: c.id, decision: 'dismiss' }} variant="text" confirm="Dismiss this? The affected tests are read again without it.">Dismiss</ActionButton>
                </span>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
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
