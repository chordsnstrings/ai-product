import type { Aspect, Cue } from '@arkiv/media';

/**
 * Composition manifest (standard §24: "composition is reproducible from scene versions"). Stored on the creative:
 * exactly which scene version and asset filled each slot, what was shown and said, the voice-over segments and
 * the end card. Hook variants are built from the master's manifest, and experiment-integrity QA (§25 check 6)
 * compares manifests instead of trusting the declared change.
 */

export interface ManifestScene {
  sceneId: string;
  position: number;
  purpose: string;
  kind: 'still' | 'video';
  /** Asset that filled this slot (frame or render). */
  assetId: string | null;
  /** scene_versions row it came from (null for a frame drawn at composition time and not versioned). */
  versionId: string | null;
  technique: string;
  overlayText: string | null;
  /** The overlay as written, when it uses fact tokens ({price}, {size}): recomposed when those facts change (§42). */
  overlayTemplate?: string | null;
  spokenText: string | null;
  durationMs: number;
  claimIds: string[];
}

export interface VoiceSegment {
  sceneId: string;
  text: string;
  clipAssetId: string;
  startMs: number;
  endMs: number;
  tempo: number;
}

export interface CompositionManifest {
  version: 1;
  skuId: string;
  cutoutAssetId: string | null;
  /** Body scenes in timeline order; the end card follows. */
  scenes: ManifestScene[];
  voiceover: { voice: string; segments: VoiceSegment[] } | null;
  captions: Cue[];
  endCard: { productName: string; cta: string; index: string; durationMs: number; sceneId: string | null; spokenText: string | null; accent?: string | null; note?: string | null; price?: string | null; ctaTemplate?: string | null };
  /** The product facts on screen through tokens, as used (price, size): what a later change recomposes against. */
  tokens?: FactTokens | null;
  /** A spoken line said a token's value: a change then needs a new voice line, not only a recomposition. */
  tokensSpoken?: boolean;
  durationMs: number;
  aspects: Aspect[];
  genes: Record<string, unknown>;
  /** What in this ad is AI-generated (standard §40): drives platform disclosure guidance and export metadata. */
  disclosure?: AiDisclosure;
}

/** Facts an ad shows through {price} / {size} tokens: the value shown and the fact it came from. */
export interface FactTokens {
  price: { factId: string; text: string } | null;
  size: { factId: string; text: string } | null;
}

const TOKEN_RE = /\{(price|size)\}/g;

/** Whether a text uses fact tokens. */
export const hasFactTokens = (text: string | null | undefined) => !!text && /\{(price|size)\}/.test(text);

/** Replace {price} / {size} with the current facts (a token with no fact is dropped, never invented, §42). */
export function resolveFactTokens(text: string, tokens: FactTokens): string {
  return text
    .replace(TOKEN_RE, (_, k: 'price' | 'size') => tokens[k]?.text ?? '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim()
    .replace(/^[·—-]\s*|\s*[·—-]$/g, '')
    .trim();
}

/** The price as shown on an ad: currency symbol for the common currencies, two decimals unless whole. */
export function formatPrice(amount: number, currency = 'USD'): string {
  const sym: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$' };
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return sym[currency.toUpperCase()] ? `${sym[currency.toUpperCase()]}${n}` : `${n} ${currency.toUpperCase()}`;
}

/** AI-generated media in an ad (standard §40 "AI-generated talent and synthetic media must follow platform disclosure"). */
export interface AiDisclosure {
  /** Any AI-generated footage, image, setting or voice. */
  aiGenerated: boolean;
  /** AI-generated people (hands, skin, faces) on screen. */
  syntheticPeople: boolean;
  /** A synthesized voice-over. */
  syntheticVoice: boolean;
  /** Scenes whose visuals are (partly) AI-generated. */
  generatedScenes: string[];
}

/** Container metadata for an export: a human-readable note and a machine-readable summary. */
export function disclosureMetadata(d: AiDisclosure | null | undefined): Record<string, string> {
  if (!d?.aiGenerated) return {};
  const parts = [d.generatedScenes.length ? 'AI-generated visuals' : null, d.syntheticPeople ? 'AI-generated people' : null, d.syntheticVoice ? 'AI-generated voice' : null].filter(Boolean);
  return {
    comment: `Contains AI-generated media: ${parts.join(', ')}. Disclose as AI-generated where the platform requires it.`,
    description: `ai_generated=true; synthetic_people=${d.syntheticPeople}; synthetic_voice=${d.syntheticVoice}`,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The experiment variables in which two compositions differ (§20 held_constant vocabulary):
 *  - hook: the opening scene — its footage, on-screen text, spoken line or voice segment;
 *  - scenes_2_plus / body: any later scene's footage, text or length;
 *  - voiceover: the voice, or any spoken segment after the hook;
 *  - cta: the end card's call to action or its spoken line; product: the SKU, its cut-out or the end-card name;
 *  - duration: total length; angle / hook_mechanism / proof / treatment: the creative genes.
 */
export function diffCompositions(base: CompositionManifest, next: CompositionManifest): string[] {
  const changed = new Set<string>();
  const [h0, h1] = [base.scenes[0], next.scenes[0]];
  const sceneKey = (s: ManifestScene | undefined) => s && { assetId: s.assetId, versionId: s.versionId, overlayText: s.overlayText, spokenText: s.spokenText, durationMs: s.durationMs, kind: s.kind };
  if (!same(sceneKey(h0), sceneKey(h1))) changed.add('hook');
  if (!same(base.scenes.slice(1).map(sceneKey), next.scenes.slice(1).map(sceneKey))) {
    changed.add('scenes_2_plus');
    changed.add('body');
  }
  const seg = (m: CompositionManifest, sceneId: string | undefined) => m.voiceover?.segments.find((s) => s.sceneId === sceneId) ?? null;
  const segKey = (s: VoiceSegment | null) => s && { text: s.text, clipAssetId: s.clipAssetId, startMs: s.startMs, endMs: s.endMs, tempo: s.tempo };
  if (!same(segKey(seg(base, h0?.sceneId)), segKey(seg(next, h1?.sceneId)))) changed.add('hook');
  const rest = (m: CompositionManifest, hookId: string | undefined) => (m.voiceover?.segments ?? []).filter((s) => s.sceneId !== hookId).map(segKey);
  if ((base.voiceover?.voice ?? null) !== (next.voiceover?.voice ?? null) || !same(rest(base, h0?.sceneId), rest(next, h1?.sceneId))) changed.add('voiceover');
  if (base.endCard.cta !== next.endCard.cta || base.endCard.spokenText !== next.endCard.spokenText || base.endCard.index !== next.endCard.index || (base.endCard.note ?? null) !== (next.endCard.note ?? null) || (base.endCard.accent ?? null) !== (next.endCard.accent ?? null)) changed.add('cta');
  if (base.skuId !== next.skuId || base.cutoutAssetId !== next.cutoutAssetId || base.endCard.productName !== next.endCard.productName) changed.add('product');
  if (base.durationMs !== next.durationMs || base.endCard.durationMs !== next.endCard.durationMs) changed.add('duration');
  const genes: [string, string][] = [['angle', 'angle'], ['hookMechanism', 'hook_mechanism'], ['proofMechanism', 'proof'], ['treatment', 'treatment']];
  for (const [k, v] of genes) if (!same(base.genes[k], next.genes[k])) changed.add(v);
  return [...changed].sort();
}
