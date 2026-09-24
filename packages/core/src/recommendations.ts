import { withTenant, type Tx } from '@arkiv/db';
import { DomainError, type PortfolioSlot, type SkuMaturity } from '@arkiv/shared';
import { assertCan } from './authz';
import { classifyClaim } from './compliance';
import type { TenantContext } from './context';
import { authorize, settle } from './cost-governor';
import { buildContext, customerPhrasesPart, gateProposal, isIngredientLed, UNVERIFIED_INGREDIENTS_REASON } from './creative-director';
import { emit } from './events';
import { stockState } from './stock';
import { meaningfulCoverage } from './genome';
import { ConceptSet, type Proposal } from './intel-schemas';
import { mockConcepts } from './mock-intel';
import { llmJson, routedLines } from './model-gateway';

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

/**
 * A learning as recommendation scoring sees it. `variable` / `winner` / `losers` say what it is about (the genes the
 * compared ads actually differed on, §20); learnings recorded before that carry only the angle (`positive`).
 */
export interface LearningSignal {
  id?: string;
  angle: string;
  state: string;
  positive: boolean;
  variable?: string | null;
  winner?: string | null;
  losers?: string[];
  /** Shrunk lift of the winner over the runner-up (posterior means). */
  effect?: number | null;
  confidence?: number | null;
}

export interface ScoringContext {
  themes: { id?: string; label: string; prevalence: number }[];
  /** Meaningful (read, or delivered past the evidence floor) tests per angle — §20 coverage gap. */
  angleTests: Map<string, number>;
  /** Meaningfully tested cells: `angle|hookMechanism` and `angle|t:treatment`. */
  testedCells?: Set<string>;
  learnings: LearningSignal[];
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
  /** Packet items the proposal cites plus those the score actually used (matched theme, bearing learnings), §38. */
  rationaleIds: string[];
  /** How much evidence stands behind the recommendation (0–1): basis, bearing learnings, a matched theme. */
  confidence: number;
}

const NEAR_DUPLICATE = 'near-duplicate';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASIS_CONFIDENCE = { performance: 0.55, context_limited: 0.4, cold_start: 0.3 } as const;
const LEARNING_CONFIDENCE: Record<string, number> = { ACTIONABLE: 0.2, DIRECTIONAL: 0.1, WEAKENING: -0.1, INVALIDATED: -0.2 };

/**
 * Recommendation confidence (§38): starts from the plan's evidence basis, moves with the learnings that bear on
 * the proposal (actionable/directional up, weakening/invalidated down; evidence against it inverts), and a little
 * with a matched customer theme. A heuristic summary of evidence, not a probability of winning.
 */
export function recommendationConfidence(basis: ScoringContext['basis'], learnings: readonly (Pick<LearningSignal, 'state' | 'positive'> & { angle?: string })[], themeMatched: boolean): number {
  let c: number = BASIS_CONFIDENCE[basis ?? 'cold_start'];
  for (const l of learnings) c += (LEARNING_CONFIDENCE[l.state] ?? 0) * (l.positive ? 1 : -1);
  if (themeMatched) c += 0.1;
  return Math.round(Math.max(0.05, Math.min(0.95, c)) * 100) / 100;
}

/** Gene-family similarity (§20 "evidence from related genes"): the same hook or angle 1.0 … treatment 0.4. */
const FAMILY: Record<string, number> = { hook: 1, angle: 1, hookMechanism: 0.6, proof: 0.5, format: 0.4 };
const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * How a learning bears on a proposal, signed: +similarity when the proposal carries the learning's winning value
 * of the variable the learning is about, −similarity when it carries a losing one, 0 when it's unrelated. A hook
 * learning bears on proposals that reuse that hook, never on the angle every compared ad shared.
 */
