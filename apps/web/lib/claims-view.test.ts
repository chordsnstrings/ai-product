import { describe, expect, it } from 'vitest';
import { addBusinessDays, claimActorLabel, marketName } from './claims-view';

describe('Claims Vault helpers (plan 03 A5)', () => {
  it('counts the compliance review in business days', () => {
    // Thu 24 Sep 2026 → Mon 28 Sep; Fri → Tue; Sat → Tue.
    expect(addBusinessDays(new Date('2026-09-24T10:00:00Z'), 2).toISOString().slice(0, 10)).toBe('2026-09-28');
    expect(addBusinessDays(new Date('2026-09-25T10:00:00Z'), 2).toISOString().slice(0, 10)).toBe('2026-09-29');
    expect(addBusinessDays(new Date('2026-09-26T10:00:00Z'), 2).toISOString().slice(0, 10)).toBe('2026-09-29');
    expect(addBusinessDays(new Date('2026-09-22T10:00:00Z'), 2).toISOString().slice(0, 10)).toBe('2026-09-24');
  });

  it('names the market scope in words', () => {
    expect(marketName('US')).toBe('United States');
    expect(marketName('gb')).toBe('United Kingdom');
  });

  it('names who changed a claim without raw ids', () => {
    const members = new Map([['u1', 'Ana Ruiz']]);
    expect(claimActorLabel('user:u1', members)).toBe('Ana Ruiz');
    expect(claimActorLabel('user:gone', members)).toBe('A former member');
    expect(claimActorLabel('staff:s1>u1', members)).toBe('Arkiv compliance team');
    expect(claimActorLabel('system:sweep-evidence', members)).toBe('Automatic check');
    expect(claimActorLabel('weird', members)).toBe('Arkiv');
  });
});
