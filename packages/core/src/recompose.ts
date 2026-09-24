import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, platformAssets } from '@arkiv/shared';
import { composeAd, layoutVoice, withTempDir, type SceneInput, type VoiceClip } from '@arkiv/media';
import { assetBytes, saveAsset, verifyAssetIntegrity } from './assets';
import { brandBrainFor } from './brand';
import type { LineMapping } from './compliance';
import { disclosureMetadata, formatPrice, resolveFactTokens, type CompositionManifest, type FactTokens } from './composition';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { versionCreative } from './creatives';
import { LEASE_BUSY, withJobLease } from './leases';
import { enqueue, Queues } from './outbox';
import { ASPECTS, claimsQaForExports } from './production';
import { currentFacts } from './product-truth';
import { qaExport, type CheckResult } from './qa';
import { factsForStatements, mapStatements, statementCheck } from './statements';

/**
 * Standard §42 "Price changes during production: update overlays/composition without re-generating footage when
 * possible" and §25 "Text/CTA/price/caption-only edit: usually no render charge — recompose without expensive model
 * call". An ad shows the product's price or size through {price} / {size} tokens in its on-screen text and CTA; they
 * are resolved from the current ProductFacts whenever the ad is composed. A production still running picks a change
 * up by itself; a delivered ad is recomposed from its composition manifest — the same accepted renders, frames and
 * voice-over, new on-screen text — with no provider call, and saved as a new version of the creative.
 */

/** The facts an ad can show through tokens, as of now (tenant or explicitly scoped transaction). */
export async function factTokens(tx: Tx, skuId: string): Promise<FactTokens> {
  const facts = await currentFacts(tx, skuId);
  const price = facts.price && !facts.price.disputed ? facts.price.value : null;
  const size = facts.size && !facts.size.disputed ? facts.size.value : null;
  const currency = ((price?.valueJson ?? {}) as { currency?: string }).currency ?? 'USD';
  return {
    price: price && (price.valueNumber != null || price.valueText) ? { factId: price.id, text: price.valueNumber != null ? formatPrice(price.valueNumber, currency) : price.valueText! } : null,
    size: size?.valueText ? { factId: size.id, text: size.valueText } : null,
  };
}

/** Does the manifest show a token whose fact has changed since it was composed? */
export function tokensStale(used: FactTokens | null | undefined, now: FactTokens): boolean {
  if (!used) return false;
  return (['price', 'size'] as const).some((k) => used[k] && (used[k]!.factId !== now[k]?.factId || used[k]!.text !== now[k]?.text));
}

/** The delivered ad's price or size on screen no longer matches the product (shown on delivery, §42). */
export async function priceUpdate(tx: Tx, workspaceId: string, projectId: string): Promise<{ stale: boolean; shown: string | null; current: string | null } | null> {
  const [r] = await tx`select p.sku_id, c.composition from projects p join creatives c on c.id = p.final_creative_id and c.workspace_id = p.workspace_id
                       where p.id = ${projectId} and p.workspace_id = ${workspaceId} and p.state = 'COMPLETE'`;
  const used = (r?.composition as CompositionManifest | null)?.tokens ?? null;
  if (!r || !used) return null;
  const now = await factTokens(tx, r.sku_id as string);
  return { stale: tokensStale(used, now), shown: used.price?.text ?? used.size?.text ?? null, current: (used.price ? now.price?.text : now.size?.text) ?? null };
}

/** Queue a recomposition of every delivered ad of a SKU that shows a fact that just changed. */
export async function queueRecompositions(tx: Tx, workspaceId: string, skuId: string): Promise<number> {
  const rows = await tx`select p.id from projects p join creatives c on c.id = p.final_creative_id and c.workspace_id = p.workspace_id
                        where p.workspace_id = ${workspaceId} and p.sku_id = ${skuId} and p.state = 'COMPLETE' and c.composition ? 'tokens'
                          and c.composition->'tokens' <> 'null'::jsonb`;
  for (const r of rows) await enqueue(tx, workspaceId, Queues.recomposeProject, { projectId: r.id }, { singletonKey: `recompose:${r.id as string}` });
  return rows.length;
}

