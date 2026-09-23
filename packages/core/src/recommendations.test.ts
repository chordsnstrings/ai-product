import { describe, expect, it } from 'vitest';
import { mockConcepts } from './mock-intel';
import { composePortfolio, hardGates, scoreProposal, WEIGHTS, type ScoringContext } from './recommendations';

const ctx = (over: Partial<ScoringContext> = {}): ScoringContext => ({
  themes: [{ label: 'sticky or greasy feel', prevalence: 0.4 }],
  angleTests: new Map(),
  learnings: [],
  fatiguingAngles: new Set(),
  recentKeys: new Set(),
  fidelityConfidence: 0.8,
  approvedClaims: [],
  hasRealAssets: false,
  ...over,
});

const pc = { name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [], ingredients: ['niacinamide'] };

describe('Opportunity Score (§20)', () => {
  it('weights sum to 100%', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('hard gates zero the score regardless of drivers', () => {
    const [p] = mockConcepts(pc).concepts;
    const bad = { ...p!, hookOptions: ['Cures acne fast', 'x x x', 'y y y'] };
    const s = scoreProposal(bad, ctx());
    expect(s.gates.passed).toBe(false);
    expect(s.score).toBe(0);
  });

  it('rejects near-duplicates of recent tests and unapproved claims', () => {
    const [p] = mockConcepts(pc).concepts;
    expect(hardGates(p!, ctx({ recentKeys: new Set([`${p!.angle}|${p!.hookMechanism}`]) })).passed).toBe(false);
    expect(hardGates({ ...p!, claimWordings: ['Clinically proven hydration'] }, ctx()).passed).toBe(false);
  });

  it('rewards under-tested territory over repeatedly tested angles', () => {
    const [p] = mockConcepts(pc).concepts;
    const fresh = scoreProposal(p!, ctx()).score;
    const tired = scoreProposal(p!, ctx({ angleTests: new Map([[p!.angle, 6], ['ROUTINE', 1]]) })).score;
    expect(fresh).toBeGreaterThan(tired);
  });

  it('cold-start portfolio has no EXPLOIT picks (never pretends performance learning exists)', () => {
    const cands = [...mockConcepts(pc, 1).concepts, ...mockConcepts(pc, 2).concepts];
    const picked = composePortfolio(cands.map((c) => scoreProposal(c, ctx())), 'COLD', 3);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((p) => p.slot !== 'EXPLOIT')).toBe(true);
  });

  it('mature SKUs with positive learnings get exploit slots', () => {
    const cands = [...mockConcepts(pc, 1).concepts, ...mockConcepts(pc, 2).concepts];
    const s = ctx({ learnings: [{ angle: 'TEXTURE_SENSORY', state: 'ACTIONABLE', positive: true }], angleTests: new Map([['TEXTURE_SENSORY', 2]]) });
    const picked = composePortfolio(cands.map((c) => scoreProposal(c, s)), 'MATURE', 3);
    expect(picked.some((p) => p.slot === 'EXPLOIT')).toBe(true);
  });
});
