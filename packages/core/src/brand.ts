import type { Tx } from '@arkiv/db';
import { DEFAULT_VOICE, DomainError, isLogicalVoice, normalizeMarkets, type LogicalVoice, type PlanCode } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { actorString } from './context';
import { emit } from './events';
import { planQuota } from './settings';

/**
 * Brand Brain (§16): "logo, colors, font rules, tone, visual references, prohibited aesthetics, approved
 * spokespeople/talent types, mandatory disclosures, CTA vocabulary and any brand-wide claims or restrictions", plus
 * the market the brand sells in and its voice. Stored as immutable versions with actor, reason and diff (§15
 * "atomic, versioned records with provenance"); brands.brain is the current copy and brands.current_version_id
 * points at its version. A workspace has as many brands as its plan allows (PLANS.brands); each SKU belongs to one.
 * SKU-level truth always wins over generic brand guidance.
 */
export interface BrandBrain {
  tone: string | null;
  colors: string[];
  /** Font rules: the heading and body typefaces the brand uses (names, as the merchant writes them). */
  fonts: { heading: string | null; body: string | null };
  /** The brand's logo (a `brand_logo` asset). */
  logoAssetId: string | null;
  /** Mood and style references (`brand_reference` assets). */
  visualReferenceAssetIds: string[];
  prohibited: string | null;
  /** Approved spokespeople / talent types (e.g. "women 30–45, natural makeup"). */
  talentTypes: string[];
  disclosures: string | null;
  /** The preferred call to action. */
  cta: string | null;
  /** Other calls to action the brand uses (CTA vocabulary). */
  ctaVocabulary: string[];
  /** Brand-wide claims (e.g. "cruelty-free"): proposed to each of the brand's products' Claims Vault for approval. */
  claims: string[];
  /** Brand-wide restrictions: words and topics none of the brand's ads may use. */
  restrictions: string[];
  /** Primary market (claims are approved per market, §43). */
  market: string;
  /** Logical voice-over voice (resolved per TTS provider by the Model Gateway). */
  voice: LogicalVoice;
}

const list = (v: unknown, max = 20, len = 120): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean).map((x) => x.slice(0, len)))].slice(0, max) : [];

export function toBrain(raw: unknown): BrandBrain {
  const b = (raw ?? {}) as Partial<BrandBrain>;
  let market = 'US';
  try {
    market = b.market ? normalizeMarkets([b.market])[0]! : 'US';
  } catch {
    /* keep US */
  }
  const fonts = (b.fonts ?? {}) as Partial<BrandBrain['fonts']>;
  return {
    tone: b.tone ?? null,
    colors: Array.isArray(b.colors) ? b.colors : [],
    fonts: { heading: fonts.heading?.trim() || null, body: fonts.body?.trim() || null },
    logoAssetId: typeof b.logoAssetId === 'string' ? b.logoAssetId : null,
    visualReferenceAssetIds: list(b.visualReferenceAssetIds, 12, 64),
    prohibited: b.prohibited ?? null,
    talentTypes: list(b.talentTypes, 10),
    disclosures: b.disclosures ?? null,
    cta: b.cta ?? null,
    ctaVocabulary: list(b.ctaVocabulary, 12, 40),
    claims: list(b.claims, 20, 200),
    restrictions: list(b.restrictions, 20, 120),
    market,
    voice: isLogicalVoice(b.voice) ? b.voice : DEFAULT_VOICE,
  };
}

const BRAIN_KEYS = ['name', 'tone', 'colors', 'fonts', 'logoAssetId', 'visualReferenceAssetIds', 'prohibited', 'talentTypes', 'disclosures', 'cta', 'ctaVocabulary', 'claims', 'restrictions', 'market', 'voice'] as const;

/** Field-by-field change set between two versions (what the event and the version row record). */
export function brainDiff(before: BrandBrain & { name?: string }, after: BrandBrain & { name?: string }): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of BRAIN_KEYS) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}

export interface BrandBrainInput {
  /** The brand to edit (multi-brand plans); the workspace's first brand when omitted. */
  brandId?: string | null;
  name: string;
  tone?: string | null;
  colors?: string[];
  prohibited?: string | null;
  disclosures?: string | null;
  cta?: string | null;
  market?: string | null;
  voice?: string | null;
  // Fields the form may leave out keep their current value (undefined), an empty value clears them.
  fonts?: { heading?: string | null; body?: string | null } | null;
  logoAssetId?: string | null;
  visualReferenceAssetIds?: string[];
  talentTypes?: string[];
  ctaVocabulary?: string[];
  claims?: string[];
  restrictions?: string[];
}