/** The merchant's "Update my ad": queue the recomposition of one delivered ad whose price or size changed. */
export async function requestRecompose(tx: Tx, ctx: TenantContext, projectId: string): Promise<{ queued: boolean }> {
  assertCan(ctx, 'sku.edit');
  const u = await priceUpdate(tx, ctx.workspaceId, projectId);
  if (!u?.stale) return { queued: false };
  await enqueue(tx, ctx.workspaceId, Queues.recomposeProject, { projectId }, { singletonKey: `recompose:${projectId}` });
  return { queued: true };
}

const recomposeLease = (projectId: string) => `recompose:${projectId}`;

/**
 * Recompose a delivered ad with the product's current price/size (worker `recompose-project`, or the merchant's
 * "Update my ad"). Media only: no provider is called and nothing is charged. The new text passes the claims and
 * statement checks first (a price nothing backs is never shown). Idempotent: an ad already showing the current facts
 * is left alone; one run per project at a time.
 */
export async function recomposeProject(ctx: TenantContext, projectId: string): Promise<'recomposed' | 'unchanged' | 'skipped'> {
  const r = await withJobLease(ctx.workspaceId, recomposeLease(projectId), randomUUID(), 600, () => runRecompose(ctx, projectId));
  return r === LEASE_BUSY ? 'skipped' : r;
}

