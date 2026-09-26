import { describe, expect, it } from 'vitest';
import { assertVariantWeights, assignVariant, assignVariantOrNull } from './flags';

function split(variants: { key: string; weight: number }[], n = 10_000) {
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const k = assignVariant('exp:test', `subject-${i}`, variants);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

describe('assignVariant (deterministic, weight-proportional)', () => {
  it('splits fractional weights near their proportions (regression: 0.5/0.5 sent everyone to A)', () => {
    const c = split([{ key: 'A', weight: 0.5 }, { key: 'B', weight: 0.5 }]);
    expect(c.A! / 10_000).toBeGreaterThan(0.47);
    expect(c.A! / 10_000).toBeLessThan(0.53);
    expect(c.B! / 10_000).toBeGreaterThan(0.47);
  });

  it('honours uneven fractional and integer weights alike', () => {
    const f = split([{ key: 'A', weight: 0.2 }, { key: 'B', weight: 0.8 }]);
    expect(f.A! / 10_000).toBeGreaterThan(0.17);
    expect(f.A! / 10_000).toBeLessThan(0.23);
    const i = split([{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }, { key: 'C', weight: 2 }]);
    expect(i.C! / 10_000).toBeGreaterThan(0.47);
    expect(i.C! / 10_000).toBeLessThan(0.53);
  });

  it('is sticky per subject', () => {
    const v = [{ key: 'A', weight: 0.3 }, { key: 'B', weight: 0.7 }];
    expect(assignVariant('k', 'ws-1', v)).toBe(assignVariant('k', 'ws-1', v));
  });

  it('never assigns a zero-weight (paused) arm', () => {
    const c = split([{ key: 'A', weight: 0 }, { key: 'B', weight: 0.4 }], 2000);
    expect(c.A).toBeUndefined();
    expect(c.B).toBe(2000);
  });

  it('rejects all-zero, negative or non-finite weights instead of returning NaN buckets', () => {
    expect(() => assignVariant('k', 's', [{ key: 'A', weight: 0 }, { key: 'B', weight: 0 }])).toThrow(/positive weight/);
    expect(() => assertVariantWeights([{ key: 'A', weight: -1 }, { key: 'B', weight: 2 }])).toThrow(/non-negative/);
    expect(() => assertVariantWeights([{ key: 'A', weight: Number.NaN }])).toThrow(/non-negative/);
    expect(assignVariantOrNull('k', 's', [{ key: 'A', weight: 0 }])).toBeNull();
    expect(assignVariantOrNull('k', 's', [])).toBeNull();
  });
});
