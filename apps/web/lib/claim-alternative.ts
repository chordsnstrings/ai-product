/**
 * Compliant alternatives for blocked claims (plan 03 A3/A5 edges, standard §43 "Merchant insists on blocked
 * claim": explain the restriction and propose factual / appearance-oriented alternatives).
 *
 * The rules' alternative is advice ("Say “reduces the look of fine lines”."); when it quotes an example wording,
 * that wording is what a "Use this wording" button puts into the field.
 */
export interface BlockedAlternative {
  /** The advice, as the rules state it. */
  advice: string;
  /** The example wording the advice quotes, when it quotes one. */
  wording: string | null;
  /** The text that was blocked, when the server named it. */
  text: string | null;
}

/** The first quoted example in the advice ("…", “…”, or ‘…’), without trailing punctuation. */
export function suggestedWording(advice: string | null | undefined): string | null {
  if (!advice) return null;
  const m = /[“"‘]([^“”"‘’]{3,120})[”"’]/.exec(advice);
  const w = m?.[1]?.trim().replace(/[.,;:]+$/, '').trim();
  return w ? w : null;
}

/** The alternative an API error carries (DomainError details.alternative), or null. */
export function blockedAlternative(err: unknown): BlockedAlternative | null {
  const d = (err as { details?: { alternative?: unknown; text?: unknown } } | null)?.details;
  const advice = typeof d?.alternative === 'string' ? d.alternative.trim() : '';
  if (!advice) return null;
  return { advice, wording: suggestedWording(advice), text: typeof d?.text === 'string' ? d.text : null };
}

/**
 * Which of a scene's two text fields the blocked text came from, so "Use this wording" replaces that one: the
 * field that contains the blocked text, else the spoken line.
 */
export function fieldForAlternative(fields: { spokenLine: string; overlayText: string }, alt: Pick<BlockedAlternative, 'text'>): 'spokenLine' | 'overlayText' {
  const t = alt.text?.trim().toLowerCase();
  if (t && !fields.spokenLine.toLowerCase().includes(t) && fields.overlayText.toLowerCase().includes(t)) return 'overlayText';
  return 'spokenLine';
}