export function learningMatch(l: LearningSignal, p: Proposal): number {
  if (!l.variable || !l.winner) return l.angle === p.angle ? (l.positive ? 1 : -1) : 0; // recorded before genes: its angle
  const w = FAMILY[l.variable] ?? 0.4;
  const values: string[] =
    l.variable === 'hook' ? p.hookOptions
    : l.variable === 'angle' ? [p.angle]
    : l.variable === 'proof' ? [p.proofMechanism]
    : l.variable === 'format' ? [p.treatment]
    : l.variable === 'hookMechanism' ? [p.hookMechanism]
    : [];
  if (values.some((v) => eq(v, l.winner!))) return w;
  if (values.some((v) => (l.losers ?? []).some((x) => eq(v, x)))) return -w;
  return 0;
}

const STATE_WEIGHT: Record<string, number> = { ACTIONABLE: 1, DIRECTIONAL: 0.5, WEAKENING: 0.25 };

/**
 * Adjacent historical signal (§20 "evidence from related genes after shrinkage, not raw winner cloning"): around a
 * neutral 0.4, Σ state weight × confidence × shrunk effect × signed gene similarity, clamped to [0, 1].
 * Invalidated learnings are never a prior (§21); weakening ones count a quarter. The effect is the posterior
 * (shrunk) lift, so a lucky tiny test moves the score little.
 */
export function adjacentSignal(learnings: LearningSignal[], p: Proposal): number {
  let acc = 0;
  for (const l of learnings) {
    if (l.state === 'INVALIDATED') continue;
    const sim = learningMatch(l, p);
    if (!sim) continue;
    // A learning recorded before effects were stored counts as a moderate effect.
    const effect = l.effect == null ? 0.5 : Math.max(0, Math.min(1, l.effect / 0.25));
    acc += (STATE_WEIGHT[l.state] ?? 0) * (l.confidence ?? 1) * effect * 0.4 * sim;
  }
  return Math.max(0, Math.min(1, 0.4 + acc));
}

/**
 * Coverage gap (§20 "reward genuinely under-tested territory"): the angle's meaningful tests relative to the most
 * tested angle, less again when this exact hook mechanism or treatment has already been read on the angle.
 */
export function coverageGap(p: Proposal, s: Pick<ScoringContext, 'angleTests' | 'testedCells'>): number {
  const maxTests = Math.max(1, ...s.angleTests.values());
  let gap = 1 - (s.angleTests.get(p.angle) ?? 0) / maxTests / 1.25;
  if (s.testedCells?.has(`${p.angle}|${p.hookMechanism}`)) gap -= 0.2;
  if (s.testedCells?.has(`${p.angle}|t:${p.treatment}`)) gap -= 0.1;
  return Math.max(0, Math.min(1, gap));
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
  if (s.recentKeys.has(`${p.angle}|${p.hookMechanism}`)) reasons.push(`${NEAR_DUPLICATE} of a test run in the last 21 days`);
  if (p.estimatedGenerationClass === 'premium') reasons.push('premium production exceeds the standard Creative Test cost ceiling');
  if (p.treatment === 'RAW_UGC' && !s.hasRealAssets) reasons.push('needs real footage/assets that are not in the library');
  if (p.proofMechanism === 'BEFORE_AFTER_RESTRICTED') reasons.push('before/after requires separate policy review');
  if (s.ingredientsVerified === false && isIngredientLed(p)) reasons.push(UNVERIFIED_INGREDIENTS_REASON);
  return { passed: reasons.length === 0, reasons };
}

/**
 * EXPLOIT is reserved for a proposal an ACTIONABLE learning points to (§21: ACTIONABLE drives ranking;
 * DIRECTIONAL only influences exploration). Tested territory and adjacent or lower-risk ideas are EXPAND.
 */
export function slotFor(p: Proposal, s: ScoringContext): PortfolioSlot {
  if (s.learnings.some((l) => l.state === 'ACTIONABLE' && learningMatch(l, p) > 0)) return 'EXPLOIT';
  if ((s.angleTests.get(p.angle) ?? 0) > 0 || p.riskProfile === 'adjacent' || p.riskProfile === 'lower_risk') return 'EXPAND';
  return 'EXPLORE';
}

