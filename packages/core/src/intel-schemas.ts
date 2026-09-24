import { z } from 'zod';
import { Taxonomy } from '@arkiv/shared';

/** Structured model outputs. Opus proposes; these schemas + deterministic gates validate (§22). */

export const ProductExtraction = z.object({
  name: z.string().min(1).max(160),
  brand: z.string().max(120).nullable(),
  category: z.enum(['serum', 'cleanser', 'moisturizer', 'eye', 'mask', 'facial_oil', 'toner', 'exfoliant', 'balm', 'skincare', 'drug_or_sunscreen', 'not_skincare']),
  sizeText: z.string().max(40).nullable().describe('Net size exactly as printed on the packaging in the photos; null if not visible'),
  format: z.string().max(60).nullable().describe('e.g. gel, cream, oil, lotion'),
  texture: z.string().max(120).nullable(),
  keyIngredients: z.array(z.string().max(60)).max(8),
  labelText: z.string().max(400).nullable().describe('Exact text visible on the packaging, verbatim; null if unreadable'),
  packaging: z.object({
    type: z.enum(['dropper_bottle', 'pump_bottle', 'jar', 'tube', 'spray', 'stick', 'bottle', 'other']),
    closure: z.string().max(60).nullable(),
    transparent: z.boolean(),
    colors: z.array(z.string().max(30)).max(4),
  }),
  /**
   * The colour of the product itself (serum, cream, tint or shade) where it shows in the photos — purchase-relevant
   * for tinted products (standard §48 "shade materially altered"); kept on the Visual Fingerprint.
   */
  liquidColor: z.string().max(30).nullable().optional().describe('Colour of the product itself (liquid, cream, tint or shade) if visible; null if not'),
  claimsFound: z.array(z.object({ wording: z.string().max(200), sourceQuote: z.string().max(300) })).max(12),
  missingEvidence: z.array(z.string().max(160)).max(6),
  suggestedViews: z.array(z.enum(['front', 'side', 'back', 'swatch', 'closure', 'in_hand'])).max(4),
  assetQualityConfidence: z.number().min(0).max(1),
  multipleProductsVisible: z.boolean(),
  /** Photos that need compliance review before use (plan 05 §14 "before/after and minors"), by 0-based position. */
  imageReview: z.array(z.object({ index: z.number().int().min(0).max(9), beforeAfter: z.boolean(), possibleMinor: z.boolean() })).max(10).optional(),
});
export type ProductExtraction = z.infer<typeof ProductExtraction>;

export const Proposal = z.object({
  hypothesis: z.string().min(10).max(220),
  customerTension: z.string().max(200),
  customerTensionSource: z.enum(['reviews', 'category_pattern', 'product_page', 'performance']),
  whyNow: z.string().max(220),
  primaryVariable: z.enum(['hook', 'angle', 'proof', 'format', 'offer', 'talent', 'pacing']),
  angle: z.enum(Taxonomy.angle),
  hookMechanism: z.enum(Taxonomy.hook),
  hookOptions: z.array(z.string().min(3).max(90)).length(3),
  bodyStrategy: z.string().max(300),
  proofMechanism: z.enum(Taxonomy.proof),
  treatment: z.enum(Taxonomy.treatment),
  claimWordings: z.array(z.string().max(200)).max(4),
  expectedLearning: z.string().max(220),
  ifTestFails: z.string().max(220),
  riskProfile: z.enum(['lower_risk', 'adjacent', 'exploratory']),
  estimatedGenerationClass: z.enum(['remix', 'hybrid_short', 'generative_short', 'premium']),
  /**
   * The context-packet items this idea rests on, by their `id` (customer themes, learnings, approved claims,
   * product facts) — the rationale we show instead of chain-of-thought (§38). Unknown ids are dropped by the gate.
   */
  rationaleIds: z.array(z.string().max(64)).max(8).optional().describe('ids of context-packet items (themes, learnings, claims, facts) this idea is grounded in'),
});
export type Proposal = z.infer<typeof Proposal>;

export const ConceptSet = z.object({
  concepts: z.array(Proposal).length(3),
  pickIndex: z.number().int().min(0).max(2),
  pickReason: z.string().max(200),
});
export type ConceptSet = z.infer<typeof ConceptSet>;

