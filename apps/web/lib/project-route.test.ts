import { describe, expect, it } from 'vitest';
import { projectRoute } from './project-route';

describe('projectRoute (plan 03 A1 active jobs → the page for the project’s state)', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  it('sends a storyboard still being drawn, or ready and unpaid, to the storyboard — never to production', () => {
    expect(projectRoute('CONCEPT_SELECTED', id)).toBe(`/storyboard/${id}`);
    expect(projectRoute('STORYBOARD_READY', id)).toBe(`/storyboard/${id}`);
  });
  it('maps the other states to their funnel pages', () => {
    expect(projectRoute('PRODUCT_UPLOADED', id)).toBe(`/start/${id}`);
    expect(projectRoute('CONCEPTS_READY', id)).toBe(`/concepts/${id}`);
    expect(projectRoute('RENDERING', id)).toBe(`/produce/${id}`);
    expect(projectRoute('PROVIDER_FAILED', id)).toBe(`/produce/${id}`);
    expect(projectRoute('COMPLETE', id)).toBe(`/deliver/${id}`);
    // Waiting for a photo during the analysis (nothing paid) vs a paused production.
    expect(projectRoute('NEEDS_USER_ACTION', id)).toBe(`/start/${id}`);
    expect(projectRoute('NEEDS_USER_ACTION', id, { entitlementUnit: 'taste' })).toBe(`/produce/${id}`);
  });
  it('opens an experiment’s project in Studio', () => {
    expect(projectRoute('CONCEPT_SELECTED', id, { experimentId: 'e1', slug: 'acme' })).toBe('/w/acme/studio/e1');
  });
});
