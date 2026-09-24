import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, type PortfolioSlot, type SkuMaturity } from '@arkiv/shared';
import { assertCan } from './authz';
import { classifyClaim } from './compliance';
import type { TenantContext } from './context';
import { authorize, settle } from './cost-governor';
import { buildContext, gateProposal, isIngredientLed, UNVERIFIED_INGREDIENTS_REASON } from './creative-director';
import { emit } from './events';
import { ConceptSet, type Proposal } from './intel-schemas';
import { mockConcepts } from './mock-intel';
import { llmJson, routedLines } from './model-gateway';
import { CONCEPTS_SYSTEM } from './prompts';

/**
 * RecommendationService (§20, §33): hard gates → deterministic Opportunity Score → portfolio composition →
 * de-duplication. The score can never override a gate. Opus only proposes candidates.
 */

export const WEIGHTS = {
  customerRelevance: 0.22,
  adjacentSignal: 0.18,
  coverageGap: 0.16,
  fatigueNeed: 0.12,
  learnability: 0.12,
  feasibility: 0.08,
  platformFit: 0.07,
  cogsEfficiency: 0.05,
} as const;

export const PORTFOLIO: Record<SkuMaturity, Record<PortfolioSlot, number>> = {
  COLD: { EXPLOIT: 0.2, EXPAND: 0.4, EXPLORE: 0.4 },
  DEVELOPING: { EXPLOIT: 0.4, EXPAND: 0.35, EXPLORE: 0.25 },
  MATURE: { EXPLOIT: 0.5, EXPAND: 0.3, EXPLORE: 0.2 },
};

/** TikTok beauty guidance favours reviews, problem/solution, tutorials, routines, comment replies [R7]. */
const NATIVE_ANGLES = new Set(['TEXTURE_SENSORY', 'ROUTINE', 'APPLICATION_HOWTO', 'PROBLEM_SOLUTION', 'FAQ_RESPONSE', 'OBJECTION_HANDLING', 'SOCIAL_PROOF', 'MYTH_BUSTING']);
const COGS_SCORE: Record<Proposal['estimatedGenerationClass'], number> = { remix: 1, hybrid_short: 0.75, generative_short: 0.5, premium: 0.15 };

export interface ScoringContext {
  themes: { id?: string; label: string; prevalence: number }[];
  angleTests: Map<string, number>;
  learnings: { id?: string; angle: string; state: string; positive: boolean }[];
  fatiguingAngles: Set<string>;
  recentKeys: Set<string>;
  fidelityConfidence: number;
  approvedClaims: string[];
  hasRealAssets: boolean;
  /** Evidence basis of this week's plan (§31); sets the starting confidence. */
  basis?: 'performance' | 'context_limited' | 'cold_start';
  /** False when the SKU has no sourced ingredient list: ingredient-led tests are gated (§42). */
  ingredientsVerified?: boolean;
}

export interface Scored {
  proposal: Proposal;
  slot: PortfolioSlot;
  score: number;
  breakdown: Record<keyof typeof WEIGHTS, number>;
  gates: { passed: boolean; reasons: string[] };
  /** Packet items the proposal cites plus those the score actually used (matched theme, angle learnings), §38. */
  rationaleIds: string[];
  /** How much evidence stands behind the recommendation (0–1): basis, learnings on its angle, a matched theme. */
  confidence: number;
}

const BASIS_CONFIDENCE = { performance: 0.55, context_limited: 0.4, cold_start: 0.3 } as const;
const LEARNING_CONFIDENCE: Record<string, number> = { ACTIONABLE: 0.2, DIRECTIONAL: 0.1, WEAKENING: -0.1, INVALIDATED: -0.2 };

/**
 * Recommendation confidence (§38): starts from the plan's evidence basis, moves with this angle's learnings
 * (actionable/directional up, weakening/invalidated down; a negative learning inverts), and a little with a
 * matched customer theme. A heuristic summary of evidence, not a probability of winning.
 */