/** The brand a Brand Brain action is about: the named one (in this workspace) or the first. Locked for the update. */
async function brandRow(tx: Tx, ctx: TenantContext, brandId: string | null | undefined) {
  const [b] = brandId
    ? await tx`select id, name, brain, current_version_id from brands where id = ${brandId} and workspace_id = ${ctx.workspaceId} for update`
    : await tx`select id, name, brain, current_version_id from brands where workspace_id = ${ctx.workspaceId} order by created_at limit 1 for update`;
  if (brandId && !b) throw new DomainError('NOT_FOUND', 'Brand not found');
  return b ?? null;
}

/**
 * Save the Brand Brain as a new version. A save that changes nothing creates no version. Emits
 * BRAND_BRAIN_VERSIONED with the diff (never PRODUCT_FACT_CHANGED: the brand is not a product fact). Brand-wide
 * claims that are new in this version are proposed to each of the brand's products (their Claims Vault decides).
 */
export async function updateBrandBrain(tx: Tx, ctx: TenantContext, input: BrandBrainInput, reason?: string | null) {
  assertCan(ctx, 'sku.edit');
  const name = input.name.trim();
  if (!name) throw new DomainError('INVALID', 'Brand name is required');
  let b = await brandRow(tx, ctx, input.brandId);
  if (!b) {
    // Creating the brand also creates version 1 (brands_initial_version trigger).
    b = (await tx`insert into brands (workspace_id, name) values (${ctx.workspaceId}, ${name}) returning id, name, brain, current_version_id`)[0]!;
  }
  const before = { ...toBrain(b!.brain), name: b!.name as string };
  // Asset references must be this workspace's own brand files.
  const assets = [...(input.logoAssetId ? [input.logoAssetId] : []), ...(input.visualReferenceAssetIds ?? [])];
  if (assets.length) {
    const found = await tx`select id from assets where id = any(${assets}::uuid[]) and workspace_id = ${ctx.workspaceId} and kind in ('brand_logo', 'brand_reference') and deleted_at is null`;
    if (found.length !== new Set(assets).size) throw new DomainError('INVALID', 'That file isn’t one of this brand’s uploads.');
  }
  const brain = toBrain({
    tone: input.tone?.trim() || null,
    colors: input.colors ?? [],
    prohibited: input.prohibited?.trim() || null,
    disclosures: input.disclosures?.trim() || null,
    cta: input.cta?.trim() || null,
    market: input.market ? normalizeMarkets([input.market])[0] : before.market,
    voice: input.voice ?? before.voice,
    fonts: input.fonts === undefined ? before.fonts : { heading: input.fonts?.heading ?? null, body: input.fonts?.body ?? null },
    logoAssetId: input.logoAssetId === undefined ? before.logoAssetId : input.logoAssetId,
    visualReferenceAssetIds: input.visualReferenceAssetIds ?? before.visualReferenceAssetIds,
    talentTypes: input.talentTypes ?? before.talentTypes,
    ctaVocabulary: input.ctaVocabulary ?? before.ctaVocabulary,
    claims: input.claims ?? before.claims,
    restrictions: input.restrictions ?? before.restrictions,
  });
  if (input.voice && !isLogicalVoice(input.voice)) throw new DomainError('INVALID', 'Unknown voice');
  const diff = brainDiff(before, { ...brain, name });
  if (!Object.keys(diff).length) {
    const [v] = await tx`select version from brand_brain_versions where id = ${b!.current_version_id}`;
    return { brandId: b!.id as string, versionId: b!.current_version_id as string, version: Number(v?.version ?? 1), changed: false, claimsProposed: 0 };
  }
  const [n] = await tx`select coalesce(max(version), 0) + 1 as v from brand_brain_versions where brand_id = ${b!.id}`;
  const version = Number(n!.v);
  const [v] = await tx`insert into brand_brain_versions (workspace_id, brand_id, version, name, brain, diff, reason, created_by)
                       values (${ctx.workspaceId}, ${b!.id}, ${version}, ${name}, ${tx.json(brain as never)}, ${tx.json(diff as never)}, ${reason ?? null}, ${actorString(ctx)})
                       returning id`;
  await tx`update brands set name = ${name}, brain = ${tx.json(brain as never)}, current_version_id = ${v!.id} where id = ${b!.id}`;
  await emit(tx, ctx, 'BRAND_BRAIN_VERSIONED', { type: 'brand', id: b!.id as string }, { version, versionId: v!.id, diff, reason: reason ?? null });
  const added = brain.claims.filter((c) => !before.claims.some((x) => x.toLowerCase() === c.toLowerCase()));
  const claimsProposed = added.length ? await proposeBrandClaims(tx, ctx, b!.id as string, added) : 0;
  return { brandId: b!.id as string, versionId: v!.id as string, version, changed: true, claimsProposed };
}

/**
 * Brand-wide claims reach each product of the brand as a claim of its own (§17 claims are per SKU): the rules set
 * its status and the merchant approves it per product and market — a brand claim is never approved for a product
 * automatically. Returns the number of product claims proposed.
 */
