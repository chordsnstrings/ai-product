import { describe, expect, it } from 'vitest';
import { mockConcepts } from './mock-intel';
import { gateProposal, normalizePlan, prohibitedIn, prohibitedTerms } from './creative-director';
import { mockStoryboard } from './mock-intel';
import { adjacentSignal, composePortfolio, coverageGap, gateAndScore, hardGates, learningMatch, recommendationConfidence, scoreProposal, slotFor, WEIGHTS, type LearningSignal, type Scored, type ScoringContext } from './recommendations';

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

describe('adjacent signal from related genes after shrinkage (§20, §21)', () => {
  const [p] = mockConcepts(pc).concepts; // texture-first, hooks: “Watch this lightweight serum disappear”, …
  const hookWin = (over: Partial<LearningSignal> = {}): LearningSignal => ({ angle: 'TEXTURE_SENSORY', state: 'ACTIONABLE', positive: true, variable: 'hook', winner: p!.hookOptions[1]!, losers: ['A different opening'], effect: 0.3, confidence: 0.97, ...over });

  it('a hook learning bears only on proposals that reuse that hook, never on the angle every compared ad shared', () => {
    expect(learningMatch(hookWin(), p!)).toBe(1);
    expect(learningMatch(hookWin({ winner: 'Some other hook' }), p!)).toBe(0); // same angle, but the learning isn't about it
    expect(learningMatch(hookWin({ winner: 'Some other hook', losers: [p!.hookOptions[0]!] }), p!)).toBe(-1); // reuses a losing hook
    expect(learningMatch({ angle: 'TEXTURE_SENSORY', state: 'ACTIONABLE', positive: false, variable: 'angle', winner: 'ROUTINE', losers: ['TEXTURE_SENSORY'] }, p!)).toBe(-1);
    expect(learningMatch({ angle: 'X', state: 'ACTIONABLE', positive: true, variable: 'format', winner: 'HYBRID', losers: [] }, p!)).toBe(0.4);
  });

  it('never uses an invalidated learning as a prior, down-weights weakening ones and scales with the shrunk effect', () => {
    const neutral = adjacentSignal([], p!);
    expect(neutral).toBeCloseTo(0.4);
    expect(adjacentSignal([hookWin({ state: 'INVALIDATED' })], p!)).toBeCloseTo(neutral);
    const strong = adjacentSignal([hookWin()], p!);
    const weakening = adjacentSignal([hookWin({ state: 'WEAKENING' })], p!);
    const tiny = adjacentSignal([hookWin({ effect: 0.02 })], p!);
    expect(strong).toBeGreaterThan(weakening);
    expect(weakening).toBeGreaterThan(neutral);
    expect(tiny - neutral).toBeLessThan((strong - neutral) / 5); // a lucky tiny lift barely moves the score
    expect(adjacentSignal([hookWin({ winner: 'x', losers: [p!.hookOptions[0]!] })], p!)).toBeLessThan(neutral);
  });

  it('EXPLOIT only on an ACTIONABLE learning that points to the proposal; DIRECTIONAL influences exploration only', () => {
    expect(slotFor(p!, ctx({ learnings: [hookWin()] }))).toBe('EXPLOIT');
    expect(slotFor(p!, ctx({ learnings: [hookWin({ state: 'DIRECTIONAL' })] }))).not.toBe('EXPLOIT');
    expect(slotFor(p!, ctx({ learnings: [hookWin({ winner: 'A different hook' })] }))).not.toBe('EXPLOIT');
  });
});

describe('coverage gap counts meaningful coverage (§20, Appendix C)', () => {
  it('an untested angle beats a read one; a read cell on the angle lowers it further', () => {
    const [p] = mockConcepts(pc).concepts;
    const untested = coverageGap(p!, { angleTests: new Map([['ROUTINE', 2]]) });
    const tested = coverageGap(p!, { angleTests: new Map([['ROUTINE', 2], [p!.angle, 1]]) });
    const cell = coverageGap(p!, { angleTests: new Map([['ROUTINE', 2], [p!.angle, 1]]), testedCells: new Set([`${p!.angle}|${p!.hookMechanism}`]) });
    expect(untested).toBe(1);
    expect(tested).toBeLessThan(untested);
    expect(cell).toBeLessThan(tested);
  });
});

