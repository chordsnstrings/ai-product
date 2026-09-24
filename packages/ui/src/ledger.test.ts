import { describe, expect, it } from 'vitest';
import { ledgerAnnouncements, ledgerMark, ledgerStatusWord, type LedgerStep } from './ledger';

const s = (key: string, status: string): LedgerStep => ({ key, label: key === 'a' ? 'Preparing your product' : 'Checking claims', status });

describe('progress ledger announcements', () => {
  it('says each status in words', () => {
    expect(ledgerStatusWord('done')).toBe('done');
    expect(ledgerStatusWord('active')).toBe('in progress');
    expect(ledgerStatusWord('failed')).toBe('failed');
    expect(ledgerStatusWord('skipped')).toBe('skipped');
    expect(ledgerStatusWord('pending')).toBe('waiting');
    expect(ledgerMark('done')).toBe('✓');
    expect(ledgerMark('pending')).toBe('○');
  });

  it('announces nothing on the first render', () => {
    expect(ledgerAnnouncements(null, [s('a', 'done'), s('b', 'active')])).toEqual([]);
  });

  it('announces the label and new status of each changed step', () => {
    expect(ledgerAnnouncements([s('a', 'active'), s('b', 'pending')], [s('a', 'done'), s('b', 'active')])).toEqual(['Preparing your product — done', 'Checking claims — in progress']);
    expect(ledgerAnnouncements([s('a', 'active')], [s('a', 'failed')])).toEqual(['Preparing your product — failed']);
  });

  it('ignores unchanged steps and steps going back to waiting', () => {
    expect(ledgerAnnouncements([s('a', 'done'), s('b', 'active')], [s('a', 'done'), s('b', 'active')])).toEqual([]);
    expect(ledgerAnnouncements([s('a', 'failed')], [s('a', 'pending')])).toEqual([]);
  });

  it('announces a step that appears already started', () => {
    expect(ledgerAnnouncements([], [s('b', 'active')])).toEqual(['Checking claims — in progress']);
  });
});
