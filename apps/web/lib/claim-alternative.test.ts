import { describe, expect, it } from 'vitest';
import { classifyClaim } from '@arkiv/core';
import { blockedAlternative, fieldForAlternative, suggestedWording } from './claim-alternative';

describe('compliant alternatives in the UI (§43)', () => {
  it('pulls the quoted example wording out of the rules’ advice', () => {
    expect(suggestedWording('Say "reduces the look of fine lines".')).toBe('reduces the look of fine lines');
    expect(suggestedWording('Describe how skin looks or feels, e.g. “skin looks clearer”.')).toBe('skin looks clearer');
    expect(suggestedWording('Focus on cosmetic effect and feel.')).toBeNull();
    expect(suggestedWording(null)).toBeNull();
  });

  it('an example wording taken from a rule’s advice is not itself blocked', () => {
    for (const w of ['Removes wrinkles', 'Cures acne', 'Boosts collagen', 'Permanent results']) {
      const wording = suggestedWording(classifyClaim(w).matched.find((m) => m.alternative)?.alternative);
      if (wording) expect(classifyClaim(wording).status).not.toBe('BLOCKED');
    }
  });

  it('reads the alternative from an API error, and nothing from other errors', () => {
    const e = Object.assign(new Error('blocked'), { details: { alternative: 'Say "reduces the look of fine lines".', text: 'erases wrinkles' } });
    expect(blockedAlternative(e)).toEqual({ advice: 'Say "reduces the look of fine lines".', wording: 'reduces the look of fine lines', text: 'erases wrinkles' });
    expect(blockedAlternative(new Error('x'))).toBeNull();
    expect(blockedAlternative(Object.assign(new Error('x'), { details: { restricted: true } }))).toBeNull();
  });

  it('replaces the field the blocked text came from', () => {
    expect(fieldForAlternative({ spokenLine: 'It feels great', overlayText: 'Erases wrinkles' }, { text: 'erases wrinkles' })).toBe('overlayText');
    expect(fieldForAlternative({ spokenLine: 'Erases wrinkles fast', overlayText: 'Erases wrinkles' }, { text: 'erases wrinkles' })).toBe('spokenLine');
    expect(fieldForAlternative({ spokenLine: '', overlayText: '' }, { text: null })).toBe('spokenLine');
  });
});
