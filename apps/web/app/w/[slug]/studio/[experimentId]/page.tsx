import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import { assetUrl, balances, experimentView } from '@arkiv/core';
import { SignalChip } from '@arkiv/ui';
import { StudioClient } from '@/components/studio';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Studio · Arkiv' };

/** A3 Studio: approve and refine an experiment before spend; then download variants and link them to ads. */
export default async function Studio({ params }: { params: Promise<{ slug: string; experimentId: string }> }) {
  const { slug, experimentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(experimentId)) notFound();
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [exists] = await tx`select 1 from experiments where id = ${experimentId}`;
    if (!exists) return null;
    const v = await experimentView(tx, experimentId);
    const [sku] = await tx`select name, catalogue_no from skus where id = ${v.experiment.sku_id}`;
    const variants = await Promise.all(
      v.variants.map(async (x) => {
        let files: { aspect: string; url: string }[] = [];
        const creativeId = x.creative_id ?? (x.project_id ? (await tx`select final_creative_id from projects where id = ${x.project_id}`)[0]?.final_creative_id : null);
        if (creativeId) {
          const [cr] = await tx`select final_asset_ids from creatives where id = ${creativeId}`;
          const assets = (cr?.final_asset_ids as string[] | undefined)?.length ? await tx`select id, lineage from assets where id in ${tx(cr!.final_asset_ids as string[])}` : [];
          files = await Promise.all(assets.map(async (a) => ({ aspect: (a.lineage as { aspect?: string }).aspect ?? 'video', url: await assetUrl(tx, a.id as string, 3600, `${x.code}-${(a.lineage as { aspect?: string }).aspect ?? 'ad'}.mp4`) })));
        }
        return { id: x.id as string, code: x.code as string, label: x.label as string, role: x.role as string, projectId: (x.project_id as string) ?? null, projectState: (x.project_state as string) ?? null, files };
      }),
    );
    return { e: v.experiment, sku, variants, results: v.results, bal: await balances(tx) };
  });
  if (!d) notFound();
  const master = d.variants.find((v) => v.projectId);
  return (
    <>
      <p className="ak-index">No. {String(d.sku!.catalogue_no).padStart(3, '0')} · {d.sku!.name as string} · {d.e.mode === 'CONTROLLED' ? 'Controlled test' : 'Exploratory test'}</p>
      <div className="ak-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h1 className="ak-h1" style={{ margin: 0 }}>{d.e.hypothesis as string}</h1>
        <SignalChip state={String(d.e.state)} />
      </div>
      <dl className="ak-meta ak-small" style={{ marginTop: 16 }}>
        <dt>Primary variable</dt><dd>{d.e.primary_variable as string}</dd>
        <dt>Held constant</dt><dd>{(d.e.controlled_variables as string[]).join(', ') || '—'}</dd>
        <dt>Primary metric</dt><dd>{String(d.e.primary_metric).replace('_', ' ')}</dd>
        <dt>You’ll learn</dt><dd>{d.e.expected_learning as string}</dd>
        <dt>If it fails</dt><dd>{d.e.if_test_fails as string}</dd>
      </dl>
      <StudioClient
        slug={slug}
        experimentId={experimentId}
        state={String(d.e.state)}
        masterProjectId={master?.projectId ?? null}
        variants={d.variants}
        testsLeft={d.bal.creativeTests}
        canApprove={['OWNER', 'ADMIN', 'MEMBER'].includes(w.ctx.role)}
      />
    </>
  );
}
