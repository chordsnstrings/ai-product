import { env } from '@arkiv/shared';
import type { ImageProvider, LlmProvider, TtsProvider, VideoProvider } from './types';
import { MockImage, MockLlm, MockTts, MockVideo } from './mock';

export * from './types';
export { MockImage, MockLlm, MockTts, MockVideo } from './mock';

export interface ProviderSet {
  llm: LlmProvider;
  image: ImageProvider;
  video: VideoProvider;
  tts: TtsProvider;
  ttsFallback: TtsProvider;
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
    cached = { llm: new MockLlm(), image: new MockImage(), video, tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel };
    return cached;
  }
  const { AnthropicLlm } = await import('./live/anthropic');
  const { SeedreamImage, SeedanceVideo, MiniMaxTts, SeedSpeechTts } = await import('./live/byteplus');
  const need = (k: keyof typeof e) => {
    const v = e[k];
    if (!v) throw new Error(`PROVIDERS_MODE=live requires ${String(k)}`);
    return v as string;
  };
  cached = {
    llm: new AnthropicLlm(e.ANTHROPIC_API_KEY),
    image: new SeedreamImage(need('ARK_API_KEY'), e.ARK_BASE_URL),
    video: new SeedanceVideo(need('ARK_API_KEY'), e.ARK_BASE_URL),
    tts: new MiniMaxTts(need('MINIMAX_API_KEY'), e.MINIMAX_BASE_URL),
    ttsFallback:
      e.BYTEPLUS_SPEECH_APP_ID && e.BYTEPLUS_SPEECH_TOKEN
        ? new SeedSpeechTts(e.BYTEPLUS_SPEECH_APP_ID, e.BYTEPLUS_SPEECH_TOKEN)
        : new MiniMaxTts(need('MINIMAX_API_KEY'), e.MINIMAX_BASE_URL),
    wireModel,
  };
  return cached;
}

/** Tests can inject providers (e.g. a slow or failing video provider). */
export function setProviders(p: ProviderSet | undefined) {
  cached = p;
}