export function recommendationConfidence(basis: ScoringContext['basis'], learnings: ScoringContext['learnings'], themeMatched: boolean): number {
  let c: number = BASIS_CONFIDENCE[basis ?? 'cold_start'];
  for (const l of learnings) c += (LEARNING_CONFIDENCE[l.state] ?? 0) * (l.positive ? 1 : -1);
  if (themeMatched) c += 0.1;
  return Math.round(Math.max(0.05, Math.min(0.95, c)) * 100) / 100;
}

const overlap = (a: string, b: string) => {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wb = b.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  return wb.filter((w) => wa.has(w)).length / Math.max(1, Math.min(wa.size, wb.length));
};

export function hardGates(p: Proposal, s: ScoringContext): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const h of p.hookOptions) {
    const c = classifyClaim(h);
    if (c.status === 'BLOCKED' || c.status === 'RESTRICTED') reasons.push(`blocked claim in hook “${h}”`);
  }
  for (const w of p.claimWordings) if (!s.approvedClaims.some((a) => a.toLowerCase().includes(w.toLowerCase()))) reasons.push(`claim lacks approval/evidence: “${w}”`);
  if (s.fidelityConfidence < 0.3 && p.estimatedGenerationClass !== 'remix') reasons.push('product fidelity too uncertain for generated interaction; add clearer photos');
  if (s.recentKeys.has(`${p.angle}|${p.hookMechanism}`)) reasons.push('near-duplicate of a test run in the last 21 days');
  if (p.estimatedGenerationClass === 'premium') reasons.push('premium production exceeds the standard Creative Test cost ceiling');
  if (p.treatment === 'RAW_UGC' && !s.hasRealAssets) reasons.push('needs real footage/assets that are not in the library');
  if (p.proofMechanism === 'BEFORE_AFTER_RESTRICTED') reasons.push('before/after requires separate policy review');
  if (s.ingredientsVerified === false && isIngredientLed(p)) reasons.push(UNVERIFIED_INGREDIENTS_REASON);
  return { passed: reasons.length === 0, reasons };
}

export function slotFor(p: Proposal, s: ScoringContext): PortfolioSlot {
  const positive = s.learnings.some((l) => l.angle === p.angle && l.positive && (l.state === 'ACTIONABLE' || l.state === 'DIRECTIONAL'));
  if (positive) return 'EXPLOIT';
  if ((s.angleTests.get(p.angle) ?? 0) > 0 || p.riskProfile === 'adjacent' || p.riskProfile === 'lower_risk') return 'EXPAND';
  return 'EXPLORE';
}

export function scoreProposal(p: Proposal, s: ScoringContext): Scored {
  const gates = hardGates(p, s);
  const maxTests = Math.max(1, ...s.angleTests.values());
  const theme = s.themes.map((t) => ({ t, o: overlap(t.label, `${p.customerTension} ${p.hypothesis}`) })).sort((a, b) => b.o * b.t.prevalence - a.o * a.t.prevalence)[0];
  const learn = s.learnings.filter((l) => l.angle === p.angle);
  const b = {
    customerRelevance: theme && theme.o > 0 ? Math.min(1, 0.4 + theme.o * 0.3 + theme.t.prevalence * 0.6) : p.customerTensionSource === 'reviews' ? 0.6 : 0.35,
    // Shrunk historical signal: directional counts half, actionable full; invalidated counts against.
    adjacentSignal: Math.max(0, Math.min(1, 0.4 + learn.reduce((acc, l) => acc + (l.state === 'ACTIONABLE' ? 0.4 : l.state === 'DIRECTIONAL' ? 0.2 : l.state === 'INVALIDATED' ? -0.3 : 0) * (l.positive ? 1 : -1), 0))),
    coverageGap: 1 - (s.angleTests.get(p.angle) ?? 0) / maxTests / 1.25,
    fatigueNeed: s.fatiguingAngles.has(p.angle) ? 0.9 : s.fatiguingAngles.size ? 0.5 : 0.2,
    learnability: p.primaryVariable === 'hook' ? 1 : p.riskProfile === 'exploratory' ? 0.45 : 0.75,
    feasibility: Math.min(1, s.fidelityConfidence * (p.estimatedGenerationClass === 'generative_short' ? 0.85 : 1) + 0.1),
    platformFit: NATIVE_ANGLES.has(p.angle) ? 1 : 0.55,
    cogsEfficiency: COGS_SCORE[p.estimatedGenerationClass],
  };
  const score = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((acc, k) => acc + WEIGHTS[k] * b[k], 0);
  const themeMatched = !!theme && theme.o > 0;
  const used = [...(themeMatched && theme!.t.id ? [theme!.t.id] : []), ...learn.map((l) => l.id).filter((x): x is string => !!x)];
  const rationaleIds = [...new Set([...(p.rationaleIds ?? []), ...used])].slice(0, 12);
  return { proposal: p, slot: slotFor(p, s), score: gates.passed ? score : 0, breakdown: b, gates, rationaleIds, confidence: recommendationConfidence(s.basis, learn, themeMatched) };
}