export async function proposeBrandClaims(tx: Tx, ctx: TenantContext, brandId: string, wordings: readonly string[], skuIds?: readonly string[]): Promise<number> {
  if (!wordings.length) return 0;
  // Loaded lazily: claims → experiment-state → … would otherwise import this module in a cycle.
  const { proposeClaim } = await import('./claims');
  const skus = skuIds?.length
    ? await tx`select id from skus where id = any(${[...skuIds]}::uuid[]) and brand_id = ${brandId} and workspace_id = ${ctx.workspaceId}`
    : await tx`select id from skus where brand_id = ${brandId} and workspace_id = ${ctx.workspaceId} and status in ('active', 'out_of_stock', 'needs_input', 'analyzing')`;
  let n = 0;
  for (const s of skus) {
    for (const w of wordings) {
      await proposeClaim(tx, ctx, s.id as string, { wording: w, origin: 'merchant', sourceText: 'Brand Brain: brand-wide claim' });
      n++;
    }
  }
  return n;
}

/** The workspace's brands, oldest first, with how many products each has. */
export async function listBrands(tx: Tx) {
  return tx`select b.id, b.name, b.brain, b.current_version_id, b.created_at,
                   (select count(*)::int from skus s where s.brand_id = b.id and s.workspace_id = b.workspace_id and s.status <> 'archived') as skus
            from brands b order by b.created_at`;
}

/**
 * Add a brand (multi-brand plans): within the plan's brand allowance (PLANS.brands, settings-aware), counted under
 * the workspace row lock so two concurrent adds can't both pass.
 */
export async function createBrand(tx: Tx, ctx: TenantContext, name: string): Promise<{ brandId: string }> {
  assertCan(ctx, 'integration.manage'); // Owner/Admin: a brand is a plan-counted resource
  const n = name.trim();
  if (!n) throw new DomainError('INVALID', 'Brand name is required');
  const [w] = await tx`select plan_code from workspaces where id = ${ctx.workspaceId} for update`;
  const quota = await planQuota(tx, (w?.plan_code as PlanCode | null) ?? null);
  const [c] = await tx`select count(*)::int as n from brands where workspace_id = ${ctx.workspaceId}`;
  if (Number(c!.n) >= quota.brands) throw new DomainError('PAYMENT_REQUIRED', `Your plan includes ${quota.brands} brand${quota.brands === 1 ? '' : 's'}. Upgrade to add another.`, { limit: 'brands' });
  const [dup] = await tx`select 1 from brands where workspace_id = ${ctx.workspaceId} and lower(name) = lower(${n})`;
  if (dup) throw new DomainError('CONFLICT', 'You already have a brand with that name.');
  const [b] = await tx`insert into brands (workspace_id, name) values (${ctx.workspaceId}, ${n}) returning id`;
  return { brandId: b!.id as string };
}

/**
 * Move a product to another of the workspace's brands (the merchant's choice per SKU, §16). Its product facts
 * follow (their brand_id), and the new brand's brand-wide claims are proposed to it.
 */
export async function assignSkuBrand(tx: Tx, ctx: TenantContext, skuId: string, brandId: string) {
  assertCan(ctx, 'sku.edit');
  const [b] = await tx`select id, brain from brands where id = ${brandId} and workspace_id = ${ctx.workspaceId}`;
  if (!b) throw new DomainError('NOT_FOUND', 'Brand not found');
  const [s] = await tx`update skus set brand_id = ${brandId} where id = ${skuId} and workspace_id = ${ctx.workspaceId} and brand_id is distinct from ${brandId} returning id`;
  if (!s) return { changed: false };
  await tx`update product_facts set brand_id = ${brandId} where sku_id = ${skuId} and workspace_id = ${ctx.workspaceId}`;
  await proposeBrandClaims(tx, ctx, brandId, toBrain(b.brain).claims, [skuId]);
  return { changed: true };
}

/** Current Brand Brain for a SKU's brand (falls back to the workspace's first brand). */
export async function brandBrainFor(tx: Tx, skuId: string): Promise<{ id: string; name: string; brain: BrandBrain; versionId: string | null } | null> {
  const [r] = await tx`select b.id, b.name, b.brain, b.current_version_id from skus s
                       join brands b on b.workspace_id = s.workspace_id and (b.id = s.brand_id or s.brand_id is null)
                       where s.id = ${skuId} order by (b.id = s.brand_id) desc nulls last, b.created_at limit 1`;
  return r ? { id: r.id as string, name: r.name as string, brain: toBrain(r.brain), versionId: (r.current_version_id as string) ?? null } : null;
}

export async function brandBrainHistory(tx: Tx, brandId: string) {
  return tx`select id, version, name, diff, reason, created_by, created_at from brand_brain_versions where brand_id = ${brandId} order by version desc limit 50`;
}
