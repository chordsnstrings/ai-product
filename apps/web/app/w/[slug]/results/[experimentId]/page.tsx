import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import { experimentView } from '@arkiv/core';
import { MeasurementContextCaveat, measurementContextLabel, type MeasurementContext } from '@arkiv/shared';
import { Banner, SignalChip, VideoThumb } from '@arkiv/ui';
import { ActionButton } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';
import { formatDate } from '@arkiv/shared/format';
import { variantPreviewUrl } from '@/lib/variant-preview';

export const metadata: Metadata = { title: 'Test results · Arkiv' };

const pct = (n: number | null) => (n == null ? '—' : `${(Number(n) * 100).toFixed(2)}%`);

/** Metrics shown only inside their measurement context — Meta paid and TikTok GMV Max are never merged (§30). */
export default async function ResultDetail({ params }: { params: Promise<{ slug: string; experimentId: string }> }) {
  const { slug, experimentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(experimentId)) notFound();
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [e] = await tx`select id from experiments where id = ${experimentId}`;
    if (!e) return null;
    const v = await experimentView(tx, experimentId);
    const conf = await tx`select id, kind, source, status, starts_at, ends_at, note from confounders where (sku_id is null or sku_id = ${v.experiment.sku_id})
                          and status <> 'dismissed' and coalesce(ends_at, now()) > now() - interval '120 days' order by starts_at desc`;
    const revised = await tx`select max(superseded_at) as at from performance_observations where variant_id in ${tx(v.variants.length ? v.variants.map((x) => x.id as string) : ['00000000-0000-0000-0000-000000000000'])}`;
    // The variants being compared, as 9:16 thumbnails (design §2.4).
    const thumbs = (
      await Promise.all(v.variants.map(async (x) => ({ id: x.id as string, code: x.code as string, label: x.label as string, src: await variantPreviewUrl(tx, x) })))
    ).filter((t) => t.src);
    return { ...v, conf, revisedAt: revised[0]?.at as string | null, thumbs };
  });
  if (!d) notFound();
  // One table per measurement context and attribution window: different windows are different measurements (§30).
  const groups = [...new Map(d.results.map((r) => [`${r.measurement_context}|${r.attribution_window}`, { ctx: r.measurement_context as string, window: String(r.attribution_window ?? 'default') }])).values()];
  const windowLabel = (w: string) => (w === 'default' ? null : w.replace(/_/g, ' ').replace(/(\d+)d/g, '$1-day'));
  const label = new Map(d.variants.map((v) => [v.id as string, `${v.code} · ${v.label}`]));
  // Confounder windows that overlapped this test's observed dates (§45), as of the last computation.
  const overlapping = new Set(d.results.flatMap((r) => ((r.confounder_windows as { id: string }[] | null) ?? []).map((c) => c.id)));
  const canEdit = ['OWNER', 'ADMIN', 'MEMBER'].includes(w.ctx.role);
  const day = (x: unknown) => formatDate(x as string);
  const scopeOf = (ctx: string, window: string) => {
    const r = d.results.find((x) => x.measurement_context === ctx && String(x.attribution_window ?? 'default') === window);
    return (r?.scope ?? {}) as { optimizationEvent?: string; campaignType?: string; excludedImpressions?: number };
  };
  return (
    <>
      <p className="ak-index"><Link href={`/w/${slug}/results`}>Results</Link> / <Link href={`/w/${slug}/studio/${experimentId}`}>Studio</Link></p>
      <div className="ak-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h1 className="ak-h1" style={{ margin: 0 }}>{d.experiment.hypothesis as string}</h1>
        <SignalChip state={String(d.experiment.state)} />
      </div>
      {d.thumbs.length ? (
        <div className="ak-scroll-row" role="list" aria-label="Variants" style={{ marginTop: 24 }}>
          {d.thumbs.map((t) => (
            <div key={t.id} role="listitem">
              <VideoThumb src={t.src} caption={[t.code, t.label, '9:16'].join(' · ')} label={`Variant ${t.code}: ${t.label}`} />
            </div>
          ))}
        </div>
      ) : null}
      {d.revisedAt ? <Banner>Updated: numbers were revised on {formatDate(d.revisedAt)} as late conversions arrived.</Banner> : null}
      {d.freshness?.stale ? <Banner tone="warn">{d.freshness.degraded ? 'A connected ad account needs attention' : 'Your ad data hasn’t synced for over a week'} — these numbers may be incomplete.</Banner> : null}
      {groups.length === 0 ? (
        <p className="ak-muted" style={{ marginTop: 24 }}>No performance data yet. Launch the ads with the variant codes in their names, or upload a CSV from Results. Signals appear after roughly 1,000 impressions per variant.</p>
      ) : (
        groups.map(({ ctx, window }) => (
          <section key={`${ctx}|${window}`} className="ak-section">
            <h2 className="ak-label">{measurementContextLabel(ctx)}{windowLabel(window) ? ` · attribution ${windowLabel(window)}` : ''}</h2>
            {MeasurementContextCaveat[ctx as MeasurementContext] ? <Banner tone="warn">{MeasurementContextCaveat[ctx as MeasurementContext]}</Banner> : null}
            {(() => {
              // Compared only within one campaign context (§45); other campaigns' delivery is left out and said so.
              const sc = scopeOf(ctx, window);
              const parts = [sc.optimizationEvent ? `optimized for ${sc.optimizationEvent.replace(/_/g, ' ').toLowerCase()}` : null, sc.campaignType ? `${sc.campaignType.replace(/_/g, ' ').toLowerCase()} campaigns` : null].filter(Boolean);
              return parts.length || sc.excludedImpressions ? (
                <p className="ak-small ak-muted">
                  Compared within {parts.length ? parts.join(', ') : 'one campaign context'}.
                  {sc.excludedImpressions ? ` ${Number(sc.excludedImpressions).toLocaleString()} impressions from campaigns with a different goal are left out so the variants are compared like for like.` : ''}
                </p>
              ) : null;
            })()}
            <div className="ak-scroll-x">
              <table className="ak-table">
                <thead><tr><th>Variant</th><th>Metric</th><th>Observed</th><th>Estimated</th><th>Range (90%)</th><th>Chance best</th><th>Signal</th></tr></thead>
                <tbody>
                  {d.results.filter((r) => r.measurement_context === ctx && String(r.attribution_window ?? 'default') === window).map((r) => (
                    <tr key={r.id as string}>
                      <td className="ak-mono">{label.get(r.variant_id as string)}</td>
                      <td>{String(r.metric).replace('_', ' ')}</td>
                      <td className="ak-mono">{pct(r.raw_rate as number)} <span className="ak-muted">({Number(r.successes).toLocaleString()}/{Number(r.trials).toLocaleString()})</span></td>
                      <td className="ak-mono">{pct(r.posterior_mean as number)}</td>
                      <td className="ak-mono">{pct(r.ci_low as number)} – {pct(r.ci_high as number)}</td>
                      <td className="ak-mono">{r.prob_best == null ? '—' : `${Math.round(Number(r.prob_best) * 100)}%`}</td>
                      <td><SignalChip state={String(r.state)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
      <section className="ak-section">
        <h2 className="ak-label">How to read this</h2>
        <p className="ak-small ak-muted" style={{ maxWidth: 640 }}>Estimates shrink small samples toward your product’s average so one lucky day doesn’t look like a winner. “Gathering” means not enough data yet; “Directional” is a lean; “Actionable” means the evidence floor was met and it will shape next week’s recommendations.</p>
        {d.conf.length ? (
          <>
            <h3 className="ak-label">Things that happened around this test</h3>
            <p className="ak-small ak-muted" style={{ maxWidth: 640 }}>Days inside an active window are left out of the comparison; a window that overlaps the test’s dates marks the read as confounded.</p>
            {d.conf.map((c) => (
              <div key={c.id as string} className="ak-index-row">
                <span>
                  {String(c.kind).replace(/_/g, ' ')}{c.note ? ` — ${c.note}` : ''}
                  <span className="ak-small ak-muted" style={{ display: 'block' }}>
                    {day(c.starts_at)}{c.ends_at ? ` – ${day(c.ends_at)}` : ' – ongoing'} · {c.source === 'automatic' ? 'detected automatically' : c.source === 'staff' ? 'marked by Arkiv' : 'marked by your team'}
                    {c.status === 'pending_confirmation' ? ' · waiting for your confirmation' : overlapping.has(c.id as string) ? ' · overlaps this test' : ''}
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
          </>
        ) : null}
      </section>
    </>
  );
}
