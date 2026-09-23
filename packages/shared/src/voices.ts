import { env } from './env';

/**
 * Logical voice catalogue (plan 06 Phase 3 #4: MiniMax primary, BytePlus Seed Speech fallback). Production asks
 * for a logical voice; the Model Gateway resolves the provider-specific id for whichever provider serves the
 * call, so a MiniMax voice id is never sent to Seed Speech (or the reverse).
 *
 * Provider ids that have passed the listening test are listed here. Others (notably Seed Speech speakers) are
 * configured per environment in TTS_VOICE_MAP, e.g. {"warm_female":{"byteplus-speech":"<speaker id>"}}; a
 * provider with no id for the requested voice is simply not used for it.
 */
export const LogicalVoice = ['warm_female'] as const;
export type LogicalVoice = (typeof LogicalVoice)[number];
export const DEFAULT_VOICE: LogicalVoice = 'warm_female';

export const VOICE_CATALOGUE: Record<LogicalVoice, { label: string; providers: Partial<Record<string, string>> }> = {
  warm_female: { label: 'Warm, calm female voice', providers: { minimax: 'English_Graceful_Lady' } },
};

export const isLogicalVoice = (v: unknown): v is LogicalVoice => typeof v === 'string' && (LogicalVoice as readonly string[]).includes(v);

function overrides(): Record<string, Record<string, string>> {
  const raw = env().TTS_VOICE_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Record<string, string>>) : {};
  } catch {
    return {};
  }
}

/** Provider-specific voice id for a logical voice, or null when that provider has no approved voice for it. */
export function providerVoiceId(voice: string, provider: string): string | null {
  const logical = isLogicalVoice(voice) ? voice : DEFAULT_VOICE;
  const id = overrides()[logical]?.[provider] ?? VOICE_CATALOGUE[logical].providers[provider] ?? null;
  if (id) return id;
  // Mock providers accept any id; keep the fallback path exercisable in tests and local runs.
  return env().PROVIDERS_MODE === 'mock' ? `mock:${provider}:${logical}` : null;
}
