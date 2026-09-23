import type { Metadata } from 'next';
import { withTenant } from '@arkiv/db';
import { ActionForm } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Brand · Arkiv' };

/** Brand Brain: tone, prohibited aesthetics and disclosures feed every concept and storyboard. */
export default async function Brand({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const [b] = await withTenant(w.ctx.workspaceId, (tx) => tx`select name, brain from brands order by created_at limit 1`);
  const brain = (b?.brain ?? {}) as { tone?: string; prohibited?: string; disclosures?: string; cta?: string };
  const canEdit = ['OWNER', 'ADMIN', 'MEMBER'].includes(w.ctx.role);
  return (
    <div className="ak-grid-2" style={{ alignItems: 'start' }}>
      <div className="ak-panel">
        <p className="ak-label">Brand brain</p>
        {canEdit ? (
          <ActionForm slug={slug} action="brand" submit="Save brand" fields={[
            { name: 'name', label: 'Brand name', required: true, defaultValue: (b?.name as string) ?? w.name, max: 80 },
            { name: 'tone', label: 'Tone of voice', type: 'textarea', defaultValue: brain.tone ?? '', max: 300, placeholder: 'e.g. calm, clinical, never hypey' },
            { name: 'prohibited', label: 'Never show or say', type: 'textarea', defaultValue: brain.prohibited ?? '', max: 500, placeholder: 'e.g. before/after splits, bathroom selfies, “miracle”' },
            { name: 'disclosures', label: 'Required disclosures', type: 'textarea', defaultValue: brain.disclosures ?? '', max: 500 },
            { name: 'cta', label: 'Preferred call to action', defaultValue: brain.cta ?? '', max: 40, placeholder: 'e.g. Shop the serum' },
          ]} />
        ) : <p className="ak-muted">Only members can edit the brand.</p>}
      </div>
      <div className="ak-small ak-muted">
        <p>Everything here is sent with each concept and storyboard request. It shapes voice and visuals; it never overrides claim rules.</p>
        <p>Workspace name: <strong>{w.name}</strong></p>
        {['OWNER', 'ADMIN'].includes(w.ctx.role) ? <ActionForm slug={slug} action="rename" submit="Rename workspace" fields={[{ name: 'name', label: 'Workspace name', defaultValue: w.name, required: true, max: 80 }]} /> : null}
      </div>
    </div>
  );
}
