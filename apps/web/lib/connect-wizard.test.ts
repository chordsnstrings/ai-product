import { describe, expect, it } from 'vitest';
import { currentWizardStep, wizardStepAfter } from './connect-wizard';

describe('connection wizard steps (plan 03 A8)', () => {
  it('goes Shopify → Meta → TikTok → done', () => {
    expect(wizardStepAfter('shopify')).toBe('meta');
    expect(wizardStepAfter('meta')).toBe('tiktok');
    expect(wizardStepAfter('tiktok')).toBe('done');
    expect(wizardStepAfter('other')).toBe('done');
  });

  it('opens on the requested step, else the first one not connected', () => {
    expect(currentWizardStep(undefined, new Set())).toBe('shopify');
    expect(currentWizardStep(undefined, new Set(['shopify']))).toBe('meta');
    expect(currentWizardStep(undefined, new Set(['shopify', 'meta', 'tiktok']))).toBe('done');
    expect(currentWizardStep('tiktok', new Set())).toBe('tiktok');
    expect(currentWizardStep('evil', new Set(['shopify']))).toBe('meta');
  });
});
