import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import { experimentView } from '@arkiv/core';
import { Banner, SignalChip } from '@arkiv/ui';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Test results · Arkiv' };

const CONTEXT: Record<string, string> = { meta_paid: 'Meta · paid', tiktok_paid: 'TikTok · paid', tiktok_gmv_max: 'TikTok GMV Max (includes organic + affiliate)', manual_csv: 'Uploaded CSV' };
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
    const conf = await tx`select kind, starts_at, ends_at, note from confounders where (sku_id is null or sku_id = ${v.experiment.sku_id}) and starts_at > now() - interval '120 days' order by starts_at desc`;
    const revised = await tx`select max(superseded_at) as at from performance_observations where variant_id in ${tx(v.variants.length ? v.variants.map((x) => x.id as string) : ['00000000-0000-0000-0000-000000000000'])}`;
    return { ...v, conf, revisedAt: revised[0]?.at as string | null };
  });
  if (!d) notFound();
  const contexts = [...new Set(d.results.map((r) => r.measurement_context as string))];
  const label = new Map(d.variants.map((v) => [v.id as string, `${v.code} · ${v.label}`]));
  return (
    <>
      <p className="ak-index"><Link href={`/w/${slug}/results`}>Results</Link> / <Link href={`/w/${slug}/studio/${experimentId}`}>Studio</Link></p>
      <div className="ak-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h1 className="ak-h1" style={{ margin: 0 }}>{d.experiment.hypothesis as string}</h1>
        <SignalChip state={String(d.experiment.state)} />
      </div>
      {d.revisedAt ? <Banner>Updated: numbers were revised on {new Date(d.revisedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} as late conversions arrived.</Banner> : null}
      {d.freshness?.degraded ? <Banner tone="warn">A connected ad account needs attention — these numbers may be incomplete.</Banner> : null}
      {contexts.length === 0 ? (
        <p className="ak-muted" style={{ marginTop: 24 }}>No performance data yet. Launch the ads with the variant codes in their names, or upload a CSV from Results. Signals appear after roughly 1,000 impressions per variant.</p>
      ) : (
        contexts.map((ctx) => (
          <section key={ctx} className="ak-section">
            <h2 className="ak-label">{CONTEXT[ctx] ?? ctx}</h2>
            <div className="ak-scroll-x">
              <table className="ak-table">
                <thead><tr><th>Variant</th><th>Metric</th><th>Observed</th><th>Estimated</th><th>Range (90%)</th><th>Chance best</th><th>Signal</th></tr></thead>
                <tbody>
                  {d.results.filter((r) => r.measurement_context === ctx).map((r) => (
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
            <h3 className="ak-label">Confounders in this period</h3>
            {d.conf.map((c, i) => <div key={i} className="ak-index-row"><span>{String(c.kind).replace(/_/g, ' ')}{c.note ? ` — ${c.note}` : ''}</span><span className="ak-index">{new Date(c.starts_at as string).toLocaleDateString()}</span></div>)}
          </>
        ) : null}
      </section>
    </>
  );
}