export function scoreProposal(p: Proposal, s: ScoringContext): Scored {
  const gates = hardGates(p, s);
  const theme = s.themes.map((t) => ({ t, o: overlap(t.label, `${p.customerTension} ${p.hypothesis}`) })).sort((a, b) => b.o * b.t.prevalence - a.o * a.t.prevalence)[0];
  const bearing = s.learnings.filter((l) => l.state !== 'INVALIDATED').map((l) => ({ l, m: learningMatch(l, p) })).filter((x) => x.m !== 0);
  const b = {
    customerRelevance: theme && theme.o > 0 ? Math.min(1, 0.4 + theme.o * 0.3 + theme.t.prevalence * 0.6) : p.customerTensionSource === 'reviews' ? 0.6 : 0.35,
    adjacentSignal: adjacentSignal(s.learnings, p),
    coverageGap: coverageGap(p, s),
    fatigueNeed: s.fatiguingAngles.has(p.angle) ? 0.9 : s.fatiguingAngles.size ? 0.5 : 0.2,
    learnability: p.primaryVariable === 'hook' ? 1 : p.riskProfile === 'exploratory' ? 0.45 : 0.75,
    feasibility: Math.min(1, s.fidelityConfidence * (p.estimatedGenerationClass === 'generative_short' ? 0.85 : 1) + 0.1),
    platformFit: NATIVE_ANGLES.has(p.angle) ? 1 : 0.55,
    cogsEfficiency: COGS_SCORE[p.estimatedGenerationClass],
  };
  const score = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((acc, k) => acc + WEIGHTS[k] * b[k], 0);
  const themeMatched = !!theme && theme.o > 0;
  const used = [...(themeMatched && theme!.t.id ? [theme!.t.id] : []), ...bearing.map((x) => x.l.id).filter((x): x is string => !!x)];
  // Only packet item ids (uuids) are stored; anything else was dropped by the gate or never belonged here.
  const rationaleIds = [...new Set([...(p.rationaleIds ?? []), ...used])].filter((id) => UUID.test(id)).slice(0, 12);
  const confidence = recommendationConfidence(s.basis, bearing.map((x) => ({ state: x.l.state, positive: x.m > 0 })), themeMatched);
  return { proposal: p, slot: slotFor(p, s), score: gates.passed ? score : 0, breakdown: b, gates, rationaleIds, confidence };
}

/**
 * Pick N from scored candidates honouring the maturity portfolio (§20) — the score cannot override a gate.
 * Allocation is by deficit: each slot's target share of this SKU's recent picks plus these N, minus what those
 * recent picks already realized, so the mix converges on the portfolio rule over the weeks instead of rounding
 * three picks the same way every week. A Cold or Mature SKU always gets an Explore pick when one is eligible.
 */
export function composePortfolio(scored: Scored[], maturity: SkuMaturity, n = 3, realized: Partial<Record<PortfolioSlot, number>> = {}): Scored[] {
  const eligible = scored.filter((s) => s.gates.passed).sort((a, b) => b.score - a.score);
  const quota = PORTFOLIO[maturity];
  const slots: PortfolioSlot[] = ['EXPLOIT', 'EXPAND', 'EXPLORE'];
  const total = slots.reduce((a, k) => a + (realized[k] ?? 0), 0) + n;
  const deficit = Object.fromEntries(slots.map((k) => [k, quota[k] * total - (realized[k] ?? 0)])) as Record<PortfolioSlot, number>;
  const seen = new Set<string>();
  const key = (e: Scored) => `${e.proposal.angle}|${e.proposal.hookMechanism}`;
  const best = (slot: PortfolioSlot | null) => eligible.find((e) => (slot === null || e.slot === slot) && !seen.has(key(e)));
  const out: Scored[] = [];
  while (out.length < n) {
    // The slot furthest below its share that still has an eligible, non-duplicate candidate.
    const slot = slots.filter((k) => best(k)).sort((a, b) => deficit[b] - deficit[a])[0];
    const pick = slot ? best(slot) : undefined;
    if (!pick) break;
    seen.add(key(pick));
    out.push(pick);
    deficit[pick.slot] -= 1;
  }
  if ((maturity === 'MATURE' || maturity === 'COLD') && out.length === n && !out.some((o) => o.slot === 'EXPLORE')) {
    const explore = best('EXPLORE');
    if (explore) out[out.length - 1] = explore;
  }
  return out;
}

