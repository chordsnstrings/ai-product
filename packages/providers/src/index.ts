import { env } from '@arkiv/shared';
import type { ImageProvider, LlmProvider, SegmentationProvider, TtsProvider, VideoProvider } from './types';
import { MockImage, MockLlm, MockSegmentation, MockTts, MockVideo } from './mock';

export * from './types';
export { MockImage, MockLlm, MockSegmentation, MockTts, MockVideo } from './mock';

export interface ProviderSet {
  llm: LlmProvider;
  image: ImageProvider;
  video: VideoProvider;
  tts: TtsProvider;
  /** Adapter for the approved TTS fallback route; null when that provider isn't configured (never an alias of the primary). */
  ttsFallback: TtsProvider | null;
  /** Background removal for product cut-outs (task `vision.cutout`); absent → the cut-out stays with keying. */
  segmentation?: SegmentationProvider | null;
  /**
   * Further adapters by provider name, for approved fallback routes on another provider (standard §53 "fallback
   * providers"; §44 "optional approved fallback provider"): a route whose provider has no adapter here (or as the
   * primary) can't be dispatched to.
   */
  named?: { llm?: Record<string, LlmProvider>; image?: Record<string, ImageProvider>; video?: Record<string, VideoProvider> };
  /** Logical model name (used for rate tables) → provider model id actually sent on the wire. */
  wireModel(logical: string): string;
}

let cached: ProviderSet | undefined;

/**
 * Provider registry. Only the core Model Gateway may use it (it enforces Cost Governor authorization);
 * nothing else imports adapters directly (engineering rule 54.3).
 */
export async function providers(): Promise<ProviderSet> {
  if (cached) return cached;
  const e = env();
  const wire: Record<string, string> = {
    'claude-opus-5-5': e.ANTHROPIC_MODEL,
    'seedream-5-0-pro': e.SEEDREAM_MODEL,
    'dreamina-seedance-2-5': e.SEEDANCE_MODEL,
    'speech-2.8-hd': e.MINIMAX_TTS_MODEL,
  };
  const wireModel = (logical: string) => wire[logical] ?? logical;
  if (e.PROVIDERS_MODE === 'mock') {
    const video = new MockVideo();
    // Mock secondaries: a fallback route on the "mock-backup" provider is served by these (staff can route to it).
    const named = { llm: { 'mock-backup': new MockLlm('mock-backup') }, image: { 'mock-backup': new MockImage('mock-backup') }, video: { 'mock-backup': new MockVideo(50, 'mock-backup') } };
    cached = { llm: new MockLlm(), image: new MockImage(), video, tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), segmentation: new MockSegmentation(), named, wireModel };
    return cached;
  }
  const { AnthropicLlm } = await import('./live/anthropic');
  const { SeedreamImage, SeedreamCutout, SeedanceVideo, MiniMaxTts, SeedSpeechTts } = await import('./live/byteplus');
  const need = (k: keyof typeof e) => {
    const v = e[k];
    if (!v) throw new Error(`PROVIDERS_MODE=live requires ${String(k)}`);
    return v as string;
  };
  cached = {
    llm: new AnthropicLlm(e.ANTHROPIC_API_KEY),
    image: new SeedreamImage(need('ARK_API_KEY'), e.ARK_BASE_URL),
    // Plan 06 Phase 1 #6 decision: background removal is a Seedream edit onto a flat backdrop, keyed in-process.
    segmentation: new SeedreamCutout(need('ARK_API_KEY'), e.ARK_BASE_URL),
    video: new SeedanceVideo(need('ARK_API_KEY'), e.ARK_BASE_URL, e.SEEDANCE_MAX_REFS),
    tts: new MiniMaxTts(need('MINIMAX_API_KEY'), e.MINIMAX_BASE_URL),
    // The fallback route is priced and recorded as Seed Speech, so only a Seed Speech adapter may serve it.
    ttsFallback: e.BYTEPLUS_SPEECH_APP_ID && e.BYTEPLUS_SPEECH_TOKEN ? new SeedSpeechTts(e.BYTEPLUS_SPEECH_APP_ID, e.BYTEPLUS_SPEECH_TOKEN) : null,
    wireModel,
  };
  return cached;
}

/** Tests can inject providers (e.g. a slow or failing video provider). */
export function setProviders(p: ProviderSet | undefined) {
  cached = p;
}

/** The adapter of `kind` that serves `provider`: the primary when it is that provider, else a named one (or null). */
export function adapterFor<K extends 'llm' | 'image' | 'video'>(p: ProviderSet, kind: K, provider: string): ProviderSet[K] | null {
  if (p[kind].name === provider) return p[kind];
  return ((p.named?.[kind] as Record<string, ProviderSet[K]> | undefined)?.[provider] ?? null) as ProviderSet[K] | null;
}