export const StoryboardPlan = z.object({
  hook: z.string().max(90),
  cta: z.string().max(40),
  voiceover: z.string().max(420),
  scenes: z
    .array(
      z.object({
        purpose: z.enum(['hook', 'problem', 'product_reveal', 'demonstration', 'proof', 'benefit', 'routine', 'cta']),
        durationMs: z.number().int().min(1000).max(6000),
        visualPlan: z.string().max(300),
        productBehavior: z.string().max(160).nullable(),
        spokenLine: z.string().max(160).nullable(),
        overlayText: z.string().max(70).nullable(),
        productionMode: z.enum(['STRICT_COMPOSITE', 'GENERATIVE_INTERACTION', 'HYBRID', 'REAL_ASSET_REMIX']),
        showsHumanSkin: z.boolean(),
      }),
    )
    .min(3)
    .max(6),
});
export type StoryboardPlan = z.infer<typeof StoryboardPlan>;

export const ThemeSet = z.object({
  themes: z
    .array(
      z.object({
        label: z.string().max(60),
        signalType: z.enum(['objection', 'benefit', 'question', 'usage', 'sentiment']),
        intensity: z.number().min(0).max(1),
        sentiment: z.number().min(-1).max(1).describe('Polarity of what customers say in this theme: -1 negative … 1 positive'),
        snippetIndexes: z.array(z.number().int().min(0)).max(5).describe('Up to 5 representative snippets'),
        matchIndexes: z.array(z.number().int().min(0)).max(400).describe('Every snippet that expresses this theme'),
      }),
    )
    .max(10),
});

export const Genome = z.object({
  angle: z.enum(Taxonomy.angle),
  secondaryAngle: z.enum(Taxonomy.angle).nullable(),
  hookMechanism: z.enum(Taxonomy.hook),
  hookText: z.string().max(160).nullable(),
  proofMechanism: z.enum(Taxonomy.proof),
  treatment: z.enum(Taxonomy.treatment),
  customerProblem: z.string().max(120).nullable(),
  productRevealSec: z.number().min(0).max(60).nullable(),
  faceRevealSec: z.number().min(0).max(60).nullable(),
  durationSec: z.number().min(0).max(300).nullable(),
  hasCaptions: z.boolean(),
  hasVoiceover: z.boolean(),
  offer: z.string().max(80).nullable(),
});
export type Genome = z.infer<typeof Genome>;

export const FidelityCheck = z.object({
  sameProduct: z.boolean(),
  labelTextMatches: z.boolean(),
  closureMatches: z.boolean(),
  colorMatches: z.boolean(),
  productCount: z.number().int().min(0).max(10),
  handsOrFacesDeformed: z.boolean(),
  skinAlteredUnnaturally: z.boolean(),
  impliesMedicalResult: z.boolean(),
  notes: z.string().max(300),
  /** Label text read on the generated frame (fidelity@1.1.0), for the QA review OCR diff (plan 05 §13). */
  labelTextRead: z.string().max(400).nullable().optional(),
  /** A person who looks under 18 appears (fidelity@1.2.0; standard §48 "synthetic talent appears under 18"). */
  apparentMinorPresent: z.boolean().optional(),
});
export type FidelityCheck = z.infer<typeof FidelityCheck>;

/** Whole-creative implied-claim scan (implied-claims@1.1.0; standard §43 "Visual implies a medical result"). */
export const ImpliedClaimsCheck = z.object({
  impliedClaims: z
    .array(
      z.object({
        /** The implication in plain words ("the serum clears acne"). */
        claim: z.string().max(200),
        /** What carries it: the words alone, the pictures alone, or the two together. */
        basis: z.enum(['text', 'visual', 'combined']),
        /** 'block': a medical, structure/function or before/after outcome; 'review': borderline. */
        severity: z.enum(['block', 'review']),
        /** 1-based scene the implication comes from, when it is one scene. */
        scene: z.number().int().min(1).max(20).nullable(),
      }),
    )
    .max(10),
  notes: z.string().max(300),
});
export type ImpliedClaimsCheck = z.infer<typeof ImpliedClaimsCheck>;

/** Cross-scene continuity of AI-generated people (continuity@1.0.0; standard §44, §48 skin tone). */
export const ContinuityCheck = z.object({
  /** The same person (face, hands, age presentation) across the frames. */
  talentConsistent: z.boolean(),
  /** No material lightening, darkening or complexion drift between the frames. */
  skinToneConsistent: z.boolean(),
  /** 1-based indexes of the frames that break continuity with the first. */
  inconsistentFrames: z.array(z.number().int().min(1).max(20)).max(20),
  notes: z.string().max(300),
});
export type ContinuityCheck = z.infer<typeof ContinuityCheck>;