/** What scoring needs about a SKU, read through tenant-scoped queries. */
export async function scoringContext(tx: Tx, skuId: string) {
  const [sku] = await tx`select maturity, fidelity_confidence from skus where id = ${skuId}`;
  const themes = await tx`select id, label, prevalence from customer_themes where sku_id = ${skuId}`;
  const coverage = await meaningfulCoverage(tx, skuId);
  const recent = await tx`select genes->>'angle' as angle, genes->>'hookMechanism' as hook from experiments where sku_id = ${skuId} and created_at > now() - interval '21 days'`;
  // The portfolio mix this SKU's last eight weeks already realized (steers the deficit allocation).
  const mix = await tx`select portfolio_slot as slot, count(*)::int as n from experiments where sku_id = ${skuId} and portfolio_slot is not null
                       and created_at > now() - interval '8 weeks' group by 1`;
  // A removed ad account is not a connection: the basis follows the accounts still connected (§31).
  const integ = await tx`select provider, status, coalesce(last_success_at > now() - interval '7 days', false) as fresh from integrations
                         where provider in ('meta','tiktok') and status <> 'disconnected'`;
  // Only learnings scoped to a platform this workspace advertises on (or blended) count; confounded and
  // invalidated ones are never evidence (§21, §45).
  const platforms = [...new Set(integ.map((i) => i.provider as string))];
  const learnings = await tx`select id, relevant_genes->>'angle' as angle, state, variable, winner_genes, loser_genes, effect, confidence from learnings
                             where sku_id = ${skuId} and not confounded and state <> 'INVALIDATED'
                               and (${platforms.length === 0} or scope_platform = 'blended' or scope_platform = any(${platforms}::text[]))`;
  // Measured decay of a test's winner (§45), not the age of a computation: recent CTR / hold rate against its
  // first days live (experiments.fatigue, refreshed with results).
  const fatigue = await tx`select distinct e.genes->>'angle' as angle from experiments e
                           where e.sku_id = ${skuId} and e.state not in ('INVALIDATED','ARCHIVED') and (e.fatigue->>'fatigued')::boolean is true`;
  // Only footage still usable for new production: rights not expired, not frozen by a takedown case (plan 05 §15).
  const [assets] = await tx`select count(*)::int as n from assets where sku_id = ${skuId} and kind in ('creator_footage','historical_creative') and deleted_at is null
                              and (rights_expires_at is null or rights_expires_at > now()) and rights_frozen_at is null and coalesce(review_status, 'approved') = 'approved'`;
  const approved = (await tx`select preferred_wording, mandatory_qualifier from claims where sku_id = ${skuId} and status in ('VERIFIED','VERIFIED_WITH_QUALIFIER')`).map((c) => `${c.preferred_wording}${c.mandatory_qualifier ? ' ' + c.mandatory_qualifier : ''}`);
  const hasPerf = learnings.length > 0;
  const fresh = integ.filter((i) => i.status === 'active' && i.fresh).length;
  // Stale or missing ad connections downgrade the recommendation basis (§31).
  const basis: NonNullable<ScoringContext['basis']> = !integ.length ? (hasPerf ? 'context_limited' : 'cold_start') : fresh < integ.length ? 'context_limited' : hasPerf ? 'performance' : 'cold_start';
  const out: ScoringContext & { maturity: SkuMaturity; basis: NonNullable<ScoringContext['basis']>; realized: Partial<Record<PortfolioSlot, number>> } = {
    themes: themes.map((t) => ({ id: t.id as string, label: t.label as string, prevalence: Number(t.prevalence) })),
    angleTests: coverage.angles,
    testedCells: coverage.cells,
    learnings: learnings.map((l) => {
      const variable = (l.variable as string | null) ?? null;
      return {
        id: l.id as string,
        angle: l.angle as string,
        state: l.state as string,
        positive: true,
        variable,
        winner: variable ? ((l.winner_genes as Record<string, string>)?.[variable] ?? null) : null,
        losers: variable ? ([] as string[]).concat((l.loser_genes as Record<string, string | string[]>)?.[variable] ?? []) : [],
        effect: l.effect == null ? null : Number(l.effect),
        confidence: l.confidence == null ? null : Number(l.confidence),
      };
    }),
    fatiguingAngles: new Set(fatigue.map((f) => f.angle as string)),
    recentKeys: new Set(recent.map((r) => `${r.angle}|${r.hook}`)),
    fidelityConfidence: Number(sku?.fidelity_confidence ?? 0.7),
    approvedClaims: approved,
    hasRealAssets: (assets?.n ?? 0) > 0,
    maturity: (sku?.maturity as SkuMaturity) ?? 'COLD',
    basis,
    realized: Object.fromEntries(mix.map((m) => [m.slot as PortfolioSlot, m.n as number])),
  };
  return out;
}

