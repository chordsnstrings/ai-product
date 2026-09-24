import { describe, expect, it } from 'vitest';
import { brandTree, claimCounts } from './tenant-tree';

describe('Brands & SKUs tree (plan 05 §2.2)', () => {
  it('groups SKUs under their brand with per-brand totals, lists empty brands, and puts unbranded SKUs last', () => {
    const rows = [
      { id: 's1', brand_id: 'b2', brand: 'Zest', facts: 3, assets: 2, experiments: 1, claims: { VERIFIED: 2, BLOCKED: 1 } },
      { id: 's2', brand_id: null, brand: null, facts: 1, assets: 0, experiments: 0, claims: {} },
      { id: 's3', brand_id: 'b2', brand: 'Zest', facts: 4, assets: 5, experiments: 2, claims: { VERIFIED: 1 } },
      { id: 's4', brand_id: 'b1', brand: 'Aloe', facts: 0, assets: 1, experiments: 0, claims: null },
    ];
    const tree = brandTree(rows, [{ id: 'b3', name: 'Mint' }, { id: 'b1', name: 'Aloe' }]);
    expect(tree.map((b) => [b.name, b.skus.map((s) => s.id)])).toEqual([['Aloe', ['s4']], ['Mint', []], ['Zest', ['s1', 's3']], ['No brand', ['s2']]]);
    const zest = tree.find((b) => b.name === 'Zest')!;
    expect(zest).toMatchObject({ facts: 7, assets: 7, experiments: 3, claims: { VERIFIED: 3, BLOCKED: 1 } });
    expect(claimCounts(zest.claims)).toBe('blocked 1 · verified 3');
    expect(claimCounts({})).toBe('—');
  });
});
