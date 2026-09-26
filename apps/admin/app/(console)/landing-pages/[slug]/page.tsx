import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { diffLanding, EXAMPLE_ASSET_KINDS, landingPreviewToken, landingStats, landingVerdict, SKINCARE_CATEGORIES } from '@arkiv/core';
import { DEFAULT_LANDING_EXPERIMENT, env, landingBlocksFrom, landingVariantFrom, type LandingExperiment } from '@arkiv/shared';
import { ActButton } from '@/components/act';
import { LandingEditor } from '@/components/landing-editor';
import { dt, FilterChip, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Landing page' };

type StoredVariant = { key: string; weight: number; content: unknown };
const normVariants = (v: unknown) => ((v as StoredVariant[]) ?? []).map((x) => ({ key: x.key, weight: Number(x.weight), content: landingVariantFrom(x.content) }));
const METRIC = { upload_start: 'Upload-start %', taste_cvr: 'Taste CVR' } as const;

/**
 * Plan 05 §5 editor: block editor for the draft, phone and desktop previews of the draft (signed), the diff against
 * what's live before publishing, one-click rollback, and variant results judged on the pre-registered metric only
 * (shrunk estimates, a winner badge only past the minimum sample).
 */
export default async function LandingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ pv?: string }> }) {
  await requireStaff('growth.manage');
  const { slug } = await params;
  const { pv } = await searchParams;
  const d0 = await withAdmin(async (tx) => {
    const [p] = await tx`select * from landing_pages where slug = ${slug}`;
    if (!p) return null;
    return {
      p,
      stats: await landingStats(tx, { days: 90, slug }),
      testimonials: await tx`select id, quote, person_name, brand_name from testimonials where revoked_at is null order by created_at desc`,
      // Eligible examples: our own demo (test) workspaces, skincare SKUs, visual kinds, live rights.
      examples: await tx`select a.id, a.kind, s.name as sku, w.name as ws from assets a join workspaces w on w.id = a.workspace_id and w.is_test
                         join skus s on s.id = a.sku_id and s.workspace_id = a.workspace_id
                         where a.deleted_at is null and a.kind in ${tx([...EXAMPLE_ASSET_KINDS])} and s.category in ${tx([...SKINCARE_CATEGORIES])} and s.status <> 'rejected'
                           and (a.rights_expires_at is null or a.rights_expires_at > now()) and (a.source not in ('upload', 'import') or a.rights_attested_at is not null)
                           and (a.mime like 'image/%' or a.mime like 'video/%')
                         order by a.created_at desc limit 100`,
      alerts: await tx`select id, message, created_at from platform_alerts where subject_type = 'landing_page' and subject_id = ${slug} and resolved_at is null order by created_at desc`,
    };
  });
  if (!d0) notFound();
  const { p } = d0;
  const draft = { content: landingBlocksFrom(p.content), variants: normVariants(p.variants) };
  const live = p.live_content ? { content: landingBlocksFrom(p.live_content), variants: normVariants(p.live_variants) } : null;
  const changes = diffLanding(live, draft);
  const experiment = { ...DEFAULT_LANDING_EXPERIMENT, ...((p.experiment as Partial<LandingExperiment>) ?? {}) } as LandingExperiment;
  const locked = p.status === 'live' && (live?.variants.length ?? 0) > 0;
  // Judged over the variants that are live now (without variants, every visitor sees the page itself: "control").
  const liveKeys = live?.variants.length ? live.variants.map((v) => v.key) : ['control'];
  const verdict = landingVerdict(d0.stats.filter((s) => liveKeys.includes(s.variant)), experiment);
  const statFor = (v: string) => d0.stats.find((s) => s.variant === v);
  const token = landingPreviewToken(slug);
  const previewVariant = draft.variants.some((v) => v.key === pv) ? pv! : null;
  const src = `${env().APP_URL}/for/${slug}?preview=${encodeURIComponent(token)}${previewVariant ? `&variant=${encodeURIComponent(previewVariant)}` : ''}`;
  const publicUrl = `${env().APP_URL}${slug === 'default' ? '/' : `/for/${slug}`}`;
  const history = ((p.history as { version: number; at: string; by?: string; published?: boolean; note?: string }[]) ?? []).slice().reverse();
  return (
    <Page
      title={slug === 'default' ? '/ (default page)' : `/for/${slug}`}
      sub={`${String(p.archetype).replace(/_/g, ' ')} · ${p.status} · draft v${p.version} · live ${p.live_version != null ? `v${p.live_version}` : '—'}`}
      actions={
        <>
          {p.status === 'live' ? <a className="ak-btn ak-btn--secondary" href={publicUrl} target="_blank" rel="noreferrer">Open live page</a> : null}
          <ActButton action="lp.publish" payload={{ slug }} confirm={changes.length ? `Publish draft v${p.version}? ${changes.length} change${changes.length === 1 ? '' : 's'} go live after the compliance lint, example and testimonial checks.` : 'Publish the draft as it is?'}>
            {p.status === 'live' ? `Publish v${p.version}` : 'Publish'}
          </ActButton>
          {p.status === 'live' && slug !== 'default' ? <ActButton action="lp.status" payload={{ slug, status: 'paused' }} confirm="Pause? Visitors are redirected to the default page with their UTMs.">Pause</ActButton> : null}
        </>
      }
    >
      {d0.alerts.length ? (
        <Section title="Alerts">
          <Table head={['When', 'What', '']} rows={d0.alerts.map((a) => [dt(a.created_at), a.message as string, <ActButton key="r" small action="alert.resolve" payload={{ id: a.id }} reason="What did you do about it?">Resolve</ActButton>])} />
        </Section>
      ) : null}
      <Section title={live ? `Changes since live v${p.live_version} (${changes.length})` : `Not published yet (${changes.length} fields)`}>
        <Table head={['Field', 'Live', 'Draft']} rows={changes.slice(0, 80).map((c) => [<Mono key="p">{c.path}</Mono>, <span key="b" className="ak-small" style={{ textDecoration: c.after === null ? 'line-through' : undefined }}>{c.before ?? '—'}</span>, <span key="a" className="ak-small"><strong>{c.after ?? '(removed)'}</strong></span>])} empty="The draft matches what's live." />
        {changes.length > 80 ? <p className="ak-small ak-muted">…and {changes.length - 80} more.</p> : null}
      </Section>
      <div className="ak-grid-2" style={{ alignItems: 'start', marginTop: 12 }}>
        <div>
          <Section title="Draft blocks">
            <LandingEditor
              slug={slug}
              archetype={p.archetype as string}
              content={draft.content}
              variants={draft.variants}
              utmMatch={(p.utm_match as string[]) ?? []}
              experiment={experiment}
              experimentLocked={locked}
              testimonials={d0.testimonials.map((t) => ({ id: t.id as string, label: `“${String(t.quote).slice(0, 60)}” — ${t.person_name as string}${t.brand_name ? `, ${t.brand_name as string}` : ''}` }))}
              examples={d0.examples.map((a) => ({ id: a.id as string, label: `${a.sku as string} · ${String(a.kind).replace(/_/g, ' ')} · ${String(a.id).slice(0, 8)} (${a.ws as string})` }))}
            />
          </Section>
        </div>
        <div>
          <Section title="Preview (draft)" right={<nav aria-label="Preview variant" className="ak-row" style={{ gap: 6 }}><FilterChip href={`/landing-pages/${slug}`} on={!previewVariant}>control</FilterChip>{draft.variants.map((v) => <FilterChip key={v.key} href={`/landing-pages/${slug}?pv=${encodeURIComponent(v.key)}`} on={previewVariant === v.key}>{v.key}</FilterChip>)}</nav>}>
            <p className="ak-small ak-muted">Shows the saved draft. Previews are not counted as visits.</p>
            <div className="ak-row" style={{ alignItems: 'start', gap: 16, flexWrap: 'wrap' }}>
              <figure style={{ margin: 0 }}>
                <div style={{ width: 195, height: 422, overflow: 'hidden', border: '1px solid var(--rule)', borderRadius: 16 }}>
                  <iframe title="Phone preview" src={src} sandbox="allow-scripts allow-same-origin" style={{ width: 390, height: 844, border: 0, transform: 'scale(0.5)', transformOrigin: '0 0' }} />
                </div>
                <figcaption className="ak-small ak-muted">Phone 390×844</figcaption>
              </figure>
              <figure style={{ margin: 0 }}>
                <div style={{ width: 448, height: 280, overflow: 'hidden', border: '1px solid var(--rule)' }}>
                  <iframe title="Desktop preview" src={src} sandbox="allow-scripts allow-same-origin" style={{ width: 1280, height: 800, border: 0, transform: 'scale(0.35)', transformOrigin: '0 0' }} />
                </div>
                <figcaption className="ak-small ak-muted">Desktop 1280×800</figcaption>
              </figure>
            </div>
          </Section>
          <Section title={`Variant results — ${METRIC[experiment.primaryMetric]} (pre-registered, n ≥ ${experiment.minSample})`}>
            <Table head={['Variant', 'Traffic (90d)', 'First-touch visitors', 'Upload-start %', 'Taste CVR', `Estimate (${METRIC[experiment.primaryMetric]})`, 'P(best)', 'Signal']} rows={verdict.rows.map((r) => {
              const s = statFor(r.variant) ?? { views: 0, visitors: 0, uploads: 0, taste: 0 };
              return [
                r.variant,
                s.views,
                s.visitors,
                pct(s.visitors ? s.uploads / s.visitors : NaN),
                pct(s.visitors ? s.taste / s.visitors : NaN, 2),
                `${pct(r.estimate)} (${pct(r.ciLow)}–${pct(r.ciHigh)})`,
                pct(r.probBest, 0),
                verdict.winner === r.variant ? <span key="w" className="ak-chip ak-chip--ok">Winner</span> : !r.enough ? `gathering (${r.trials}/${experiment.minSample})` : verdict.state === 'no_winner' ? 'no clear winner' : 'waiting for other variants',
              ];
            })} empty="No traffic yet." />
            <p className="ak-small ak-muted">Estimates shrink toward the page average, so small samples can’t produce a winner. The badge needs every variant past the minimum sample and ≥95% probability of being best on the primary metric.</p>
          </Section>
          <Section title="History (one-click rollback)">
            <Table head={['Version', 'Saved', 'By', 'Note', '']} rows={history.map((h) => [
              `v${h.version}${h.published ? ' · was live' : ''}`,
              dt(h.at),
              h.by ?? '—',
              <span key="n" className="ak-small">{h.note ?? ''}</span>,
              <ActButton key="r" small action="lp.rollback" payload={{ slug, version: h.version }} confirm={p.status === 'live' ? `Roll back to v${h.version}? It is checked and published at once.` : `Restore v${h.version} as the draft?`}>Roll back</ActButton>,
            ])} empty="No previous versions." />
          </Section>
          <p className="ak-small"><Link href="/landing-pages">← All landing pages</Link></p>
        </div>
      </div>
    </Page>
  );
}
