import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, type Angle } from '@arkiv/shared';
import type { ContentPart } from '@arkiv/providers';
import { brandBrainFor } from './brand';
import { AD_PLATFORMS, listClaims, renderableClaims, type ClaimScope } from './claims';
import { classifyClaim, scanCreativeText, scanPasses } from './compliance';
import type { TenantContext } from './context';
import { emit } from './events';
import { ConceptSet, StoryboardPlan, type Proposal } from './intel-schemas';
import { mockConcepts, mockStoryboard, type ProductContext } from './mock-intel';
import { llmJson } from './model-gateway';
import { currentFacts, factText } from './product-truth';
import { CONCEPTS_SYSTEM, STORYBOARD_SYSTEM } from './prompts';

/**
 * ContextBuilder (§22, §33): a curated, bounded Context Packet — never raw DB access. Everything comes through
 * tenant-scoped reads, so a packet can only contain this workspace's rows (plan 02 §3 layer 6).
 */
export async function buildContext(tx: Tx, skuId: string) {
  const [sku] = await tx`select * from skus where id = ${skuId}`;
  if (!sku) throw new DomainError('NOT_FOUND', 'Product not found');
  const facts = await currentFacts(tx, skuId);
  const claims = await listClaims(tx, skuId);
  // Only claims usable wherever this ad will be published (every export platform, the brand's market) are
  // offered as APPROVED; anything narrower would pass here and then fail claims QA after render spend.
  const usable = new Set((await renderableClaims(tx, skuId, { platforms: AD_PLATFORMS })).map((c) => c.id));
  const themes = await tx`select id, label, signal_type, prevalence, sample_size from customer_themes where sku_id = ${skuId}
                          order by prevalence * relevance desc limit 6`;
  const snippets = await tx`select text from customer_signals where sku_id = ${skuId} order by observed_at desc nulls last limit 8`;
  const coverage = await tx`select genes->>'angle' as angle, state, count(*)::int as n from experiments where sku_id = ${skuId}
                            group by 1, 2`;
  const learnings = await tx`select id, statement, state, scope_platform, confidence from learnings where sku_id = ${skuId}
                             and state in ('DIRECTIONAL','ACTIONABLE','WEAKENING') and not confounded order by confidence desc limit 6`;
  const ingredients = (factText(facts, 'key_ingredients') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const brand = await brandBrainFor(tx, skuId);
  const approvedRows = claims.filter((c) => usable.has(c.id));
  // Stable ids for every packet item, so a proposal can cite what it rests on (rationale ids, §38).
  const FACT_KEYS = ['category', 'size', 'price', 'texture', 'format', 'key_ingredients', 'ingredients'];
  const factIds = Object.fromEntries(FACT_KEYS.filter((k) => facts[k]).map((k) => [k, facts[k]!.value.id]));
  const productContext: ProductContext = {
    name: sku.name as string,
    category: (factText(facts, 'category') ?? sku.category ?? 'skincare') as string,
    sizeText: factText(facts, 'size'),
    texture: factText(facts, 'texture'),
    ingredients,
    approvedClaims: approvedRows.map((c) => (c.mandatoryQualifier ? `${c.preferredWording} ${c.mandatoryQualifier}` : c.preferredWording)),
    themes: themes.map((t) => ({ label: t.label as string, signalType: t.signal_type as string })),
    testedAngles: coverage.map((c) => c.angle as string).filter(Boolean),
    rationaleIds: { themes: themes.map((t) => t.id as string), claims: approvedRows.map((c) => c.id), facts: Object.values(factIds), learnings: learnings.map((l) => l.id as string) },
  };
  const packet = {
    product: {
      name: productContext.name,
      category: productContext.category,
      size: productContext.sizeText,
      price: factText(facts, 'price'),
      texture: productContext.texture,
      format: factText(facts, 'format'),
      keyIngredients: ingredients,
      factIds,
    },
    claims: {
      APPROVED: approvedRows.map((c, i) => ({ id: c.id, wording: productContext.approvedClaims[i]! })),
      NEEDS_REVIEW_DO_NOT_USE: claims.filter((c) => c.status === 'MERCHANT_REVIEW_REQUIRED' || ((c.status === 'VERIFIED' || c.status === 'VERIFIED_WITH_QUALIFIER') && !usable.has(c.id))).map((c) => c.preferredWording),
      BLOCKED_NEVER_USE: claims.filter((c) => c.status === 'BLOCKED' || c.status === 'RESTRICTED').map((c) => c.preferredWording),
    },
    customerThemes: themes.map((t) => ({ id: t.id, label: t.label, type: t.signal_type, prevalence: Number(t.prevalence), n: t.sample_size })),
    coverage: coverage.map((c) => ({ angle: c.angle, state: c.state, count: c.n })),
    learnings: learnings.map((l) => ({ id: l.id, statement: l.statement, state: l.state, platform: l.scope_platform })),
    // The merchant's own Brand Brain (versioned): shapes voice and visuals, never overrides claim rules.
    brand: brand
      ? { name: brand.name, tone: brand.brain.tone, neverShowOrSay: brand.brain.prohibited, requiredDisclosures: brand.brain.disclosures, preferredCta: brand.brain.cta, colors: brand.brain.colors, market: brand.brain.market }
      : null,
    platform: 'TikTok + Instagram Reels (9:16)',
    objective: 'Find the next creative test worth running for this SKU',
  };
  // Product and brand names are names, not claims ("Glow Serum" makes no glow claim).
  const names = [sku.name as string, brand?.name ?? null];
  const r = productContext.rationaleIds!;
  const packetIds = new Set([...r.themes, ...r.claims, ...r.facts, ...r.learnings]);
  return { sku, facts, productContext, packet, packetIds, names, snippets: snippets.map((s) => s.text as string), brandBrainVersionId: brand?.versionId ?? null };
}

/**
 * Hard gates on a proposal before a merchant ever sees it (§20: gates happen before scoring). Rationale ids are
 * kept only when they name an item of the packet the proposal was drafted from (`packetIds`).
 */
export function gateProposal(p: Proposal, approved: string[], names: (string | null | undefined)[] = [], packetIds?: ReadonlySet<string>): { ok: boolean; reasons: string[]; cleaned: Proposal } {
  const reasons: string[] = [];
  const rationaleIds = [...new Set(p.rationaleIds ?? [])].filter((id) => {
    const known = !packetIds || packetIds.has(id);
    if (!known) reasons.push(`unknown rationale id dropped: ${id.slice(0, 40)}`);
    return known;
  });
  const vault = approved.map((w, i) => ({ id: String(i), wording: w }));
  // Only customer-facing copy is claims-scanned; hypothesis/body are internal strategy notes. A hook that makes a
  // product claim no approved claim covers would be refused by claims QA after render spend, so it goes now.
  const cleanHooks = p.hookOptions.filter((h) => {
    const scan = scanCreativeText([h], vault, { names });
    if (!scan.ok) reasons.push(`hook removed: ${scan.violations[0]!.reason}`);
    else if (scan.unmapped.length) reasons.push(`hook removed: “${h}” makes a claim that isn’t approved`);
    return scanPasses(scan);
  });
  const blockedStrategy = [p.bodyStrategy, p.hypothesis].some((t) => classifyClaim(t).status === 'BLOCKED');
  if (blockedStrategy) reasons.push('strategy relies on a blocked claim');
  const cleanClaims = p.claimWordings.filter((w) => {
    const ok = approved.some((a) => a.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(a.toLowerCase()));
    if (!ok) reasons.push(`claim not approved: "${w}"`);
    return ok;
  });
  while (cleanHooks.length < 3) cleanHooks.push(['A closer look at the texture', 'Where this fits in your routine', 'The finish, up close'][cleanHooks.length]!);
  return { ok: !blockedStrategy, reasons, cleaned: { ...p, hookOptions: cleanHooks.slice(0, 3), claimWordings: cleanClaims, rationaleIds } };
}

/** Three concepts must differ in hypothesis (angle or primary variable), not just copy (§13). */
export function conceptsAreDistinct(ps: Proposal[]): boolean {
  const keys = new Set(ps.map((p) => `${p.angle}|${p.primaryVariable}`));
  const angles = new Set(ps.map((p) => p.angle as Angle));
  return keys.size === ps.length && angles.size >= 2;
}

export interface ConceptRun {
  ctx: TenantContext;
  token: string;
  skuId: string;
  projectId: string;
  batch: number;
}

/** Output budget of one concept-set call; reservations for a concept batch must cover at least this. */
export const CONCEPTS_MAX_TOKENS = 6000;

export async function generateConcepts(run: ConceptRun) {
  const { productContext, packet, packetIds, brandBrainVersionId, names } = await withTenant(run.ctx.workspaceId, (tx) => buildContext(tx, run.skuId));
  const content: ContentPart[] = [
    { type: 'text', text: `Context packet (JSON):\n${JSON.stringify(packet)}` },
    { type: 'text', text: run.batch > 1 ? `This is request #${run.batch}: the merchant wants different directions from the earlier set.` : 'Propose the first three tests.' },
  ];
  let attempt = 0;
  let res: Awaited<ReturnType<typeof llmJson<ConceptSet>>> | null = null;
  let gated: ReturnType<typeof gateProposal>[] = [];
  while (attempt < 2) {
    attempt++;
    res = await llmJson({
      ctx: run.ctx,
      token: run.token,
      task: 'creative_director.concepts',
      subject: { type: 'project', id: run.projectId },
      system: CONCEPTS_SYSTEM,
      content,
      schema: ConceptSet,
      mock: () => mockConcepts(productContext, run.batch),
      effort: 'high',
      maxTokens: CONCEPTS_MAX_TOKENS,
    });
    gated = res.data.concepts.map((c) => gateProposal(c, productContext.approvedClaims, names, packetIds));
    const valid = gated.filter((g) => g.ok);
    if (valid.length === 3 && conceptsAreDistinct(valid.map((v) => v.cleaned))) break;
    content.push({ type: 'text', text: `Previous attempt was rejected by compliance/diversity gates: ${gated.flatMap((g) => g.reasons).join('; ') || 'concepts too similar'}. Fix and return three distinct compliant concepts.` });
  }
  const valid = gated.filter((g) => g.ok);
  if (!valid.length) throw new DomainError('GATE_BLOCKED', 'We couldn’t produce compliant concepts for this product. Our team has been notified.');
  return withTenant(run.ctx.workspaceId, async (tx) => {
    const ids: string[] = [];
    const letters = ['A', 'B', 'C'] as const;
    const pick = Math.min(res!.data.pickIndex, valid.length - 1);
    for (const [i, g] of valid.entries()) {
      const [c] = await tx`
        insert into concepts (workspace_id, sku_id, project_id, batch, idx, proposal, is_pick, pick_reason, gate_results, prompt_version, model, brand_brain_version_id)
        values (${run.ctx.workspaceId}, ${run.skuId}, ${run.projectId}, ${run.batch}, ${letters[i]!}, ${tx.json(g.cleaned as never)},
          ${i === pick}, ${i === pick ? res!.data.pickReason : null}, ${tx.json({ reasons: g.reasons } as never)}, ${res!.promptVersion}, ${res!.model}, ${brandBrainVersionId})
        on conflict (workspace_id, project_id, batch, idx) do update set proposal = excluded.proposal
        returning id`;
      ids.push(c!.id as string);
    }
    await emit(tx, run.ctx, 'CONCEPTS_READY', { type: 'project', id: run.projectId }, { count: ids.length, batch: run.batch, honestShortfall: ids.length < 3 });
    return ids;
  });
}

export interface StoryboardRun {
  ctx: TenantContext;
  token: string;
  skuId: string;
  projectId: string;
  conceptId: string;
}

/**
 * Generated-interaction scenes per standard 15s output. With the 25% QA retry reserve this keeps a standard test
 * well inside the §5 ceiling; further interaction scenes become hybrids (generated setting + exact product).
 */
export const MAX_GENERATIVE_SCENES = 4;
/** Natural voice-over pace (words per second) and the fastest we fit a line to its scene. */
const VO_WORDS_PER_SECOND = 2.6;
const VO_MAX_TEMPO = 1.35;

/** Normalize a plan to exactly 15s and enforce scene-level compliance before frames are generated. */
export function normalizePlan(plan: StoryboardPlan, approved: string[], names: (string | null | undefined)[] = []): StoryboardPlan {
  const total = plan.scenes.reduce((s, x) => s + x.durationMs, 0);
  const scale = 15000 / total;
  let acc = 0;
  let generative = 0;
  const scenes = plan.scenes.map((s, i) => {
    const d = i === plan.scenes.length - 1 ? 15000 - acc : Math.max(1000, Math.round((s.durationMs * scale) / 250) * 250);
    acc += d;
    // Close-ups of packaging are always exact-product composites (§23).
    let mode = s.purpose === 'product_reveal' || s.purpose === 'cta' ? 'STRICT_COMPOSITE' : s.productionMode;
    if (mode === 'GENERATIVE_INTERACTION' && ++generative > MAX_GENERATIVE_SCENES) mode = 'HYBRID';
    return { ...s, durationMs: d, productionMode: mode };
  });
  const lines = scenes.flatMap((s) => [s.spokenLine, s.overlayText]).filter(Boolean) as string[];
  const scan = scanCreativeText([...lines, plan.hook], approved.map((w, i) => ({ id: String(i), wording: w })), { names });
  if (!scanPasses(scan)) {
    const problems = [...scan.violations.map((v) => `"${v.text}" (${v.reason})`), ...scan.unmapped.map((u) => `"${u}" (makes a product claim that isn't approved)`)];
    throw new DomainError('GATE_BLOCKED', `Storyboard failed claims check: ${problems.join('; ')}`, { violations: scan.violations, unmapped: scan.unmapped });
  }
  // Every spoken word must fit the 15 seconds (captions follow the speech; a line is never cut off, §25 check 4).
  const words = scenes.reduce((n, s) => n + (s.spokenLine ?? '').split(/\s+/).filter(Boolean).length, 0);
  if (words / (VO_WORDS_PER_SECOND * VO_MAX_TEMPO) > 15) {
    throw new DomainError('GATE_BLOCKED', `Storyboard failed the timing check: ${words} spoken words don't fit 15 seconds. Shorten the spoken lines.`);
  }
  return { ...plan, scenes };
}

export async function planStoryboard(run: StoryboardRun): Promise<{ plan: StoryboardPlan; promptVersion: string; model: string; brandBrainVersionId: string | null }> {
  const { productContext, packet, concept, brandBrainVersionId, names } = await withTenant(run.ctx.workspaceId, async (tx) => {
    const c = await buildContext(tx, run.skuId);
    const [row] = await tx`select proposal from concepts where id = ${run.conceptId}`;
    if (!row) throw new DomainError('NOT_FOUND', 'Concept not found');
    return { ...c, concept: row.proposal as Proposal };
  });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llmJson({
      ctx: run.ctx,
      token: run.token,
      task: 'creative_director.storyboard',
      subject: { type: 'project', id: run.projectId },
      system: STORYBOARD_SYSTEM,
      content: [
        { type: 'text', text: `Context packet:\n${JSON.stringify(packet)}` },
        { type: 'text', text: `Approved concept:\n${JSON.stringify(concept)}` },
        ...(attempt ? [{ type: 'text' as const, text: `The previous storyboard failed the claims check: ${(lastErr as Error).message}. Use only approved or neutral wording.` }] : []),
      ],
      schema: StoryboardPlan,
      mock: () => mockStoryboard(productContext, concept),
      effort: 'high',
      maxTokens: 5000,
    });
    try {
      return { plan: normalizePlan(res.data, productContext.approvedClaims, names), promptVersion: res.promptVersion, model: res.model, brandBrainVersionId };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Claims usable for a render scope (used by QA, scene edits, hook variants and Creator Packs). Defaults to every
 * platform a standard ad is exported to, in the brand's market.
 */
export async function allowedClaimTexts(tx: Tx, skuId: string, scope: ClaimScope = { platforms: AD_PLATFORMS }) {
  return (await renderableClaims(tx, skuId, scope)).map((c) => ({ id: c.id, wording: c.preferredWording, qualifier: c.mandatoryQualifier }));
}