/** What recommendations for an out-of-stock product are for, as the merchant stated (§42). */
const STOCK_INTENT_BRIEF = {
  waitlist: 'The product is out of stock. The merchant is running ads for a waitlist: every experiment must drive waitlist sign-ups (never "buy now", price or delivery promises).',
  launch: 'The product is out of stock ahead of a (re)launch. Every experiment must build launch anticipation and capture interest (never "buy now", price or delivery promises).',
} as const;

export function weekOf(d = new Date()): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  x.setUTCDate(x.getUTCDate() - dow);
  return x.toISOString().slice(0, 10);
}

/**
 * Gate a candidate, then score it (§20 "hard gates happen before scoring … the score cannot override a gate"). A
 * candidate the gate refused — a strategy resting on a blocked claim, a hook or claim the claims scan had to
 * remove — is scored on its ORIGINAL proposal with the gate's reasons, so it scores 0 and is never picked; it is
 * never silently repaired with filler hooks.
 */
export function gateAndScore(
  c: Proposal,
  s: ScoringContext,
  gate: { approvedClaims: string[]; names?: (string | null | undefined)[]; packetIds?: ReadonlySet<string>; ingredientsVerified?: boolean; prohibited?: readonly string[] },
): Scored {
  const g = gateProposal(c, gate.approvedClaims, gate.names ?? [], { packetIds: gate.packetIds, ingredientsVerified: gate.ingredientsVerified, prohibited: gate.prohibited, pad: false });
  if (g.ok && !g.removed.hooks && !g.removed.claims) return scoreProposal(g.cleaned, s);
  const scored = scoreProposal({ ...c, rationaleIds: g.cleaned.rationaleIds }, s);
  const reasons = [...new Set([...scored.gates.reasons, ...g.reasons.filter((r) => !r.startsWith('unknown rationale id'))])];
  return { ...scored, score: 0, gates: { passed: false, reasons } };
}

