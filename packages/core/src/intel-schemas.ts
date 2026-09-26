import { z } from 'zod';
import { Taxonomy } from '@arkiv/shared';

/** Structured model outputs. Opus proposes; these schemas + deterministic gates validate (§22). */

/** How a photo shows the product (standard §16 Visual Fingerprint views). */
export const PHOTO_VIEWS = ['front', 'side', 'back', 'closure', 'swatch', 'in_hand', 'other'] as const;
export type PhotoView = (typeof PHOTO_VIEWS)[number];

/** A region of a photo as fractions of its width/height (0–1), top-left origin. */
export const BoxSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) });
export type Box = z.infer<typeof BoxSchema>;

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
  claimsFound: z
    .array(
      z.object({
        wording: z.string().max(200),
        sourceQuote: z.string().max(300),
        /** What the claim means in plain words, the same for every phrasing of it (standard §17 canonical_meaning). */
        canonicalMeaning: z.string().max(160).nullable().optional().describe('The claim’s meaning in plain words, identical for every phrasing of the same claim'),
      }),
    )
    .max(12),
  /** How to use the product, as the page or label states it (standard §16 "usage directions"); null if not stated. */
  usageDirections: z.string().max(400).nullable().optional().describe('Usage directions exactly as the page or label states them; null if not stated'),
  /** Each photo's view of the product, by 0-based position (standard §16 "front/side/back views"). */
  photoViews: z
    .array(z.object({ index: z.number().int().min(0).max(9), view: z.enum(PHOTO_VIEWS) }))
    .max(10)
    .optional(),
  /** Where the label and the closure are, in the first photo, as fractions of the photo (0–1). */
  labelBox: BoxSchema.nullable().optional().describe('The main label in the first photo, as fractions of the photo; null if not visible'),
  closureBox: BoxSchema.nullable().optional().describe('The cap/dropper/pump in the first photo, as fractions of the photo; null if not visible'),
  /** Package geometry (standard §16 "package type and geometry"). */
  geometry: z
    .object({
      silhouette: z.enum(['cylinder', 'square', 'rectangular', 'oval', 'tube', 'jar', 'pouch', 'irregular']),
      /** Height ÷ width of the package as it stands. */
      aspectRatio: z.number().min(0.1).max(10).nullable(),
    })
    .nullable()
    .optional(),
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

/** Controlled values of the §19 genome families beyond Appendix A (the taxonomy families stay in Taxonomy). */
export const FUNNEL_INTENTS = ['awareness', 'consideration', 'conversion', 'retention'] as const;
export const FIRST_FRAME_SUBJECTS = ['product', 'face', 'hands', 'texture', 'text', 'lifestyle', 'other'] as const;
export const BODY_BEATS = ['problem', 'texture_demo', 'application', 'routine', 'ingredient_education', 'comparison', 'testimonial', 'social_proof', 'objection_resolution', 'benefit', 'product_reveal', 'cta'] as const;
export const VOICE_KINDS = ['none', 'creator', 'voiceover_human', 'voiceover_synthetic'] as const;
export const MUSIC_KINDS = ['none', 'licensed', 'trending', 'original', 'unknown'] as const;
export const POLISH_STYLES = ['raw_ugc', 'polished_ugc', 'studio', 'mixed'] as const;
export const CREATOR_CONNECTIONS = ['none', 'paid', 'gifted', 'employee', 'founder', 'unknown'] as const;

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
  // Standard §19 genome families beyond the taxonomy genes (genome@1.1.0). Optional: genomes extracted before them
  // have none.
  /** Strategy: what the ad promises, the objection it answers, its benefit and ingredient proposition, its intent. */
  desiredOutcome: z.string().max(120).nullable().optional(),
  objection: z.string().max(120).nullable().optional(),
  benefit: z.string().max(120).nullable().optional(),
  ingredientProposition: z.string().max(120).nullable().optional(),
  funnelIntent: z.enum(FUNNEL_INTENTS).nullable().optional(),
  emotionalFrame: z.string().max(60).nullable().optional(),
  /** Hook: what the first frame shows and what moves first. */
  firstFrameSubject: z.enum(FIRST_FRAME_SUBJECTS).nullable().optional(),
  firstMotion: z.string().max(80).nullable().optional(),
  /** Body/proof: the beats after the hook, in order. */
  bodySequence: z.array(z.enum(BODY_BEATS)).max(8).optional(),
  /** Production. */
  sceneCount: z.number().int().min(0).max(60).nullable().optional(),
  cutsPerMinute: z.number().min(0).max(240).nullable().optional(),
  humanScreenRatio: z.number().min(0).max(1).nullable().optional(),
  productScreenRatio: z.number().min(0).max(1).nullable().optional(),
  voice: z.enum(VOICE_KINDS).nullable().optional(),
  music: z.enum(MUSIC_KINDS).nullable().optional(),
  polish: z.enum(POLISH_STYLES).nullable().optional(),
  /** Compliance: implied claims, before/after, the creator's connection to the brand. */
  impliedClaimFlags: z.array(z.string().max(120)).max(6).optional(),
  beforeAfter: z.boolean().optional(),
  creatorConnection: z.enum(CREATOR_CONNECTIONS).nullable().optional(),
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
  /** Hands and product don't interact plausibly (fidelity@1.3.0; standard §25.2 "object interactions"). */
  objectInteractionBroken: z.boolean().optional(),
  /** Motion, liquid or objects that could not happen (fidelity@1.3.0; §25.2 "impossible physics"). */
  impossiblePhysics: z.boolean().optional(),
  /** Warped or garbled background, text or props (fidelity@1.3.0; §25.2 "background artifacts"). */
  backgroundArtifacts: z.boolean().optional(),
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