describe('portfolio rule by deficit (§20)', () => {
  const [p] = mockConcepts(pc).concepts;
  const cand = (slot: Scored['slot'], i: number, score = 0.5): Scored => ({
    proposal: { ...p!, angle: (['TEXTURE_SENSORY', 'ROUTINE', 'OBJECTION_HANDLING', 'SOCIAL_PROOF', 'PROBLEM_SOLUTION', 'MYTH_BUSTING'] as const)[i]!, hookMechanism: slot === 'EXPLOIT' ? 'DEMONSTRATION' : slot === 'EXPAND' ? 'QUESTION' : 'LIST' },
    slot,
    score: score - i * 0.01,
    breakdown: {} as Scored['breakdown'],
    gates: { passed: true, reasons: [] },
    rationaleIds: [],
    confidence: 0.5,
  });
  const pool = [cand('EXPLOIT', 0, 0.9), cand('EXPLOIT', 1, 0.9), cand('EXPAND', 2), cand('EXPAND', 3), cand('EXPLORE', 4, 0.3), cand('EXPLORE', 5, 0.3)];
  const mix = (picked: Scored[]) => ({ EXPLOIT: picked.filter((x) => x.slot === 'EXPLOIT').length, EXPAND: picked.filter((x) => x.slot === 'EXPAND').length, EXPLORE: picked.filter((x) => x.slot === 'EXPLORE').length });

  it('a Mature SKU keeps an Explore pick even though its explore candidates score lowest', () => {
    expect(mix(composePortfolio(pool, 'MATURE', 3))).toEqual({ EXPLOIT: 1, EXPAND: 1, EXPLORE: 1 });
  });

  it('steers toward the target shares from what recent weeks already realized', () => {
    // Eight weeks of mostly EXPLOIT on a Mature SKU: this week goes to the under-served slots.
    expect(mix(composePortfolio(pool, 'MATURE', 3, { EXPLOIT: 6, EXPAND: 1, EXPLORE: 0 }))).toEqual({ EXPLOIT: 0, EXPAND: 2, EXPLORE: 1 });
    // A Developing SKU that explored a lot gets its exploit share back.
    expect(mix(composePortfolio(pool, 'DEVELOPING', 3, { EXPLOIT: 0, EXPAND: 2, EXPLORE: 4 }))).toEqual({ EXPLOIT: 2, EXPAND: 1, EXPLORE: 0 });
    // Cold: explore/expand-heavy; with no exploit candidate every pick is expand or explore.
    const cold = composePortfolio(pool.filter((x) => x.slot !== 'EXPLOIT'), 'COLD', 3);
    expect(cold.length).toBe(3);
    expect(mix(cold).EXPLORE).toBeGreaterThanOrEqual(1);
  });
});

describe('hard gates before scoring (§20 “the score cannot override a gate”)', () => {
  const [p] = mockConcepts(pc).concepts;

  it('a candidate whose strategy rests on a blocked claim, or whose hook had to be removed, is refused — never padded', () => {
    const blockedStrategy = gateAndScore({ ...p!, bodyStrategy: 'Show how it cures acne overnight → CTA.' }, ctx(), { approvedClaims: [] });
    expect(blockedStrategy.gates.passed).toBe(false);
    expect(blockedStrategy.score).toBe(0);
    expect(blockedStrategy.gates.reasons).toContain('strategy relies on a blocked claim');

    const blockedHook = gateAndScore({ ...p!, hookOptions: ['Heals eczema in a week', p!.hookOptions[1]!, p!.hookOptions[2]!] }, ctx(), { approvedClaims: [] });
    expect(blockedHook.gates.passed).toBe(false);
    expect(blockedHook.score).toBe(0);
    expect(blockedHook.proposal.hookOptions[0]).toBe('Heals eczema in a week'); // scored as proposed, not repaired
    expect(blockedHook.gates.reasons.some((r) => r.startsWith('hook removed'))).toBe(true);
    expect(composePortfolio([blockedStrategy, blockedHook, scoreProposal(p!, ctx())], 'COLD', 3).map((x) => x.proposal)).toEqual([p]);

    // Concepts still get neutral filler hooks by default; recommendations (`pad: false`) do not.
    const cleaned = gateProposal({ ...p!, hookOptions: ['Heals eczema in a week', 'a', 'b'] }, []);
    expect(cleaned.cleaned.hookOptions).toHaveLength(3);
    expect(gateProposal({ ...p!, hookOptions: ['Heals eczema in a week', 'a', 'b'] }, [], [], { pad: false }).cleaned.hookOptions).toHaveLength(2);
  });

  it('a clean candidate scores normally', () => {
    const ok = gateAndScore(p!, ctx(), { approvedClaims: [] });
    expect(ok.gates.passed).toBe(true);
    expect(ok.score).toBeGreaterThan(0);
  });
});

describe('Brand Brain never-show-or-say (§16)', () => {
  it('parses the list and blocks hooks, strategy and storyboard lines that use it', () => {
    const terms = prohibitedTerms('No before/after, never "miracle"; avoid clinical white coats\nlab');
    expect(terms).toEqual(['before/after', '"miracle"', 'clinical white coats', 'lab']);
    expect(prohibitedIn('Our lab tested it', ['lab'])).toBe('lab');
    expect(prohibitedIn('A label close-up', ['lab'])).toBeNull(); // whole words
    const [p] = mockConcepts(pc).concepts;
    const g = gateProposal({ ...p!, hookOptions: ['Straight from the lab', p!.hookOptions[1]!, p!.hookOptions[2]!] }, [], [], { prohibited: ['lab'] });
    expect(g.cleaned.hookOptions).not.toContain('Straight from the lab');
    expect(g.reasons.some((r) => r.includes('never shows or says'))).toBe(true);
    expect(gateProposal({ ...p!, bodyStrategy: 'Open in a lab → product hero → CTA.' }, [], [], { prohibited: ['lab'] }).ok).toBe(false);
    const plan = mockStoryboard({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }, p!);
    expect(() => normalizePlan(plan, [], ['Glow Serum'])).not.toThrow();
    const word = plan.scenes[0]!.visualPlan.split(/\s+/).find((w) => /^[a-z]{4,}$/i.test(w))!.toLowerCase();
    expect(() => normalizePlan(plan, [], ['Glow Serum'], [word])).toThrow(/brand check/);
  });
});
