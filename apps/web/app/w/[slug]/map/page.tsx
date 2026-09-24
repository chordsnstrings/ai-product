import type { Metadata } from 'next';
import Link from 'next/link';
import { withTenant } from '@arkiv/db';
import { creativeMap } from '@arkiv/core';
import { Empty, LinkButton } from '@arkiv/ui';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Creative Map · Arkiv' };

const t = (s: string) => s.replace(/_/g, ' ');

/** Each signal state has a glyph and a word as well as its tint, so colour is never the only cue (WCAG 1.4.1). */
const STATES: Record<string, { glyph: string; word: string }> = {
  actionable: { glyph: '●', word: 'Actionable' },
  directional: { glyph: '◐', word: 'Directional' },
  gathering: { glyph: '○', word: 'Gathering signal' },
  inconclusive: { glyph: '?', word: 'Inconclusive' },
  untested: { glyph: '–', word: 'No test result yet' },
};

/** A2: what's been tested per SKU — angles × treatments, count and best signal per cell. */
export default async function MapPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ sku?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => {
    const skus = await tx`select id, name, catalogue_no from skus where status = 'active' order by catalogue_no`;
    const sku = skus.find((s) => s.id === sp.sku) ?? skus[0];
    return { skus, sku, map: sku ? await creativeMap(tx, sku.id as string) : null };
  });
  if (!d.sku || !d.map) return <Empty title="No products yet" body="Add a product to start building your creative archive." action={<LinkButton href="/start">Add a product</LinkButton>} />;
  const byKey = new Map(d.map.cells.map((c) => [`${c.angle}|${c.treatment}`, c]));
  const usedTreatments = d.map.treatments.filter((tr) => d.map!.cells.some((c) => c.treatment === tr));
  const cols = usedTreatments.length ? usedTreatments : d.map.treatments.slice(0, 6);
  return (
    <>
      <h1 className="ak-h1">Creative Map</h1>
      <div className="ak-row" style={{ flexWrap: 'wrap' }}>
        {d.skus.map((s) => (
          <Link key={s.id as string} href={`/w/${slug}/map?sku=${s.id}`} className={`ak-chip${s.id === d.sku!.id ? ' ak-chip--dec' : ''}`} aria-current={s.id === d.sku!.id ? 'page' : undefined}>
            {s.id === d.sku!.id ? <span aria-hidden>✓ </span> : null}No. {String(s.catalogue_no).padStart(3, '0')} {s.name as string}
          </Link>
        ))}
      </div>
      <p className="ak-small ak-muted">Rows are angles, columns are production treatments. Numbers count tests and imported ads; the mark shows the strongest signal reached. Empty rows are under-tested territory.</p>
      <ul className="ak-legend" aria-label="Key">
        {Object.entries(STATES).map(([k, s]) => (
          <li key={k}><span className="ak-swatch ak-cell" data-signal={k} aria-hidden>{s.glyph}</span>{s.word}</li>
        ))}
        <li><span className="ak-swatch" aria-hidden>·</span>Not tried</li>
      </ul>
      <div className="ak-scroll-x">
        <table className="ak-table">
          <caption className="ak-sr">Tests by angle and treatment for No. {String(d.sku.catalogue_no).padStart(3, '0')} {d.sku.name as string}</caption>
          <thead><tr><th scope="col">Angle</th>{cols.map((c) => <th key={c} scope="col">{t(c)}</th>)}</tr></thead>
          <tbody>
            {d.map.angles.map((a) => (
              <tr key={a}>
                <th scope="row">{t(a)}</th>
                {cols.map((c) => {
                  const cell = byKey.get(`${a}|${c}`);
                  const st = cell ? (STATES[cell.state] ?? { glyph: '', word: cell.state }) : null;
                  return (
                    <td key={c}>
                      <div className="ak-cell" data-signal={cell?.state ?? 'untested'}>
                        {cell ? (
                          <>
                            {cell.count}
                            <span className="ak-cell-glyph" aria-hidden>{st!.glyph}</span>
                            <span className="ak-sr">{cell.count === 1 ? ' test' : ' tests'}, {st!.word}</span>
                          </>
                        ) : (
                          <>
                            <span aria-hidden>·</span>
                            <span className="ak-sr">Not tried</span>
                          </>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
