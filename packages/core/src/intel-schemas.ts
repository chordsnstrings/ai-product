import { z } from 'zod';
import { Taxonomy } from '@arkiv/shared';

/** Structured model outputs. Opus proposes; these schemas + deterministic gates validate (§22). */

export const ProductExtraction = z.object({
  name: z.string().min(1).max(160),
  brand: z.string().max(120).nullable(),
  category: z.enum(['serum', 'cleanser', 'moisturizer', 'eye', 'mask', 'facial_oil', 'toner', 'exfoliant', 'balm', 'skincare', 'not_skincare']),
  sizeText: z.string().max(40).nullable(),
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
        snippetIndexes: z.array(z.number().int().min(0)).max(5),
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
});
export type FidelityCheck = z.infer<typeof FidelityCheck>;
