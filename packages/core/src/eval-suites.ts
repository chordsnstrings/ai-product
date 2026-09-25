import sharp from 'sharp';
import type { z } from 'zod';
import type { ContentPart } from '@arkiv/providers';
import { Taxonomy } from '@arkiv/shared';
import { gateProposal, normalizePlan } from './creative-director';
import { ConceptSet, ContinuityCheck, FidelityCheck, Genome, ImpliedClaimsCheck, ProductExtraction, StoryboardPlan, ThemeSet } from './intel-schemas';
import { mockConcepts, mockExtraction, mockGenome, mockStoryboard, mockThemes, type ProductContext } from './mock-intel';
import { impliedClaimSignals } from './qa';

/**
 * Per-task golden suites for model-backed routes (standard §22 "accuracy must be evaluated against a curated
 * benchmark before routing is changed"; §41 "model routing is allowed only after evaluation"). Each suite says how a
 * golden case is sent to the candidate template × model, what the mock adapter answers (PROVIDERS_MODE=mock), and
 * how the model's answer is scored into a label compared with the case's expected label. Media suites (image, video,
 * voice, cut-out) run the candidate on each case and check the output is usable — deterministic checks until
 * visual goldens exist.
 */
export interface LlmSuite<T = unknown> {
  kind: 'model';
  schema: z.ZodType<T>;
  maxTokens: number;
  content(input: string): Promise<ContentPart[]> | ContentPart[];
  mock(input: string): T;
  score(out: T, input: string): string;
}

export interface MediaSuite {
  kind: 'media';
  media: 'image' | 'video' | 'tts' | 'cutout';
}

/** A model suite, typed by its output schema. */
const llm = <T>(s: Omit<LlmSuite<T>, 'kind'>): LlmSuite => ({ kind: 'model', ...s }) as LlmSuite;

// ───────────── Helpers ─────────────

/** A case describing a product: JSON {name, category, description?, texture?}. */
function product(input: string): ProductContext & { description?: string } {
  const p = JSON.parse(input) as { name: string; category?: string; description?: string; texture?: string };
  return { name: p.name, category: p.category ?? 'serum', texture: p.texture ?? null, approvedClaims: [], themes: [], testedAngles: [], description: p.description };
}

/** The product as model content: the trusted packet (no claims approved) and the page-derived facts, delimited. */
const productParts = (input: string): ContentPart[] => {
  const p = product(input);
  return [
    { type: 'text', text: `Context packet (JSON; text imported from the product page is in the untrusted source that follows):\n${JSON.stringify({ claims: { APPROVED_IDS: [] }, customerThemes: [], coverage: [], learnings: [], platform: 'TikTok + Instagram Reels (9:16)', objective: 'Find the next creative test worth running for this SKU', goal: 'performance' })}` },
    { type: 'untrusted', sourceId: 'product_facts', text: JSON.stringify({ name: p.name, category: p.category, texture: p.texture, description: p.description ?? null }) },
  ];
};

/** Concepts pass when every one clears the claims gate with all its hooks intact (nothing had to be stripped). */
function conceptsLabel(out: ConceptSet, input: string): string {
  const p = product(input);
  const ok =
    out.concepts.length > 0 &&
    out.concepts.every((c) => {
      const g = gateProposal(c, [], [p.name], { pad: false });
      return g.ok && g.removed.hooks === 0 && g.removed.claims === 0;
    });
  return ok ? 'compliant' : 'violating';
}

/** A solid-colour product "photo" (a bottle on a paper backdrop) for the visual-QA suites. */
async function swatch(bottle: string, backdrop = '#f4efe6'): Promise<string> {
  const img = await sharp({ create: { width: 320, height: 480, channels: 3, background: backdrop } })
    .composite([{ input: await sharp({ create: { width: 120, height: 280, channels: 3, background: bottle } }).png().toBuffer(), left: 100, top: 120 }])
    .jpeg({ quality: 80 })
    .toBuffer();
  return img.toString('base64');
}

// ───────────── Suites ─────────────