/** Weekly job per SKU: candidates from the Creative Director → gates → score → portfolio → recommendations. */
export async function generateRecommendations(ctx: TenantContext, skuId: string, week = weekOf()): Promise<number> {
  const ws = ctx.workspaceId;
  const existing = await withTenant(ws, (tx) => tx`select id from recommendations where sku_id = ${skuId} and week_of = ${week}`);
  if (existing.length) return 0; // idempotent per week
  // §42: an out-of-stock product gets recommendations only once the merchant says it's for a waitlist or launch —
  // and then they are for that.
  const stock = await withTenant(ws, (tx) => stockState(tx, skuId));
  if (stock.needsIntent) return 0;
  const stockPart = stock.inStock === false && stock.intent ? { type: 'text' as const, text: STOCK_INTENT_BRIEF[stock.intent] } : null;
  const { productContext, packet, packetIds, ingredientsVerified, names, phrases, prohibited } = await withTenant(ws, (tx) => buildContext(tx, skuId));
  const sc = { ...(await withTenant(ws, (tx) => scoringContext(tx, skuId))), ingredientsVerified };
  const auth = await withTenant(ws, async (tx) =>
    authorize(tx, ctx, { purpose: 'storyboard', projectId: null, lines: await routedLines(tx, ws, [{ task: 'creative_director.recommendations', kind: 'llm', inputTokens: 12_000, outputTokens: 8_000 }]), idempotencyKey: `recs:${skuId}:${week}` }),
  );
  try {
    const batches = [1, 2];
    const candidates: Proposal[] = [];
    const phrasePart = customerPhrasesPart(phrases);
    for (const b of batches) {
      const r = await llmJson({
        ctx,
        token: auth.token,
        task: 'creative_director.recommendations',
        subject: { type: 'sku', id: skuId },
        template: 'recommendations',
        content: [
          { type: 'text', text: `Context packet:\n${JSON.stringify(packet)}` },
          ...(phrasePart ? [phrasePart] : []),
          ...(stockPart ? [stockPart] : []),
          { type: 'text', text: `Weekly planning (${week}). Basis: ${sc.basis}. SKU maturity: ${sc.maturity}. Candidate set ${b} of 2 — make these different from set 1.` },
        ],
        schema: ConceptSet,
        mock: () => mockConcepts(productContext, b),
        effort: 'high',
        maxTokens: 6000,
      });
      candidates.push(...r.data.concepts);
    }
    const scored = candidates.map((c) => gateAndScore(c, sc, { approvedClaims: productContext.approvedClaims, names, packetIds, ingredientsVerified, prohibited }));
    const picked = composePortfolio(scored, sc.maturity, 3, sc.realized);
    const refreshes = await withTenant(ws, (tx) => refreshProposals(tx, skuId, scored, picked));
    await withTenant(ws, async (tx) => {
      // A fatigued winner (§45): a controlled refresh — same angle, a new opening, the current winner as control.
      for (const r of refreshes) {
        const [row] = await tx`
          insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, gates, basis, rationale_ids, confidence, kind, control_creative_id)
          values (${ws}, ${skuId}, ${week}, 'EXPLOIT', ${tx.json(r.proposal as never)}, ${r.scored.score}, ${tx.json(r.scored.breakdown)}, ${tx.json(r.scored.gates)}, ${sc.basis},
                  ${r.scored.rationaleIds}::uuid[], ${r.scored.confidence}, 'refresh', ${r.controlCreativeId})
          returning id`;
        await emit(tx, ctx, 'RECOMMENDATION_CREATED', { type: 'recommendation', id: row!.id as string }, { slot: 'EXPLOIT', score: r.scored.score, basis: sc.basis, confidence: r.scored.confidence, rationaleIds: r.scored.rationaleIds, refresh: true }, { skuId });
      }
      for (const p of picked) {
        const [r] = await tx`
          insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, gates, basis, rationale_ids, confidence)
          values (${ws}, ${skuId}, ${week}, ${p.slot}, ${tx.json(p.proposal as never)}, ${p.score}, ${tx.json(p.breakdown)}, ${tx.json(p.gates)}, ${sc.basis},
                  ${p.rationaleIds}::uuid[], ${p.confidence})
          returning id`;
        await emit(tx, ctx, 'RECOMMENDATION_CREATED', { type: 'recommendation', id: r!.id as string }, { slot: p.slot, score: p.score, basis: sc.basis, confidence: p.confidence, rationaleIds: p.rationaleIds }, { skuId });
      }
      // Refused candidates are kept with their gate reasons for staff review; never shown, never picked.
      for (const g of scored.filter((x) => !x.gates.passed)) {
        await tx`
          insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, gates, basis, rationale_ids, confidence, status)
          values (${ws}, ${skuId}, ${week}, ${g.slot}, ${tx.json(g.proposal as never)}, 0, ${tx.json(g.breakdown)}, ${tx.json(g.gates)}, ${sc.basis},
                  ${g.rationaleIds}::uuid[], ${g.confidence}, 'gated')`;
      }
      await settle(tx, ctx, auth.authorizationId, 'consumed');
    });
    return picked.length + refreshes.length;
  } catch (e) {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
    throw e;
  }
}

