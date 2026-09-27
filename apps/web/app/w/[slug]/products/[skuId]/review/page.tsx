import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import type { SkuReviewBody } from '@arkiv/core';
import { MetadataTable } from '@arkiv/ui';
import { skuTitle } from '@/lib/page-title';
import { denyPage, workspacePage } from '@/lib/tenant';
import { formatDate } from '@arkiv/shared/format';

export async function generateMetadata({ params }: { params: Promise<{ slug: string; skuId: string }> }): Promise<Metadata> {
  const { slug, skuId } = await params;
  return skuTitle(slug, skuId, 'Creative review');
}

const STATE: Record<string, string> = {
  ACTIONABLE: 'Actionable',
  DIRECTIONAL: 'Directional',
  GATHERING_SIGNAL: 'Gathering signal',
  INCONCLUSIVE: 'Inconclusive',
  OPERATIONALLY_CONFOUNDED: 'Confounded',
  INVALIDATED: 'Invalidated',
  WEAKENING: 'Weakening',
  PRODUCING: 'In production',
  READY_TO_RUN: 'Ready to run',
  ARCHIVED: 'Archived',
};
const words = (s: string | null) => (s ? s.toLowerCase().replace(/_/g, ' ') : '—');
const pct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`);

/** Standard §9 Day 30 / §11 month-end: the SKU Creative Review and the plan for next month. */
export default async function Review({ params, searchParams }: { params: Promise<{ slug: string; skuId: string }>; searchParams: Promise<{ v?: string }> }) {
  const { slug, skuId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(skuId)) notFound();
  const v = Number((await searchParams).v) || null;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [sku] = await tx`select name, catalogue_no from skus where id = ${skuId}`;
    if (!sku) return null;
    const all = await tx`select id, kind, version, period_start, period_end, body, created_at from sku_reviews where sku_id = ${skuId} order by version desc`;
    return { sku, all, review: (v ? all.find((r) => Number(r.version) === v) : all[0]) ?? null };
  });
  if (!d) return denyPage('sku', skuId, w);
  const r = d.review;
  const b = r ? (r.body as SkuReviewBody) : null;
  return (
    <>
      <p className="ak-index"><Link href={`/w/${slug}/products/${skuId}`}>No. {String(d.sku.catalogue_no).padStart(3, '0')} {d.sku.name as string}</Link> / Creative review</p>
      <h1 className="ak-h1">Creative review</h1>
      {!r || !b ? (
        <p className="ak-muted" style={{ maxWidth: 640 }}>Your first review arrives 30 days after your first ad or test for this product, and then at the end of each billing month: what you tested, what it showed, what contradicted it, what you haven’t tried, and what to run next.</p>
      ) : (
        <div className="ak-stack" style={{ ['--stack' as string]: '32px', maxWidth: 880 }}>
          <p className="ak-small ak-muted">
            {r.kind === 'day30' ? 'Day 30' : 'Month end'} · {formatDate(b.period.start, { timeZone: 'UTC' })} – {formatDate(b.period.end, { timeZone: 'UTC' })} · version {r.version as number}
            {d.all.length > 1 ? <> · earlier: {d.all.filter((x) => x.id !== r.id).map((x) => <Link key={x.id as string} href={`?v=${x.version}`} style={{ marginLeft: 6 }}>v{x.version as number}</Link>)}</> : null}
          </p>
          <MetadataTable rows={[
            { label: 'Tests run', value: String(b.summary.tested) },
            { label: 'Actionable learnings', value: String(b.summary.actionable) },
            { label: 'Directional', value: String(b.summary.directional) },
            { label: 'Inconclusive or confounded', value: String(b.summary.inconclusive) },
            { label: 'Contradictions', value: String(b.summary.contradictions) },
          ]} />
          <section>
            <h2 className="ak-label">What you tested</h2>
            {b.tested.length ? b.tested.map((t) => (
              <div key={t.experimentId} className="ak-index-row">
                <span>{t.hypothesis}<span className="ak-small ak-muted" style={{ display: 'block' }}>{words(t.angle)} · {words(t.treatment)} · {t.primaryMetric}</span></span>
                <span className="ak-index">{STATE[t.state] ?? words(t.state)}{t.best ? ` · best ${pct(t.best.rate)} (${pct(t.best.ciLow)}–${pct(t.best.ciHigh)})` : ''}</span>
              </div>
            )) : <p className="ak-muted">No tests ran in this period.</p>}
          </section>
          <section>
            <h2 className="ak-label">What the evidence says</h2>
            {b.evidence.length ? <ul className="ak-small">{b.evidence.map((l) => <li key={l.learningId}>{STATE[l.state]}: {l.statement} <span className="ak-muted">({l.platform}, confidence {Math.round(l.confidence * 100)}%)</span></li>)}</ul> : <p className="ak-muted">Nothing is directional yet — results need more spend or time.</p>}
          </section>
          <section>
            <h2 className="ak-label">Contradictions</h2>
            {b.contradictions.length ? <ul className="ak-small">{b.contradictions.map((l) => <li key={l.learningId}>{STATE[l.state] ?? words(l.state)}: {l.statement}{l.contradictedBy ? ` — contradicted by ${l.contradictedBy} test${l.contradictedBy > 1 ? 's' : ''}` : ''}</li>)}</ul> : <p className="ak-muted">No learning was weakened or contradicted.</p>}
          </section>
          <section>
            <h2 className="ak-label">Untested space</h2>
            {b.untested.length ? <ul className="ak-small">{b.untested.map((u) => <li key={u.angle}>{words(u.angle)}</li>)}</ul> : <p className="ak-muted">Every angle has at least one test.</p>}
          </section>
          <section>
            <h2 className="ak-label">Next month</h2>
            {b.portfolio.length ? b.portfolio.map((p) => (
              <div key={p.recommendationId} className="ak-index-row"><span>{p.hypothesis}</span><span className="ak-index">{p.slot.toLowerCase()}</span></div>
            )) : <p className="ak-muted">Your next recommendations appear on <Link href={`/w/${slug}/this-week`}>This week</Link>.</p>}
          </section>
        </div>
      )}
    </>
  );
}
