import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import { assetUrl, balances, experimentView, listCreatorPacks } from '@arkiv/core';
import type { Platform, PlatformAsset } from '@arkiv/shared';
import { SignalChip } from '@arkiv/ui';
import { CreatorPacks } from '@/components/creator-packs';
import { StudioClient } from '@/components/studio';
import { workspacePage } from '@/lib/tenant';
import { variantPreviewUrl } from '@/lib/variant-preview';

export const metadata: Metadata = { title: 'Studio · Arkiv' };

const PLACEMENT_LABEL: Record<Platform, string> = { TIKTOK: 'TikTok', INSTAGRAM_REELS: 'Reels', FACEBOOK_FEED: 'Feed' };

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
        let files: { aspect: string; label: string; url: string }[] = [];
        // §2.4 video thumbnail: the 9:16 cut, signed without a download name so it plays inline.
        const preview = await variantPreviewUrl(tx, x);
        // The variant code already carries the catalogue number (AK-014-A).
        const caption = [x.code as string, x.label as string, '9:16'].filter(Boolean).join(' · ');
        // Variant.platform_assets[] (§20): one download per placement, named for the platform it goes to.
        const placements = (x.platform_assets as PlatformAsset[] | null) ?? [];
        if (placements.length) {
          files = await Promise.all(placements.map(async (pa) => ({ aspect: pa.aspect, label: `${PLACEMENT_LABEL[pa.platform]} ${pa.aspect.replace('x', ':')}`, url: await assetUrl(tx, pa.assetId, 3600, `${x.code}-${pa.platform.toLowerCase()}-${pa.aspect}.mp4`) })));
          return { id: x.id as string, code: x.code as string, label: x.label as string, role: x.role as string, projectId: (x.project_id as string) ?? null, projectState: (x.project_state as string) ?? null, files, preview, caption };
        }
        const creativeId = x.creative_id ?? (x.project_id ? (await tx`select final_creative_id from projects where id = ${x.project_id}`)[0]?.final_creative_id : null);
        if (creativeId) {
          const [cr] = await tx`select final_asset_ids from creatives where id = ${creativeId}`;
          const assets = (cr?.final_asset_ids as string[] | undefined)?.length ? await tx`select id, lineage from assets where id in ${tx(cr!.final_asset_ids as string[])}` : [];
          files = await Promise.all(assets.map(async (a) => ({ aspect: (a.lineage as { aspect?: string }).aspect ?? 'video', label: (a.lineage as { aspect?: string }).aspect ?? 'video', url: await assetUrl(tx, a.id as string, 3600, `${x.code}-${(a.lineage as { aspect?: string }).aspect ?? 'ad'}.mp4`) })));
        }
        return { id: x.id as string, code: x.code as string, label: x.label as string, role: x.role as string, projectId: (x.project_id as string) ?? null, projectState: (x.project_state as string) ?? null, files, preview, caption };
      }),
    );
    // AI-content disclosure of the experiment's ads (the variants reuse the master's media, standard §40).
    const masterProject = variants.find((x) => x.projectId)?.projectId ?? null;
    const [dc] = masterProject
      ? await tx`select c.ai_generated, c.synthetic_people, c.composition->'disclosure'->>'syntheticVoice' as synthetic_voice
                 from projects p join creatives c on c.id = p.final_creative_id where p.id = ${masterProject}`
      : [];
    const disclosure = dc ? { aiGenerated: !!dc.ai_generated, syntheticPeople: !!dc.synthetic_people, syntheticVoice: dc.synthetic_voice === 'true' } : null;
    const packs = (await listCreatorPacks(tx, experimentId)).map((p) => ({ id: p.id as string, expiresAt: new Date(p.expires_at as string).toISOString(), revokedAt: p.revoked_at ? new Date(p.revoked_at as string).toISOString() : null, views: Number(p.views), uploads: Number(p.uploads), createdAt: new Date(p.created_at as string).toISOString() }));
    return { e: v.experiment, sku, variants, results: v.results, bal: await balances(tx), disclosure, packs };
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
        disclosure={d.disclosure}
      />
      <CreatorPacks slug={slug} experimentId={experimentId} packs={d.packs} canEdit={['OWNER', 'ADMIN', 'MEMBER'].includes(w.ctx.role)} />
    </>
  );
}
