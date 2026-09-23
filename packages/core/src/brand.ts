import type { Tx } from '@arkiv/db';
import { DomainError, normalizeMarkets } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { actorString } from './context';
import { emit } from './events';

/**
 * Brand Brain (§16): tone, visual rules, prohibited aesthetics, disclosures, CTA vocabulary and the market the
 * brand sells in. Stored as immutable versions with actor, reason and diff (§15 "atomic, versioned records
 * with provenance"); brands.brain is the current copy and brands.current_version_id points at its version.
 */
export interface BrandBrain {
  tone: string | null;
  colors: string[];
  prohibited: string | null;
  disclosures: string | null;
  cta: string | null;
  /** Primary market (claims are approved per market, §43). */
  market: string;
}

export function toBrain(raw: unknown): BrandBrain {
  const b = (raw ?? {}) as Partial<BrandBrain>;
  let market = 'US';
  try {
    market = b.market ? normalizeMarkets([b.market])[0]! : 'US';
  } catch {
    /* keep US */
  }
  return { tone: b.tone ?? null, colors: Array.isArray(b.colors) ? b.colors : [], prohibited: b.prohibited ?? null, disclosures: b.disclosures ?? null, cta: b.cta ?? null, market };
}

/** Field-by-field change set between two versions (what the event and the version row record). */
export function brainDiff(before: BrandBrain & { name?: string }, after: BrandBrain & { name?: string }): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ['name', 'tone', 'colors', 'prohibited', 'disclosures', 'cta', 'market'] as const) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}

export interface BrandBrainInput {
  name: string;
  tone?: string | null;
  colors?: string[];
  prohibited?: string | null;
  disclosures?: string | null;
  cta?: string | null;
  market?: string | null;
}

/**
 * Save the Brand Brain as a new version. A save that changes nothing creates no version. Emits
 * BRAND_BRAIN_VERSIONED with the diff (never PRODUCT_FACT_CHANGED: the brand is not a product fact).
 */
export async function updateBrandBrain(tx: Tx, ctx: TenantContext, input: BrandBrainInput, reason?: string | null) {
  assertCan(ctx, 'sku.edit');
  const name = input.name.trim();
  if (!name) throw new DomainError('INVALID', 'Brand name is required');
  let [b] = await tx`select id, name, brain, current_version_id from brands where workspace_id = ${ctx.workspaceId} order by created_at limit 1 for update`;
  if (!b) {
    // Creating the brand also creates version 1 (brands_initial_version trigger).
    [b] = await tx`insert into brands (workspace_id, name) values (${ctx.workspaceId}, ${name}) returning id, name, brain, current_version_id`;
  }
  const before = { ...toBrain(b!.brain), name: b!.name as string };
  const brain = toBrain({
    tone: input.tone?.trim() || null,
    colors: input.colors ?? [],
    prohibited: input.prohibited?.trim() || null,
    disclosures: input.disclosures?.trim() || null,
    cta: input.cta?.trim() || null,
    market: input.market ? normalizeMarkets([input.market])[0] : before.market,
  });
  const diff = brainDiff(before, { ...brain, name });
  if (!Object.keys(diff).length) {
    const [v] = await tx`select version from brand_brain_versions where id = ${b!.current_version_id}`;
    return { brandId: b!.id as string, versionId: b!.current_version_id as string, version: Number(v?.version ?? 1), changed: false };
  }
  const [n] = await tx`select coalesce(max(version), 0) + 1 as v from brand_brain_versions where brand_id = ${b!.id}`;
  const version = Number(n!.v);
  const [v] = await tx`insert into brand_brain_versions (workspace_id, brand_id, version, name, brain, diff, reason, created_by)
                       values (${ctx.workspaceId}, ${b!.id}, ${version}, ${name}, ${tx.json(brain as never)}, ${tx.json(diff as never)}, ${reason ?? null}, ${actorString(ctx)})
                       returning id`;
  await tx`update brands set name = ${name}, brain = ${tx.json(brain as never)}, current_version_id = ${v!.id} where id = ${b!.id}`;
  await emit(tx, ctx, 'BRAND_BRAIN_VERSIONED', { type: 'brand', id: b!.id as string }, { version, versionId: v!.id, diff, reason: reason ?? null });
  return { brandId: b!.id as string, versionId: v!.id as string, version, changed: true };
}

/** Current Brand Brain for a SKU's brand (falls back to the workspace's first brand). */
export async function brandBrainFor(tx: Tx, skuId: string): Promise<{ name: string; brain: BrandBrain; versionId: string | null } | null> {
  const [r] = await tx`select b.name, b.brain, b.current_version_id from skus s
                       join brands b on b.workspace_id = s.workspace_id and (b.id = s.brand_id or s.brand_id is null)
                       where s.id = ${skuId} order by (b.id = s.brand_id) desc nulls last, b.created_at limit 1`;
  return r ? { name: r.name as string, brain: toBrain(r.brain), versionId: (r.current_version_id as string) ?? null } : null;
}

export async function brandBrainHistory(tx: Tx, brandId: string) {
  return tx`select id, version, name, diff, reason, created_by, created_at from brand_brain_versions where brand_id = ${brandId} order by version desc limit 50`;
}
