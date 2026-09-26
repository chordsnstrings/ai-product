import { describe, expect, it } from 'vitest';
import { factualParts, mapStatements, statementCheck, type FactForStatements } from './statements';

/** Launch Gate 2 statement map (standard §50: every factual statement traced to a fact, claim or merchant decision). */
const facts: FactForStatements[] = [
  { id: 'f-size', key: 'size', valueText: '30 ml', valueNumber: null, merchantDecision: false },
  { id: 'f-price', key: 'price', valueText: null, valueNumber: 24, merchantDecision: true },
  { id: 'f-ing', key: 'key_ingredients', valueText: 'Niacinamide 5%, Hyaluronic Acid, Panthenol', valueNumber: null, merchantDecision: false },
];

describe('factual parts of a line', () => {
  it('finds sizes, percentages, prices and named ingredients', () => {
    expect(factualParts('Dew Serum · 30 ml').map((p) => p.text)).toEqual(['30 ml']);
    expect(factualParts('With 10% niacinamide for $24').map((p) => `${p.kind}:${p.text}`)).toEqual(['price:$24', 'quantity:10%', 'ingredient:niacinamide']);
    expect(factualParts('Two drops, morning and night.')).toEqual([]);
  });
});

describe('statement map', () => {
  it('traces facts to ProductFacts (with merchant decisions), approved claims, or marks descriptive lines', () => {
    const map = mapStatements(
      ['Dew Serum · 30 ml', 'Only $24', 'With 5% niacinamide', 'Visibly smoother skin', 'Tap to try it.', 'Tap to try it.'],
      [{ line: 'Visibly smoother skin', claimId: 'c-1', status: 'claim' }],
      facts,
    );
    expect(map.map((m) => [m.text, m.status])).toEqual([
      ['Dew Serum · 30 ml', 'sourced'],
      ['Only $24', 'sourced'],
      ['With 5% niacinamide', 'sourced'],
      ['Visibly smoother skin', 'claim'],
      ['Tap to try it.', 'descriptive'],
    ]);
    expect(map[0]!.sources).toEqual([{ factId: 'f-size', key: 'size', merchantDecision: false }]);
    expect(map[1]!.sources).toEqual([{ factId: 'f-price', key: 'price', merchantDecision: true }]);
    expect(map[3]!.sources).toEqual([{ claimId: 'c-1' }]);
    expect(statementCheck(map)).toMatchObject({ check: 'claims', pass: true, hard: false });
  });

  it('an unsourced size or ingredient concentration fails hard with the line to change', () => {
    const map = mapStatements(['Now in 50 ml', 'With 10% niacinamide', 'Packed with retinol'], [], facts);
    expect(map.map((m) => m.unsourced)).toEqual([['50 ml'], ['10%'], ['retinol']]);
    const c = statementCheck(map);
    expect(c).toMatchObject({ pass: false, hard: true });
    expect(c.detail).toMatch(/“Now in 50 ml”: 50 ml isn’t backed/);
    expect((c.data as { violations: { text: string }[] }).violations.map((v) => v.text)).toEqual(['Now in 50 ml', 'With 10% niacinamide', 'Packed with retinol']);
  });
});
