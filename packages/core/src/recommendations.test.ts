import { describe, expect, it } from 'vitest';
import { mockConcepts } from './mock-intel';
import { gateProposal } from './creative-director';
import { composePortfolio, hardGates, recommendationConfidence, scoreProposal, WEIGHTS, type ScoringContext } from './recommendations';

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

describe('rationale ids and confidence (§38)', () => {
  const T = '00000000-0000-4000-8000-00000000000a';
  const L = '00000000-0000-4000-8000-00000000000b';
  const F = '00000000-0000-4000-8000-00000000000c';

  it('keeps only rationale ids from the context packet', () => {
    const [p] = mockConcepts(pc).concepts;
    const g = gateProposal({ ...p!, rationaleIds: [F, 'made-up-id', F] }, [], [], { packetIds: new Set([F, T]) });
    expect(g.cleaned.rationaleIds).toEqual([F]);
    expect(g.reasons.some((r) => r.startsWith('unknown rationale id dropped'))).toBe(true);
  });

  it('records the theme and learnings the score used, and derives confidence from the evidence', () => {
    const [p] = mockConcepts(pc).concepts; // texture-first: tension mentions a sticky finish
    const s = ctx({
      themes: [{ id: T, label: 'sticky feel', prevalence: 0.5 }],
      learnings: [{ id: L, angle: p!.angle, state: 'ACTIONABLE', positive: true }],
      basis: 'performance',
    });
    const withFact = scoreProposal({ ...p!, customerTension: 'Shoppers worry it feels sticky', rationaleIds: [F] }, s);
    expect(withFact.rationaleIds).toEqual([F, T, L]);
    expect(withFact.confidence).toBe(0.85); // 0.55 performance + 0.2 actionable + 0.1 matched theme
    const cold = scoreProposal({ ...p!, customerTension: 'Nothing matches', hypothesis: 'Unrelated words entirely' }, ctx({ basis: 'cold_start', themes: [] }));
    expect(cold.rationaleIds).toEqual([]);
    expect(cold.confidence).toBe(0.3);
    expect(recommendationConfidence('context_limited', [{ angle: 'X', state: 'INVALIDATED', positive: true }], false)).toBe(0.2);
    expect(recommendationConfidence('performance', [{ angle: 'X', state: 'ACTIONABLE', positive: true }, { angle: 'X', state: 'ACTIONABLE', positive: true }, { angle: 'X', state: 'ACTIONABLE', positive: true }], true)).toBe(0.95);
  });
});
