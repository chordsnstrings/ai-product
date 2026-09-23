import type { Metadata } from 'next';
import { withTenant } from '@arkiv/db';
import { brandBrainHistory, toBrain } from '@arkiv/core';
import { ActionForm } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Brand · Arkiv' };

const MARKETS = [['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['EU', 'European Union']] as const;
const FIELD: Record<string, string> = { name: 'name', tone: 'tone', colors: 'colours', prohibited: 'never show or say', disclosures: 'disclosures', cta: 'call to action', market: 'market' };

/** Brand Brain: tone, prohibited aesthetics and disclosures feed every concept and storyboard. Every save is a version. */
export default async function Brand({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const { b, history } = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [row] = await tx`select id, name, brain from brands order by created_at limit 1`;
    return { b: row, history: row ? await brandBrainHistory(tx, row.id as string) : [] };
  });
  const brain = toBrain(b?.brain);
  const canEdit = ['OWNER', 'ADMIN', 'MEMBER'].includes(w.ctx.role);
  return (
    <div className="ak-grid-2" style={{ alignItems: 'start' }}>
      <div className="ak-panel">
        <h2 className="ak-label">Brand brain</h2>
        {canEdit ? (
          <ActionForm slug={slug} action="brand" submit="Save brand" fields={[
            { name: 'name', label: 'Brand name', required: true, defaultValue: (b?.name as string) ?? w.name, max: 80 },
            { name: 'tone', label: 'Tone of voice', type: 'textarea', defaultValue: brain.tone ?? '', max: 300, placeholder: 'e.g. calm, clinical, never hypey' },
            { name: 'prohibited', label: 'Never show or say', type: 'textarea', defaultValue: brain.prohibited ?? '', max: 500, placeholder: 'e.g. before/after splits, bathroom selfies, “miracle”' },
            { name: 'disclosures', label: 'Required disclosures', type: 'textarea', defaultValue: brain.disclosures ?? '', max: 500 },
            { name: 'cta', label: 'Preferred call to action', defaultValue: brain.cta ?? '', max: 40, placeholder: 'e.g. Shop the serum' },
            { name: 'market', label: 'Market you sell in (claims are approved per market)', type: 'select', defaultValue: brain.market, options: MARKETS.map(([value, label]) => ({ value, label })) },
            { name: 'reason', label: 'What changed (optional)', max: 200 },
          ]} />
        ) : <p className="ak-muted">Only members can edit the brand.</p>}
      </div>
      <div className="ak-small ak-muted">
        <p>Everything here is sent with each concept and storyboard request. It shapes voice and visuals; it never overrides claim rules.</p>
        <p>Workspace name: <strong>{w.name}</strong></p>
        {history.length ? (
          <>
            <p className="ak-label">History</p>
            {history.slice(0, 8).map((h) => (
              <div key={h.id as string} className="ak-index-row">
                <span>
                  v{h.version as number} · {Object.keys((h.diff as Record<string, unknown>) ?? {}).map((k) => FIELD[k] ?? k).join(', ') || 'first version'}
                  {h.reason ? ` — ${h.reason as string}` : ''}
                </span>
                <span className="ak-index">{new Date(h.created_at as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              </div>
            ))}
          </>
        ) : null}
        {['OWNER', 'ADMIN'].includes(w.ctx.role) ? <ActionForm slug={slug} action="rename" submit="Rename workspace" fields={[{ name: 'name', label: 'Workspace name', defaultValue: w.name, required: true, max: 80 }]} /> : null}
      </div>
    </div>
  );
}