/**
 * Controlled refresh proposals (§45 "recommend controlled refresh"): for each test whose leading variant is
 * measurably fatiguing and has a delivered creative, the best gate-passing candidate on the same angle with a new
 * hook becomes a hook test against the winner (its creative is the control). Nothing is proposed when no such
 * candidate exists — a refresh never changes the angle that won.
 */
export async function refreshProposals(tx: Tx, skuId: string, scored: readonly Scored[], picked: readonly Scored[]) {
  const winners = await tx`
    select e.id, e.genes->>'angle' as angle, e.fatigue->>'reason' as reason, v.label as hook, v.creative_id
    from experiments e join variants v on v.id = (e.fatigue->>'winnerVariantId')::uuid and v.workspace_id = e.workspace_id
    where e.sku_id = ${skuId} and (e.fatigue->>'fatigued')::boolean is true and e.state not in ('INVALIDATED','ARCHIVED')
      and v.creative_id is not null
      and not exists (select 1 from recommendations r where r.control_creative_id = v.creative_id and r.status in ('open','accepted')
                        and r.created_at > now() - interval '21 days')
    order by e.created_at desc limit 2`;
  const used = new Set(picked.map((p) => p.proposal));
  const out: { proposal: Proposal; scored: Scored; controlCreativeId: string }[] = [];
  // A refresh is deliberately close to the test it refreshes: the near-duplicate gate is waived for it (and
  // recorded), every other gate still applies.
  const eligible = (s: Scored) => s.gates.passed || (s.gates.reasons.length > 0 && s.gates.reasons.every((r) => r.startsWith(NEAR_DUPLICATE)));
  for (const w of winners) {
    const hook = String(w.hook ?? '');
    const cand = scored
      .filter((s) => eligible(s) && !used.has(s.proposal) && s.proposal.angle === w.angle)
      .map((s) => ({ s, hooks: s.proposal.hookOptions.filter((h) => !eq(h, hook)) }))
      .filter((x) => x.hooks.length > 0)
      .sort((a, b) => b.s.score - a.s.score)[0];
    if (!cand) continue;
    used.add(cand.s.proposal);
    const proposal: Proposal = {
      ...cand.s.proposal,
      hookOptions: cand.hooks.slice(0, 3),
      primaryVariable: 'hook',
      riskProfile: 'lower_risk',
      whyNow: `Your winning ad (“${hook}”) is wearing out: ${w.reason ?? 'its results are decaying'}. Refresh the opening and keep the angle that won; the current ad runs as the control.`.slice(0, 220),
    };
    const score = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((acc, k) => acc + WEIGHTS[k] * cand.s.breakdown[k], 0);
    const refreshed: Scored = { ...cand.s, proposal, slot: 'EXPLOIT', score, gates: { passed: true, reasons: [], ...(cand.s.gates.passed ? {} : { waived: cand.s.gates.reasons }) } as Scored['gates'] };
    out.push({ proposal, scored: refreshed, controlCreativeId: w.creative_id as string });
  }
  return out;
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
