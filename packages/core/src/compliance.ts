/**
 * Deterministic compliance rules (standard §17, §43; FDA cosmetic vs drug claims [R12]; FTC substantiation [R13]).
 * The LLM may *suggest*; these rules *decide* (engineering rule 54.2). Versioned: bump RULES_VERSION on change.
 */
export const RULES_VERSION = 'claims-rules@1.1.0';

export type RiskLevel = 'low' | 'medium' | 'high' | 'prohibited';
export type SuggestedStatus =
  | 'VERIFIED'
  | 'VERIFIED_WITH_QUALIFIER'
  | 'MERCHANT_REVIEW_REQUIRED'
  | 'RESTRICTED'
  | 'BLOCKED'
  | 'INFERRED_ONLY';

interface Rule {
  id: string;
  pattern: RegExp;
  risk: RiskLevel;
  status: SuggestedStatus;
  category: string;
  reason: string;
  alternative?: string;
}

/**
 * Ordered most-severe first. Disease/treatment and structure/function language makes a cosmetic a drug
 * (FDA); those are BLOCKED in V1. Substantiation-heavy claims need evidence (RESTRICTED / REVIEW).
 */
export const RULES: Rule[] = [
  { id: 'disease.acne', pattern: /\b(cure[sd]?|treat(s|ed|ing|ment)?|heal(s|ed|ing)?|clear(s|ed)?\s+up)\b[^.]{0,40}\b(acne|breakouts?|pimples?|eczema|rosacea|psoriasis|dermatitis|melasma|infection)/i, risk: 'prohibited', status: 'BLOCKED', category: 'drug_claim', reason: 'Treating or curing a skin condition is a drug claim (FDA).', alternative: 'Describe how skin looks or feels, e.g. "skin looks clearer".' },
  { id: 'disease.named', pattern: /\b(acne|eczema|rosacea|psoriasis|dermatitis|melasma)\b/i, risk: 'high', status: 'RESTRICTED', category: 'condition_reference', reason: 'Naming a skin condition implies treatment; needs specialist review.', alternative: 'Speak to appearance ("blemish-prone look") instead of conditions.' },
  { id: 'drug.verbs', pattern: /\b(cures?|heals?|treats?|prevents?|remed(y|ies)|therapeutic|medicinal|prescription[- ]strength|anti[- ]?inflammatory|antibacterial|antifungal|antiseptic)\b/i, risk: 'prohibited', status: 'BLOCKED', category: 'drug_claim', reason: 'Treatment/prevention language is a drug claim (FDA).', alternative: 'Focus on cosmetic effect and feel.' },
  { id: 'structure.function', pattern: /\b(boosts?|stimulates?|increases?|repairs?|regenerates?|rebuilds?)\s+(collagen|elastin|cell(s|ular)?|dna|hormones?|blood flow|skin cells)\b|\bcell(ular)?\s+(renewal|regeneration|turnover)\b|\b(at\s+(a|the)\s+)?cellular\s+level\b|\bpenetrates?\s+(the\s+)?dermis\b/i, risk: 'prohibited', status: 'BLOCKED', category: 'structure_function', reason: 'Claims that change the structure or function of the body make a product a drug (FDA).', alternative: 'Use "the look of firmer skin" style appearance claims.' },
  { id: 'sun.protection', pattern: /\b(spf\s*\d*|sun\s*(screen|block|protection)|sunburn|uv[ab]?\s*(protection|defen[cs]e|rays)?|broad[- ]spectrum|protects?\s+(against|from)\s+(the\s+)?sun)\b/i, risk: 'prohibited', status: 'BLOCKED', category: 'otc_drug', reason: 'Sun protection is an OTC drug claim; SPF products are out of V1 scope.' },
  { id: 'medical.results', pattern: /\b(permanent(ly)?|forever|miracle|guarantee[sd]?|100%\s+(effective|results)|instant(ly)?\s+(remove|erase|eliminat))/i, risk: 'high', status: 'BLOCKED', category: 'absolute_claim', reason: 'Absolute or guaranteed results are misleading (FTC).', alternative: 'Use measured, typical-experience language.' },
  { id: 'clinical.proof', pattern: /\bclinically\s+(proven|tested|shown|demonstrated)\b|\bclinical(ly)?\s+(stud(y|ies)|trials?)\b|\bproven\s+to\b/i, risk: 'high', status: 'RESTRICTED', category: 'clinical_claim', reason: 'Clinical claims need product-specific study evidence (FTC); ingredient studies do not transfer.' },
  { id: 'derm.authority', pattern: /\bdermatologists?\s*[- ]?\s*(tested|recommended|approved|developed|formulated)\b|\bdoctor[- ]?(recommended|approved|formulated)\b/i, risk: 'high', status: 'MERCHANT_REVIEW_REQUIRED', category: 'expert_endorsement', reason: 'Expert endorsement needs evidence and exact wording.' },
  { id: 'percent.stat', pattern: /\b\d{1,3}\s?%\s+(of\s+)?(users|people|participants|customers|women|men)\b|\b\d{1,3}\s?%\s+(less|more|fewer|reduction|improvement|increase)\b/i, risk: 'high', status: 'MERCHANT_REVIEW_REQUIRED', category: 'quantified_claim', reason: 'Quantified results need the underlying study and a qualifier.' },
  { id: 'comparative', pattern: /\b(better|stronger|faster|more effective)\s+than\b|\b#?1\b|\bnumber one\b|\bbest[- ]selling\b/i, risk: 'medium', status: 'MERCHANT_REVIEW_REQUIRED', category: 'comparative', reason: 'Comparative or superlative claims need substantiation.' },
  { id: 'hypoallergenic', pattern: /\b(hypo[- ]?allergenic|non[- ]?comedogenic|safe for sensitive skin|won'?t\s+irritate)\b/i, risk: 'medium', status: 'MERCHANT_REVIEW_REQUIRED', category: 'safety_claim', reason: 'Safety-type claims need test evidence.' },
  { id: 'clean.natural', pattern: /\b(non[- ]?toxic|chemical[- ]?free|clean beauty|all[- ]natural|100%\s+natural|organic)\b/i, risk: 'medium', status: 'MERCHANT_REVIEW_REQUIRED', category: 'composition_claim', reason: 'Composition claims must be literally true (and "organic" may need certification).' },
  { id: 'pregnancy', pattern: /\b(pregnan(t|cy)|postpartum|breastfeeding|nursing)\b/i, risk: 'high', status: 'RESTRICTED', category: 'sensitive_population', reason: 'Suitability for pregnancy is an elevated claim; do not infer from ingredients.' },
  { id: 'appearance.wrinkles', pattern: /\b(reduces?|minimi[sz]es?|smooths?|softens?)\b[^.]{0,30}\b(appearance|look)\s+of\b/i, risk: 'low', status: 'VERIFIED_WITH_QUALIFIER', category: 'appearance_claim', reason: 'Appearance claims are cosmetic but still need a basis.' },
  { id: 'wrinkles.direct', pattern: /\b(removes?|erases?|eliminates?|gets? rid of)\b[^.]{0,20}\b(wrinkles?|fine lines?|dark spots?|scars?|stretch marks?)\b/i, risk: 'high', status: 'BLOCKED', category: 'absolute_claim', reason: 'Removal claims overstate a cosmetic effect.', alternative: 'Say "reduces the look of fine lines".' },
];

export interface ClaimClassification {
  risk: RiskLevel;
  status: SuggestedStatus;
  category: string;
  matched: { ruleId: string; reason: string; alternative?: string }[];
}

/** Classify a proposed claim. Unmatched sensory/usage statements default to merchant review, never auto-verified. */
export function classifyClaim(text: string): ClaimClassification {
  const matched = RULES.filter((r) => r.pattern.test(text));
  if (!matched.length) {
    return { risk: 'low', status: 'MERCHANT_REVIEW_REQUIRED', category: 'descriptive', matched: [] };
  }
  const order: SuggestedStatus[] = ['BLOCKED', 'RESTRICTED', 'MERCHANT_REVIEW_REQUIRED', 'INFERRED_ONLY', 'VERIFIED_WITH_QUALIFIER', 'VERIFIED'];
  const worst = matched.reduce((a, b) => (order.indexOf(a.status) <= order.indexOf(b.status) ? a : b));
  return {
    risk: worst.risk,
    status: worst.status,
    category: worst.category,
    matched: matched.map((m) => ({ ruleId: m.id, reason: m.reason, alternative: m.alternative })),
  };
}

/** Plain, non-claim descriptors that never need a Claim ID (texture, format, usage, CTA). */
const NEUTRAL = [
  /\b(lightweight|gel|cream|serum|oil|balm|lotion|foam|mist|texture|absorbs?|finish|dewy|matte|non[- ]?sticky|glides?|layers?|apply|use|morning|night|am|pm|routine|step|drops?|pump|shop|try|get yours|link in bio|free shipping|bundle|save|off|new|ml|oz|fragrance[- ]free|vegan|cruelty[- ]free)\b/i,
];

/** How one creative line was resolved against the Claims Vault (plan 05 §13 "each line → Claim ID or ⚠ unmapped"). */
export interface LineMapping {
  line: string;
  /** The approved claim this line uses, when it makes one. */
  claimId: string | null;
  status: 'claim' | 'neutral' | 'violation' | 'unmapped';
}

export interface ScanResult {
  /** No blocked, restricted, unapproved or unqualified claim. */
  ok: boolean;
  violations: { text: string; ruleId: string; reason: string; status: SuggestedStatus; alternative?: string }[];
  /** Product-effect statements that map to no approved Claim ID (§25 check 3: these may not ship either). */
  unmapped: string[];
  mapping: LineMapping[];
}

/** A scan passes only with no violations and no unmapped effect statement. */
export const scanPasses = (s: ScanResult) => s.ok && s.unmapped.length === 0;

/**
 * Scan final creative text (voice-over, overlays, captions, CTA) against the Claims Vault (§25 check 3).
 * Every sentence must either be neutral or be covered by an allowed claim (recorded as its Claim ID); anything
 * blocked/restricted fails, and an effect statement no claim covers is reported as unmapped.
 * `names` (product and brand names) are not statements: "Glow Serum · 30 ml" is a name, not a glow claim.
 */
export function scanCreativeText(
  sentences: string[],
  allowedClaims: { id: string; wording: string; qualifier?: string | null }[],
  opts: { names?: (string | null | undefined)[] } = {},
): ScanResult {
  const violations: ScanResult['violations'] = [];
  const unmapped: string[] = [];
  const mapping: LineMapping[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9% ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const allowed = allowedClaims.map((c) => ({ ...c, n: norm(c.wording) })).filter((c) => c.n);
  const names = (opts.names ?? []).map((x) => (x ? norm(x) : '')).filter((x) => x.length >= 3).sort((a, b) => b.length - a.length);
  const withoutNames = (raw: string) => names.reduce((t, x) => t.replace(new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' '), norm(raw)).trim();
  for (const raw of sentences.map((s) => s.trim()).filter(Boolean)) {
    const cls = classifyClaim(raw);
    const n = norm(raw);
    const covered = allowed.find((c) => n.includes(c.n) || c.n.includes(n));
    const hard = cls.matched.length > 0 && (cls.status === 'BLOCKED' || cls.status === 'RESTRICTED');
    if (hard) {
      violations.push({ text: raw, ruleId: cls.matched[0]!.ruleId, reason: cls.matched[0]!.reason, status: cls.status, alternative: cls.matched[0]!.alternative });
      mapping.push({ line: raw, claimId: null, status: 'violation' });
      continue;
    }
    if (cls.matched.length > 0 && !covered) {
      violations.push({ text: raw, ruleId: cls.matched[0]!.ruleId, reason: 'Claim is not approved in the Claims Vault', status: cls.status });
      mapping.push({ line: raw, claimId: null, status: 'violation' });
      continue;
    }
    if (covered?.qualifier && !n.includes(norm(covered.qualifier))) {
      // VERIFIED_WITH_QUALIFIER claims may only be used with the exact approved qualification (§17).
      violations.push({ text: raw, ruleId: 'qualifier.missing', reason: `Must include the qualifier: "${covered.qualifier}"`, status: 'VERIFIED_WITH_QUALIFIER' });
      mapping.push({ line: raw, claimId: covered.id, status: 'violation' });
      continue;
    }
    if (covered) {
      mapping.push({ line: raw, claimId: covered.id, status: 'claim' });
      continue;
    }
    // Effect statements always need a Claim ID; neutral vocabulary only exempts descriptive/usage lines.
    const text = names.length ? withoutNames(raw) : raw;
    if (text && (looksLikeProductStatement(text) || !NEUTRAL.some((p) => p.test(text))) && looksLikeClaim(text)) {
      unmapped.push(raw);
      mapping.push({ line: raw, claimId: null, status: 'unmapped' });
    } else mapping.push({ line: raw, claimId: null, status: 'neutral' });
  }
  return { ok: violations.length === 0, violations, unmapped, mapping };
}

/** Heuristic: does the sentence assert something about what the product does? */
function looksLikeProductStatement(s: string): boolean {
  return /\b(it|this|our|formula|serum|cream|product)\b[^.]{0,40}\b(makes?|gives?|helps?|works?|improves?|reduces?|brightens?|firms?|hydrates?|plumps?|evens?)\b/i.test(s);
}

/** Anything that asserts an outcome on skin (as opposed to a hook question, CTA or usage note). */
function looksLikeClaim(s: string): boolean {
  if (/\?\s*$/.test(s)) return false;
  return looksLikeProductStatement(s) || /\b(glow(s|ing)?|brighter|smoother|firmer|plumper|clearer|younger|radiant|even(s|er)? (out )?(skin )?tone)\b/i.test(s);
}

/** Categories this product can't be advertised under in V1 (standard §1 exclusions). */
export function excludedProductReason(text: string): string | null {
  if (/\b(spf|sunscreen|sun\s*block|broad\s*spectrum)\b/i.test(text)) return 'Sunscreen / SPF products are drug products and outside V1 scope.';
  if (/\b(benzoyl peroxide|salicylic acid\s+\d|adapalene|hydroquinone|tretinoin|minoxidil|drug facts)\b/i.test(text))
    return 'This looks like an OTC drug product (acne or pigment treatment), which is outside V1 scope.';
  return null;
}

const SKINCARE_TERMS = /\b(serum|moisturi[sz]er|cream|cleanser|toner|essence|mask|face oil|facial oil|eye (cream|gel|serum)|balm|lotion|gel|exfoliant|peel|mist|skincare|skin care|niacinamide|hyaluronic|retinol|ceramide|peptide|vitamin c|squalane|spf|sunscreen|face|skin)\b/i;
const OTHER_CATEGORIES: [RegExp, string][] = [
  [/\b(candle|diffuser|incense)\b/i, 'home fragrance'],
  [/\b(shampoo|conditioner|hair (oil|mask|serum)|scalp)\b/i, 'haircare'],
  [/\b(lipstick|mascara|foundation|eyeshadow|blush|concealer|eyeliner|bronzer)\b/i, 'makeup'],
  [/\b(perfume|eau de (parfum|toilette)|cologne)\b/i, 'fragrance'],
  [/\b(t-?shirt|dress|jeans|sneakers?|hoodie|jacket)\b/i, 'fashion'],
  [/\b(supplement|capsules?|gummies|protein powder)\b/i, 'supplements'],
];

/** Is this within V1's category? Returns null if skincare, else the detected other category. */
export function nonSkincareCategory(text: string): string | null {
  if (SKINCARE_TERMS.test(text)) return null;
  for (const [re, name] of OTHER_CATEGORIES) if (re.test(text)) return name;
  return null;
}

export function detectSkincareCategory(text: string): string {
  const t = text.toLowerCase();
  const table: [RegExp, string][] = [
    [/\bserum|essence|ampoule\b/, 'serum'],
    [/\bcleanser|face wash|cleansing\b/, 'cleanser'],
    [/\bmoisturi[sz]er|cream|lotion\b/, 'moisturizer'],
    [/\beye (cream|gel|serum)\b/, 'eye'],
    [/\bmask\b/, 'mask'],
    [/\b(face|facial) oil\b|\boil\b/, 'facial_oil'],
    [/\btoner|mist\b/, 'toner'],
    [/\bexfoliant|peel|scrub\b/, 'exfoliant'],
    [/\bbalm\b/, 'balm'],
  ];
  for (const [re, c] of table) if (re.test(t)) return c;
  return 'skincare';
}

// ───────────── Synthetic people never give testimonials (standard §40) ─────────────

/**
 * Does this line speak as a customer about their own use or results ("I've used it for two weeks", "my skin has
 * never looked better", "I'm obsessed")? A narrator's instruction or a second-person line is not a testimonial.
 */
export function isFirstPersonTestimonial(text: string): boolean {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  if (!/\b(i|i'm|i've|i'd|i'll|me|my|mine|myself)\b/.test(t)) return false;
  return /\b(i|i've|i'm|i have|i am|i've been|i was|my)\b[^.?!]{0,60}\b(skin|face|complexion|pores?|use[ds]?|using|tried|trying|love[ds]?|obsessed|swear|results?|routine|noticed|changed|cleared|glow(s|ing)?|recommend|bought|order(ed)?|week|weeks|days?|months?|never|finally|holy grail|game[- ]?changer)\b/.test(t);
}

export const SYNTHETIC_TESTIMONIAL_REASON =
  'This scene shows an AI-generated person, so it can’t speak as a customer (“I”, “my skin”). Describe the product or speak to the viewer instead.';

/** Scenes that show AI-generated people: generated interaction or hybrid shots with visible skin (hands, faces). */
export const showsSyntheticPeople = (s: { productionMode?: string | null; production_mode?: string | null; showsHumanSkin?: boolean | null; shows_human_skin?: boolean | null }) =>
  !!(s.showsHumanSkin ?? s.shows_human_skin) && ['GENERATIVE_INTERACTION', 'HYBRID'].includes((s.productionMode ?? s.production_mode) as string);

/**
 * Standard §40: "do not misrepresent a real person or customer endorsement." A scene with a synthetic person never
 * carries a first-person customer line (spoken or on screen). Returns the offending lines.
 */
export function syntheticTestimonials(
  scenes: { productionMode?: string | null; production_mode?: string | null; showsHumanSkin?: boolean | null; shows_human_skin?: boolean | null; spokenLine?: string | null; spoken_line?: string | null; overlayText?: string | null; overlay_text?: string | null }[],
): { text: string; reason: string }[] {
  return scenes
    .filter(showsSyntheticPeople)
    .flatMap((s) => [s.spokenLine ?? s.spoken_line, s.overlayText ?? s.overlay_text])
    .filter((l): l is string => !!l && isFirstPersonTestimonial(l))
    .map((text) => ({ text, reason: SYNTHETIC_TESTIMONIAL_REASON }));
}
