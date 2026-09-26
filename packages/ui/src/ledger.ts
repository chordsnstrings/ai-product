/** Progress ledger helpers (design M11; WCAG 1.3.1/4.1.3): each step's status in words, and what to announce. */

export type LedgerStep = { key: string; label: string; status: string; detail?: string | null; at?: string | null; note?: string | null };

const WORDS: Record<string, string> = { done: 'done', active: 'in progress', failed: 'failed', skipped: 'skipped', pending: 'waiting' };

export const ledgerStatusWord = (status: string): string => WORDS[status] ?? status;

export const ledgerMark = (status: string): string => (status === 'done' ? '✓' : status === 'failed' ? '×' : status === 'active' ? '●' : status === 'skipped' ? '–' : '○');

/**
 * What changed between two renders of a ledger, as screen-reader messages ("Checking claims — done"). The first
 * render (no previous steps) announces nothing; a step moving back to "waiting" is not news.
 */
export function ledgerAnnouncements(prev: readonly LedgerStep[] | null, next: readonly LedgerStep[]): string[] {
  if (!prev) return [];
  const before = new Map(prev.map((s) => [s.key, s.status]));
  const out: string[] = [];
  for (const s of next) {
    const was = before.get(s.key);
    if (was === s.status || s.status === 'pending') continue;
    out.push(`${s.label} — ${ledgerStatusWord(s.status)}`);
  }
  return out;
}