export const MODEL_SUITES: Record<string, LlmSuite | MediaSuite> = {
  'extract.packaging': llm<ProductExtraction>({
    schema: ProductExtraction,
    maxTokens: 2000,
    content: (input) => [{ type: 'untrusted', sourceId: 'golden_case', text: JSON.stringify({ name: null, description: input }) }],
    mock: (input) => mockExtraction({ description: input, text: input }),
    score: (out) => out.packaging.type,
  }),
  'concepts.compliant': llm<ConceptSet>({
    schema: ConceptSet,
    maxTokens: 6000,
    content: (input) => [...productParts(input), { type: 'text', text: 'Propose the first three tests.' }],
    mock: (input) => mockConcepts(product(input)),
    score: conceptsLabel,
  }),
  'recommendations.compliant': llm<ConceptSet>({
    schema: ConceptSet,
    maxTokens: 6000,
    content: (input) => [...productParts(input), { type: 'text', text: 'Weekly planning. Basis: cold_start. SKU maturity: COLD. Candidate set 1 of 2.' }],
    mock: (input) => mockConcepts(product(input)),
    score: conceptsLabel,
  }),
  'storyboard.compliant': llm<StoryboardPlan>({
    schema: StoryboardPlan,
    maxTokens: 6000,
    content: (input) => [...productParts(input), { type: 'text', text: `Approved concept:\n${JSON.stringify(mockConcepts(product(input)).concepts[0])}` }],
    mock: (input) => {
      const p = product(input);
      return mockStoryboard(p, mockConcepts(p).concepts[0]!);
    },
    score: (out, input) => {
      try {
        normalizePlan(out, [], [product(input).name]);
        return 'compliant';
      } catch {
        return 'violating';
      }
    },
  }),
  'genome.angle': llm<Genome>({
    schema: Genome,
    maxTokens: 1500,
    content: (input) => [{ type: 'untrusted', sourceId: 'ad_copy', text: input }, { type: 'text', text: `Taxonomy v${Taxonomy.version}.` }],
    mock: (input) => mockGenome(input),
    score: (out) => out.angle,
  }),
  'themes.top': llm<z.infer<typeof ThemeSet>>({
    schema: ThemeSet,
    maxTokens: 4000,
    content: (input) => [{ type: 'untrusted', sourceId: 'reviews', text: input.split('\n').map((t, i) => `[${i}] ${t}`).join('\n') }],
    mock: (input) => mockThemes(input.split('\n')) as z.infer<typeof ThemeSet>,
    // The theme covering the most reviews is the one the case names.
    score: (out) => [...out.themes].sort((a, b) => b.matchIndexes.length - a.matchIndexes.length)[0]?.signalType ?? 'none',
  }),
  'implied.model': llm<ImpliedClaimsCheck>({
    schema: ImpliedClaimsCheck,
    maxTokens: 1200,
    content: (input) => [{ type: 'untrusted', sourceId: 'creative', text: `Hook: —\nCall to action: —\nScene 1. Shows: ${input} Says: — On screen: —` }],
    mock: (input) => ({ impliedClaims: impliedClaimSignals([input]).map((s) => ({ claim: s.claim, basis: 'text' as const, severity: 'block' as const, scene: 1 })), notes: 'mock' }),
    score: (out) => (out.impliedClaims.some((c) => c.severity === 'block') ? 'block' : 'pass'),
  }),
  // Case input: "<reference colour> <frame colour>"; the same colour is the same product.
  'fidelity.match': llm<FidelityCheck>({
    schema: FidelityCheck,
    maxTokens: 800,
    content: async (input) => {
      const [ref, frame] = input.split(/\s+/);
      return [
        { type: 'image', mediaType: 'image/jpeg', base64: await swatch(ref!) },
        { type: 'image', mediaType: 'image/jpeg', base64: await swatch(frame!) },
        { type: 'text', text: 'Reference label text: unknown. Closure: dropper. The last image is the generated frame. Scene: the bottle on a paper backdrop.' },
      ];
    },
    mock: (input) => {
      const [ref, frame] = input.split(/\s+/);
      const same = ref?.toLowerCase() === frame?.toLowerCase();
      return { sameProduct: same, labelTextMatches: true, closureMatches: true, colorMatches: same, productCount: 1, handsOrFacesDeformed: false, skinAlteredUnnaturally: false, impliesMedicalResult: false, notes: same ? 'Matches' : 'Colour differs', labelTextRead: null };
    },
    score: (out) => (out.sameProduct && out.colorMatches ? 'pass' : 'fail'),
  }),
  // Case input: each frame's colour, space separated; one colour throughout is one consistent shot.
  'continuity.frames': llm<ContinuityCheck>({
    schema: ContinuityCheck,
    maxTokens: 600,
    content: async (input) => [
      ...(await Promise.all(input.split(/\s+/).map(async (c) => ({ type: 'image' as const, mediaType: 'image/jpeg' as const, base64: await swatch('#d9b38c', c) })))),
      { type: 'text', text: `${input.split(/\s+/).length} frames, in scene order. Frame 1 is the reference for the person's appearance.` },
    ],
    mock: (input) => {
      const cs = input.split(/\s+/).map((c) => c.toLowerCase());
      const bad = cs.map((c, i) => (c !== cs[0] ? i + 1 : 0)).filter(Boolean);
      return { talentConsistent: !bad.length, skinToneConsistent: !bad.length, inconsistentFrames: bad, notes: 'mock' };
    },
    score: (out) => (out.talentConsistent && out.skinToneConsistent ? 'consistent' : 'inconsistent'),
  }),
  'frame.render': { kind: 'media', media: 'image' },
  'plate.render': { kind: 'media', media: 'image' },
  'scene.render': { kind: 'media', media: 'video' },
  'voice.render': { kind: 'media', media: 'tts' },
  'voice_fallback.render': { kind: 'media', media: 'tts' },
  'cutout.render': { kind: 'media', media: 'cutout' },
};
