import { describe, expect, it } from 'vitest';
import { classifyClaim, excludedProductReason, nonSkincareCategory, scanCreativeText, scanPasses, type LineMapping } from './compliance';
import { qaClaims } from './qa';

/** Claims regression set (standard §51: allowed, ambiguous and blocked claims, express and implied). */
describe('claims regression', () => {
  const cases: [string, string][] = [
    ['Cures acne in 7 days', 'BLOCKED'],
    ['This serum treats rosacea', 'BLOCKED'],
    ['Boosts collagen production', 'BLOCKED'],
    ['Stimulates cell regeneration overnight', 'BLOCKED'],
    ['Broad spectrum SPF 30 protection', 'BLOCKED'],
    ['Permanently erases wrinkles', 'BLOCKED'],
    ['Removes dark spots', 'BLOCKED'],
    ['Anti-inflammatory formula', 'BLOCKED'],
    ['Clinically proven to hydrate', 'RESTRICTED'],
    ['Great for acne-prone skin', 'RESTRICTED'],
    ['Safe during pregnancy', 'RESTRICTED'],
    ['Dermatologist tested', 'MERCHANT_REVIEW_REQUIRED'],
    ['92% of users saw brighter skin', 'MERCHANT_REVIEW_REQUIRED'],
    ['Non-comedogenic', 'MERCHANT_REVIEW_REQUIRED'],
    ['Better than retinol', 'MERCHANT_REVIEW_REQUIRED'],
    ['Reduces the appearance of fine lines', 'VERIFIED_WITH_QUALIFIER'],
    ['Leaves skin feeling soft', 'MERCHANT_REVIEW_REQUIRED'],
  ];
  it.each(cases)('%s → %s', (text, status) => {
    expect(classifyClaim(text).status).toBe(status);
  });

  it('never auto-verifies anything', () => {
    for (const [t] of cases) expect(classifyClaim(t).status).not.toBe('VERIFIED');
  });
});

describe('scanCreativeText', () => {
  const vault = [
    { id: 'c1', wording: 'Absorbs in seconds', qualifier: null },
    { id: 'c2', wording: 'Reduces the appearance of fine lines', qualifier: 'with daily use' },
  ];
  it('passes neutral and approved lines', () => {
    const r = scanCreativeText(['Absorbs in seconds.', 'Apply two drops morning and night.', 'Shop now.'], vault);
    expect(r.ok).toBe(true);
  });
  it('fails a blocked claim even if approved wording is nearby', () => {
    const r = scanCreativeText(['Absorbs in seconds and cures acne.'], vault);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.status).toBe('BLOCKED');
  });
  it('requires the exact qualifier for VERIFIED_WITH_QUALIFIER claims', () => {
    expect(scanCreativeText(['Reduces the appearance of fine lines.'], vault).ok).toBe(false);
    expect(scanCreativeText(['Reduces the appearance of fine lines with daily use.'], vault).ok).toBe(true);
  });
  it('fails unapproved review-level claims', () => {
    expect(scanCreativeText(['Dermatologist recommended.'], vault).ok).toBe(false);
  });
  it('flags unmapped product statements for review', () => {
    expect(scanCreativeText(['This serum makes your skin glow.'], vault).unmapped).toHaveLength(1);
  });
});

/** §25 check 3: every material product statement maps to an allowed Claim ID (prod-18). */
describe('claims QA maps each line to a Claim ID', () => {
  const vault = [
    { id: 'c1', wording: 'Absorbs in seconds', qualifier: null },
    { id: 'c2', wording: 'It hydrates all day', qualifier: null },
  ];
  it('fails an effect statement no approved claim covers', () => {
    const r = qaClaims(['It hydrates all day.'], []);
    expect(r).toMatchObject({ pass: false, hard: true });
    expect(r.detail).toMatch(/isn’t approved/);
    expect((r.data as { unmapped: string[] }).unmapped).toEqual(['It hydrates all day.']);
  });
  it('passes the same line once it is approved, recording its Claim ID', () => {
    const r = qaClaims(['It hydrates all day.', 'Apply two drops morning and night.', 'Absorbs in seconds'], vault);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/2 claims used, all approved/);
    expect((r.data as { mapping: LineMapping[] }).mapping).toEqual([
      { line: 'It hydrates all day.', claimId: 'c2', status: 'claim' },
      { line: 'Apply two drops morning and night.', claimId: null, status: 'neutral' },
      { line: 'Absorbs in seconds', claimId: 'c1', status: 'claim' },
    ]);
  });
  it('treats product and brand names as names, not claims', () => {
    expect(scanPasses(scanCreativeText(['Radiant Glow'], []))).toBe(false);
    expect(scanPasses(scanCreativeText(['Radiant Glow'], [], { names: ['Radiant Glow'] }))).toBe(true);
    // A name does not launder a claim made around it.
    expect(scanPasses(scanCreativeText(['Radiant Glow makes your skin glow'], [], { names: ['Radiant Glow'] }))).toBe(false);
  });
  it('marks violations in the mapping', () => {
    const r = scanCreativeText(['Cures acne in 3 days'], vault);
    expect(r.mapping).toEqual([{ line: 'Cures acne in 3 days', claimId: null, status: 'violation' }]);
  });
});

describe('scope detection', () => {
  it('excludes SPF and OTC acne products', () => {
    expect(excludedProductReason('Daily Defense SPF 50 moisturizer')).toMatch(/SPF/);
    expect(excludedProductReason('Spot gel with benzoyl peroxide')).toMatch(/OTC/);
    expect(excludedProductReason('Hydrating serum with hyaluronic acid')).toBeNull();
  });
  it('detects non-skincare products', () => {
    expect(nonSkincareCategory('Lavender soy candle 8oz')).toBe('home fragrance');
    expect(nonSkincareCategory('Niacinamide 10% serum')).toBeNull();
  });
});

describe('golden datasets (regression, plan 05 §11)', () => {
  it.each(['compliance.classify', 'compliance.scan'])('%s passes with no missed blocks', async (dataset) => {
    const { runDeterministicEval } = await import('./evals');
    const r = runDeterministicEval(dataset);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
    expect(r.passed).toBe(true);
  });
});
