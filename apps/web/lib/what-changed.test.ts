import { describe, expect, it } from 'vitest';
import { describeChange, WHAT_CHANGED_TYPES, type ChangeSubjects } from './what-changed';

const subjects: ChangeSubjects = {
  experiments: new Map([
    ['e1', { hypothesis: 'A texture close-up hook beats a problem hook', sku: 'Dew Serum', state: 'DIRECTIONAL' }],
    ['e2', { hypothesis: 'Creator demo vs studio', sku: 'Dew Serum', state: 'PRODUCING' }],
  ]),
  learnings: new Map([['l1', { statement: 'Texture hooks hold attention for this serum', sku: 'Dew Serum' }]]),
  integrations: new Map([['i1', { provider: 'meta', name: 'Brand Ads' }]]),
};

describe('This Week “What changed” (plan 03 A1)', () => {
  it('lists only performance and connection state changes', () => {
    expect(WHAT_CHANGED_TYPES).not.toContain('COMPOSITION_COMPLETED');
    expect(WHAT_CHANGED_TYPES.some((t) => t.startsWith('CLAIM_'))).toBe(false);
  });

  it('names the test and links to its results, or to Studio while it is being made', () => {
    expect(describeChange({ type: 'CONFIDENCE_CHANGED', subjectId: 'e1', refs: null, payload: { to: 'DIRECTIONAL' } }, subjects, 'acme')).toEqual({
      text: 'Confidence changed: “A texture close-up hook beats a problem hook” · Dew Serum',
      href: '/w/acme/results/e1',
      state: 'DIRECTIONAL',
    });
    expect(describeChange({ type: 'EXPERIMENT_CONFOUNDED', subjectId: 'e2', refs: null, payload: null }, subjects, 'acme')!.href).toBe('/w/acme/studio/e2');
  });

  it('names the learning and links to the test it came from', () => {
    const r = describeChange({ type: 'LEARNING_WEAKENED', subjectId: 'l1', refs: { experimentId: 'e1' }, payload: null }, subjects, 'acme');
    expect(r).toMatchObject({ text: 'Learning weakened: “Texture hooks hold attention for this serum” · Dew Serum', href: '/w/acme/results/e1' });
    expect(describeChange({ type: 'LEARNING_CREATED', subjectId: 'l1', refs: {}, payload: null }, subjects, 'acme')!.href).toBe('/w/acme/map');
  });

  it('names the connection; drops changes whose subject is gone or not significant', () => {
    expect(describeChange({ type: 'INTEGRATION_DEGRADED', subjectId: 'i1', refs: null, payload: null }, subjects, 'acme')!.text).toBe('Meta (Brand Ads) needs attention — results may be incomplete');
    expect(describeChange({ type: 'CONFIDENCE_CHANGED', subjectId: 'gone', refs: null, payload: null }, subjects, 'acme')).toBeNull();
    expect(describeChange({ type: 'COMPOSITION_COMPLETED', subjectId: 'e1', refs: null, payload: null }, subjects, 'acme')).toBeNull();
  });
});