async function runRecompose(ctx: TenantContext, projectId: string): Promise<'recomposed' | 'unchanged' | 'skipped'> {
  const ws = ctx.workspaceId;
  const data = await withTenant(ws, async (tx) => {
    const [p] = await tx`select p.id, p.state, p.sku_id, p.variant_id, p.experiment_id, p.storyboard_id, p.final_creative_id, c.composition, c.genome, s.name as sku_name
                         from projects p join creatives c on c.id = p.final_creative_id and c.workspace_id = p.workspace_id join skus s on s.id = p.sku_id
                         where p.id = ${projectId} and p.workspace_id = ${ws}`;
    if (!p || p.state !== 'COMPLETE') return null;
    return { p, manifest: p.composition as CompositionManifest | null, tokens: await factTokens(tx, p.sku_id as string), brand: await brandBrainFor(tx, p.sku_id as string) };
  });
  if (!data?.manifest?.tokens) return 'skipped';
  const { p, manifest, tokens } = data;
  const used = manifest.tokens!;
  if (!tokensStale(used, tokens)) return 'unchanged';
  // The voice-over says the old value: recomposing the pictures alone would contradict it (a new line is needed).
  if (manifest.tokensSpoken) return 'skipped';

  // The new composition: the same scenes and voice, the on-screen text re-resolved from the current facts.
  const scenes = manifest.scenes.map((s) => (s.overlayTemplate ? { ...s, overlayText: resolveFactTokens(s.overlayTemplate, tokens) || null } : s));
  const tpl = manifest.endCard.ctaTemplate ?? null;
  const endCard = tpl
    ? { ...manifest.endCard, cta: resolveFactTokens(tpl.replace(/\{price\}/g, ''), tokens) || 'Shop now', price: /\{price\}/.test(tpl) ? (tokens.price?.text ?? null) : (manifest.endCard.price ?? null) }
    : manifest.endCard;
  const next: CompositionManifest = { ...manifest, scenes, endCard, tokens: { price: used.price ? tokens.price : null, size: used.size ? tokens.size : null } };

  // Claims and statement checks on what the ad now says (§25 check 3, Launch Gate 2).
  const lines = [...scenes.flatMap((s) => [s.spokenText, s.overlayText]), endCard.cta, endCard.price, endCard.spokenText].filter((l): l is string => !!l);
  const checks: CheckResult[] = await withTenant(ws, async (tx) => {
    const claims = await claimsQaForExports(tx, p.sku_id as string, lines, ASPECTS, { names: [p.sku_name as string, data.brand?.name ?? null] });
    const statements = statementCheck(mapStatements(lines, ((claims.data as { mapping?: LineMapping[] } | undefined)?.mapping ?? []) as LineMapping[], await factsForStatements(tx, p.sku_id as string)));
    return [claims, statements];
  });
  const failing = checks.filter((c) => !c.pass && c.hard);
  if (failing.length) throw new DomainError('GATE_BLOCKED', `The updated ad can’t be made: ${failing.map((c) => c.detail).join('; ').slice(0, 300)}`);

  return withTempDir(async (dir) => {
    const inputs: SceneInput[] = [];
    for (const [i, s] of scenes.entries()) {
      if (!s.assetId) throw new DomainError('CONFLICT', 'This ad was made before recomposition was possible.');
      const f = path.join(dir, `s${i}.${s.kind === 'video' ? 'mp4' : 'png'}`);
      await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, s.assetId!)));
      inputs.push({ kind: s.kind, file: f, durationMs: s.durationMs, overlayText: s.overlayText, motion: 'push' });
    }
    let voPath: string | null = null;
    const segs = next.voiceover?.segments ?? [];
    if (segs.length) {
      const clips: VoiceClip[] = [];
      for (const [i, s] of segs.entries()) {
        const f = path.join(dir, `vo-${i}.mp3`);
        await writeFile(f, await withTenant(ws, (tx) => assetBytes(tx, s.clipAssetId)));
        clips.push({ file: f, startMs: s.startMs, tempo: s.tempo });
      }
      voPath = path.join(dir, 'vo.wav');
      await layoutVoice(clips, next.durationMs, voPath);
    }
    const card = { productName: endCard.productName, cta: endCard.cta, index: endCard.index, durationMs: endCard.durationMs, accent: endCard.accent ?? null, note: endCard.note ?? null, price: endCard.price ?? null };
    const outs = await composeAd({ scenes: inputs, voiceover: voPath, captions: next.captions, endCard: card, aspects: next.aspects, metadata: disclosureMetadata(next.disclosure ?? { aiGenerated: false, syntheticPeople: false, syntheticVoice: false, generatedScenes: [] }) }, dir);
    for (const o of outs) checks.push(...(await qaExport(o.file, o.aspect, next.durationMs)));
    const bad = checks.filter((c) => !c.pass && c.hard);
    if (bad.length) throw new Error(`recomposition failed final QA: ${bad.map((c) => c.detail).join('; ').slice(0, 300)}`);
    return withTenant(ws, async (tx) => {
      // Another run finished first (or the ad moved on): nothing to do.
      const [cur] = await tx`select final_creative_id from projects where id = ${projectId} and workspace_id = ${ws} for update`;
      if (cur?.final_creative_id !== p.final_creative_id) return 'unchanged' as const;
      const exported: { aspect: string; assetId: string }[] = [];
      for (const o of outs) {
        const a = await saveAsset(tx, ws, { bytes: await readFile(o.file), mime: 'video/mp4', kind: 'final_export', skuId: p.sku_id as string, source: 'composed', lineage: { projectId, aspect: o.aspect, srt: o.srt, storyboardId: p.storyboard_id, recomposed: true, disclosure: next.disclosure } });
        exported.push({ aspect: o.aspect, assetId: a.id });
      }
      if (!(await Promise.all(exported.map((e) => verifyAssetIntegrity(tx, e.assetId)))).every(Boolean)) throw new Error('recomposition: checksum mismatch');
      const creativeId = await versionCreative(tx, ctx, {
        skuId: p.sku_id as string,
        parentCreativeId: p.final_creative_id as string,
        projectId,
        genome: p.genome as Record<string, unknown>,
        finalAssetIds: exported.map((e) => e.assetId),
        composition: next,
        changedVariables: ['offer'],
        experimentId: (p.experiment_id as string | null) ?? null,
        variantId: (p.variant_id as string | null) ?? null,
        storyboardId: (p.storyboard_id as string | null) ?? null,
      });
      await tx`update projects set final_creative_id = ${creativeId} where id = ${projectId} and workspace_id = ${ws}`;
      if (p.variant_id) await tx`update variants set creative_id = ${creativeId}, platform_assets = ${tx.json(platformAssets(exported) as never)} where id = ${p.variant_id} and workspace_id = ${ws}`;
      return 'recomposed' as const;
    });
  });
}