/** Pick N from scored candidates honouring the maturity portfolio (§20) — the score cannot override a gate. */
export function composePortfolio(scored: Scored[], maturity: SkuMaturity, n = 3): Scored[] {
  const eligible = scored.filter((s) => s.gates.passed).sort((a, b) => b.score - a.score);
  const quota = PORTFOLIO[maturity];
  const want: Record<PortfolioSlot, number> = {
    EXPLOIT: Math.round(quota.EXPLOIT * n),
    EXPAND: Math.round(quota.EXPAND * n),
    EXPLORE: Math.round(quota.EXPLORE * n),
  };
  // Cold SKUs have nothing to exploit (§48 cold start: never pretend performance learning exists).
  if (!eligible.some((e) => e.slot === 'EXPLOIT')) {
    want.EXPAND += want.EXPLOIT;
    want.EXPLOIT = 0;
  }
  const out: Scored[] = [];
  const seen = new Set<string>();
  for (const slot of ['EXPLOIT', 'EXPAND', 'EXPLORE'] as PortfolioSlot[]) {
    for (const e of eligible.filter((x) => x.slot === slot)) {
      if (out.filter((o) => o.slot === slot).length >= want[slot]) break;
      const key = `${e.proposal.angle}|${e.proposal.hookMechanism}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  for (const e of eligible) {
    if (out.length >= n) break;
    const key = `${e.proposal.angle}|${e.proposal.hookMechanism}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out.slice(0, n);
}

async function scoringContext(tx: Tx, skuId: string): Promise<ScoringContext & { maturity: SkuMaturity; basis: NonNullable<ScoringContext['basis']> }> {
  const [sku] = await tx`select maturity, fidelity_confidence from skus where id = ${skuId}`;
  const themes = await tx`select id, label, prevalence from customer_themes where sku_id = ${skuId}`;
  const tests = await tx`select genes->>'angle' as angle, count(*)::int as n from experiments where sku_id = ${skuId} group by 1`;
  const recent = await tx`select genes->>'angle' as angle, genes->>'hookMechanism' as hook from experiments where sku_id = ${skuId} and created_at > now() - interval '21 days'`;
  // Confounded learnings (§45) never count as evidence for or against an angle.
  const learnings = await tx`select id, relevant_genes->>'angle' as angle, state from learnings where sku_id = ${skuId} and not confounded`;
  const fatigue = await tx`select distinct e.genes->>'angle' as angle from experiments e join experiment_results r on r.experiment_id = e.id
                           where e.sku_id = ${skuId} and e.state = 'ACTIONABLE' and r.computed_at < now() - interval '21 days'`;
  const [assets] = await tx`select count(*)::int as n from assets where sku_id = ${skuId} and kind in ('creator_footage','historical_creative') and deleted_at is null`;
  const [integ] = await tx`select count(*) filter (where status = 'active' and last_success_at > now() - interval '7 days')::int as fresh,
                                  count(*)::int as n from integrations where provider in ('meta','tiktok')`;
  const approved = (await tx`select preferred_wording, mandatory_qualifier from claims where sku_id = ${skuId} and status in ('VERIFIED','VERIFIED_WITH_QUALIFIER')`).map((c) => `${c.preferred_wording}${c.mandatory_qualifier ? ' ' + c.mandatory_qualifier : ''}`);
  const hasPerf = learnings.length > 0;
  const basis: ScoringContext['basis'] = !integ!.n ? (hasPerf ? 'context_limited' : 'cold_start') : integ!.fresh < integ!.n ? 'context_limited' : hasPerf ? 'performance' : 'cold_start';
  return {
    themes: themes.map((t) => ({ id: t.id as string, label: t.label as string, prevalence: Number(t.prevalence) })),
    angleTests: new Map(tests.map((t) => [t.angle as string, t.n as number])),
    learnings: learnings.map((l) => ({ id: l.id as string, angle: l.angle as string, state: l.state as string, positive: true })),
    fatiguingAngles: new Set(fatigue.map((f) => f.angle as string)),
    recentKeys: new Set(recent.map((r) => `${r.angle}|${r.hook}`)),
    fidelityConfidence: Number(sku?.fidelity_confidence ?? 0.7),
    approvedClaims: approved,
    hasRealAssets: (assets?.n ?? 0) > 0,
    maturity: (sku?.maturity as SkuMaturity) ?? 'COLD',
    // Stale or missing ad connections downgrade the recommendation basis (§31).
    basis,
  };
}

export function weekOf(d = new Date()): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  x.setUTCDate(x.getUTCDate() - dow);
  return x.toISOString().slice(0, 10);
}

/** Weekly job per SKU: candidates from the Creative Director → gates → score → portfolio → recommendations. */
export async function generateRecommendations(ctx: TenantContext, skuId: string, week = weekOf()): Promise<number> {
  const ws = ctx.workspaceId;
  const existing = await withTenant(ws, (tx) => tx`select id from recommendations where sku_id = ${skuId} and week_of = ${week}`);
  if (existing.length) return 0; // idempotent per week
  const { productContext, packet, packetIds, ingredientsVerified, names } = await withTenant(ws, (tx) => buildContext(tx, skuId));
  const sc = { ...(await withTenant(ws, (tx) => scoringContext(tx, skuId))), ingredientsVerified };
  const auth = await withTenant(ws, async (tx) =>
    authorize(tx, ctx, { purpose: 'storyboard', projectId: null, lines: await routedLines(tx, ws, [{ task: 'creative_director.recommendations', kind: 'llm', inputTokens: 12_000, outputTokens: 8_000 }]), idempotencyKey: `recs:${skuId}:${week}` }),
  );
  try {
    const batches = [1, 2];
    const candidates: Proposal[] = [];
    for (const b of batches) {
      const r = await llmJson({
        ctx,
        token: auth.token,
        task: 'creative_director.recommendations',
        subject: { type: 'sku', id: skuId },
        system: CONCEPTS_SYSTEM,
        content: [
          { type: 'text', text: `Context packet:\n${JSON.stringify(packet)}` },
          { type: 'text', text: `Weekly planning (${week}). Basis: ${sc.basis}. SKU maturity: ${sc.maturity}. Candidate set ${b} of 2 — make these different from set 1.` },
        ],
        schema: ConceptSet,
        mock: () => mockConcepts(productContext, b),
        effort: 'high',
        maxTokens: 6000,
      });
      candidates.push(...r.data.concepts.map((c) => gateProposal(c, productContext.approvedClaims, names, { packetIds, ingredientsVerified }).cleaned));
    }
    const picked = composePortfolio(candidates.map((c) => scoreProposal(c, sc)), sc.maturity, 3);
    await withTenant(ws, async (tx) => {
      for (const p of picked) {
        const [r] = await tx`
          insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, gates, basis, rationale_ids, confidence)
          values (${ws}, ${skuId}, ${week}, ${p.slot}, ${tx.json(p.proposal as never)}, ${p.score}, ${tx.json(p.breakdown)}, ${tx.json(p.gates)}, ${sc.basis},
                  ${p.rationaleIds}::uuid[], ${p.confidence})
          returning id`;
        await emit(tx, ctx, 'RECOMMENDATION_CREATED', { type: 'recommendation', id: r!.id as string }, { slot: p.slot, score: p.score, basis: sc.basis, confidence: p.confidence, rationaleIds: p.rationaleIds }, { skuId });
      }
      await settle(tx, ctx, auth.authorizationId, 'consumed');
    });
    return picked.length;
  } catch (e) {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
    throw e;
  }
}

export async function dismissRecommendation(tx: Tx, ctx: TenantContext, id: string, reason: string) {
  assertCan(ctx, 'experiment.create');
  const r = await tx`update recommendations set status = 'dismissed', dismiss_reason = ${reason} where id = ${id} and status = 'open' returning id`;
  if (!r.length) throw new DomainError('NOT_FOUND', 'Recommendation not found');
  await emit(tx, ctx, 'RECOMMENDATION_DISMISSED', { type: 'recommendation', id }, { reason });
}

export interface RationaleItem {
  id: string;
  kind: 'customer_theme' | 'learning' | 'claim' | 'fact';
  label: string;
}

/**
 * Resolve rationale ids to what a merchant can read (§38: rationale ids and confidence, never chain-of-thought).
 * Tenant-scoped reads; ids that no longer exist (a purged theme, a superseded fact) are simply omitted.
 */
export async function resolveRationale(tx: Tx, ids: readonly string[]): Promise<Map<string, RationaleItem>> {
  const out = new Map<string, RationaleItem>();
  const uuids = [...new Set(ids)].filter((i) => /^[0-9a-f-]{36}$/i.test(i));
  if (!uuids.length) return out;
  const rows = await tx`
    select id, 'customer_theme' as kind, label from customer_themes where id = any(${uuids}::uuid[])
    union all select id, 'learning', statement from learnings where id = any(${uuids}::uuid[])
    union all select id, 'claim', preferred_wording from claims where id = any(${uuids}::uuid[])
    union all select id, 'fact', normalized_key || ': ' || coalesce(value_text, value_number::text, value_json::text, '') from product_facts where id = any(${uuids}::uuid[])`;
  for (const r of rows) out.set(r.id as string, { id: r.id as string, kind: r.kind as RationaleItem['kind'], label: String(r.label).slice(0, 160) });
  return out;
}

/**
 * GET /products/:id/recommendations (§38): open recommendations with their rationale (ids and readable items)
 * and confidence.
 */
export async function recommendationsForSku(tx: Tx, skuId: string, opts: { sinceWeek?: string } = {}) {
  const recs = await tx`select id, week_of, slot, proposal, score, basis, gates, rationale_ids, confidence, status from recommendations
                        where sku_id = ${skuId} and status = 'open' and week_of >= ${opts.sinceWeek ?? weekOf(new Date(Date.now() - 7 * 86400_000))}
                        order by week_of desc, score desc limit 9`;
  const items = await resolveRationale(tx, recs.flatMap((r) => (r.rationale_ids as string[]) ?? []));
  return recs.map((r) => {
    const p = r.proposal as Proposal;
    return {
      id: r.id as string,
      week: String(r.week_of),
      slot: r.slot as PortfolioSlot,
      hypothesis: p.hypothesis,
      hookOptions: p.hookOptions,
      primaryVariable: p.primaryVariable,
      whyNow: p.whyNow,
      expectedLearning: p.expectedLearning,
      score: Number(r.score),
      basis: r.basis as string,
      confidence: r.confidence == null ? null : Number(r.confidence),
      rationaleIds: (r.rationale_ids as string[]) ?? [],
      rationale: ((r.rationale_ids as string[]) ?? []).map((id) => items.get(id)).filter((x): x is RationaleItem => !!x),
    };
  });
}

/** Maturity from evidence: COLD (no actionable/directional learnings) → DEVELOPING → MATURE (≥3 actionable). */
export async function refreshMaturity(tx: Tx, skuId: string) {
  const [l] = await tx`select count(*) filter (where state = 'ACTIONABLE')::int as a, count(*) filter (where state in ('DIRECTIONAL','ACTIONABLE'))::int as d
                       from learnings where sku_id = ${skuId} and not confounded`;
  const m: SkuMaturity = l!.a >= 3 ? 'MATURE' : l!.d >= 1 ? 'DEVELOPING' : 'COLD';
  await tx`update skus set maturity = ${m} where id = ${skuId}`;
  return m;
}
