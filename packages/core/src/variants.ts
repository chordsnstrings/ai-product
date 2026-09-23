import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTenant } from '@arkiv/db';
import { composeAd, placeholderFrame, withTempDir, type SceneInput } from '@arkiv/media';
import { assetBytes, saveAsset } from './assets';
import { scanCreativeText } from './compliance';
import type { TenantContext } from './context';
import { allowedClaimTexts } from './creative-director';
import { emit } from './events';
import { setExperimentState } from './experiments';
import { qaExperimentIntegrity, qaExport } from './qa';

/**
 * Economical hook variants (§5 Creative Test definition): reuse the master's accepted footage and change only
 * the opening hook (overlay text). No new generation → no extra model spend; experiment integrity QA verifies
 * that only the hook changed (§25 check 6).
 */
export async function produceHookVariants(ctx: TenantContext, projectId: string): Promise<number> {
  const ws = ctx.workspaceId;
  const data = await withTenant(ws, async (tx) => {
    const [p] = await tx`select * from projects where id = ${projectId}`;
    if (!p?.experiment_id || p.state !== 'COMPLETE') return null;
    const hookVariants = await tx`select * from variants where experiment_id = ${p.experiment_id} and role = 'variant'
                                  and project_id is null and creative_id is null order by code`;
    const scenes = await tx`select * from scenes where storyboard_id = ${p.storyboard_id} order by position`;
    const [sb] = await tx`select * from storyboards where id = ${p.storyboard_id}`;
    const [sku] = await tx`select * from skus where id = ${p.sku_id}`;
    const allowed = await allowedClaimTexts(tx, p.sku_id as string);
    const sources: { sceneId: string; kind: 'still' | 'video'; bytes: Buffer }[] = [];
    for (const s of scenes) {
      const [render] = await tx`select asset_id from scene_versions where scene_id = ${s.id} and kind = 'render' and status = 'accepted' order by version desc limit 1`;
      const [frame] = await tx`select asset_id from scene_versions where id = ${s.current_version_id}`;
      sources.push(
        render?.asset_id
          ? { sceneId: s.id as string, kind: 'video', bytes: await assetBytes(tx, render.asset_id as string) }
          : { sceneId: s.id as string, kind: 'still', bytes: frame?.asset_id ? await assetBytes(tx, frame.asset_id as string) : await placeholderFrame('', '9x16') },
      );
    }
    return { p, hookVariants, scenes, sb: sb!, sku: sku!, allowed, sources };
  });
  if (!data || !data.hookVariants.length) return 0;
  let made = 0;
  for (const v of data.hookVariants) {
    const hook = v.label as string;
    if (!scanCreativeText([hook], data.allowed).ok) continue; // never ship a non-compliant hook
    await withTempDir(async (dir) => {
      const inputs: SceneInput[] = [];
      let cta = 2000;
      for (const [i, s] of data.scenes.entries()) {
        const src = data.sources[i]!;
        const f = path.join(dir, `s${i}.${src.kind === 'video' ? 'mp4' : 'png'}`);
        await writeFile(f, src.bytes);
        if (s.purpose === 'cta') {
          cta = s.duration_ms as number;
          continue;
        }
        inputs.push({ kind: src.kind, file: f, durationMs: s.duration_ms as number, overlayText: i === 0 ? hook.slice(0, 60) : (s.overlay_text as string | null), motion: 'push' });
      }
      const outs = await composeAd(
        { scenes: inputs, voiceover: null, endCard: { productName: data.sku.name as string, cta: (data.sb.cta_text as string) ?? 'Shop now', index: v.code as string, durationMs: cta }, aspects: ['9x16', '4x5'] },
        dir,
      );
      const checks = [...(await qaExport(outs[0]!.file, '9x16', 15000)), qaExperimentIntegrity({ changed: ['hook'], heldConstant: ['body', 'offer', 'cta', 'product'] }, { changed: ['hook'] })];
      if (checks.some((c) => !c.pass && c.hard)) return;
      await withTenant(ws, async (tx) => {
        const ids: string[] = [];
        for (const o of outs) {
          const a = await saveAsset(tx, ws, { bytes: await readFile(o.file), mime: 'video/mp4', kind: 'final_export', skuId: data.p.sku_id as string, source: 'composed', lineage: { projectId, variantId: v.id, aspect: o.aspect, changed: ['hook'] } });
          ids.push(a.id);
        }
        const [cr] = await tx`insert into creatives (workspace_id, sku_id, origin, parent_creative_id, project_id, genome, genome_version, final_asset_ids)
                              values (${ws}, ${data.p.sku_id}, 'generated', ${data.p.final_creative_id}, ${projectId}, ${tx.json({ ...(v.genes as object), hookText: hook } as never)}, 1, ${ids})
                              returning id`;
        await tx`update variants set creative_id = ${cr!.id} where id = ${v.id}`;
        await emit(tx, ctx, 'VARIANT_GENERATED', { type: 'variant', id: v.id as string }, { changed: ['hook'], creativeId: cr!.id });
      });
      made++;
    });
  }
  await withTenant(ws, (tx) => setExperimentState(tx, ctx, data.p.experiment_id as string, 'READY_TO_RUN', 'variants ready'));
  return made;
}
