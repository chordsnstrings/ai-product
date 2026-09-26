import { describe, expect, it } from 'vitest';
import { rightsStatus, yesNo } from './product-view';

const base = { kind: 'historical_creative', source: 'upload', rightsAttestedAt: null, rightsExpiresAt: null, rightsFrozenAt: null };
const now = new Date('2026-09-26T12:00:00Z');

describe('asset rights status (plan 03 A4, standard §40)', () => {
  it('names every state of uploaded footage', () => {
    expect(rightsStatus(base, now)).toEqual({ state: 'missing', label: 'Rights not attested' });
    expect(rightsStatus({ ...base, rightsAttestedAt: '2026-09-01T00:00:00Z' }, now)).toEqual({ state: 'attested', label: 'Rights attested' });
    expect(rightsStatus({ ...base, rightsAttestedAt: '2026-09-01T00:00:00Z', rightsExpiresAt: '2027-01-31' }, now).label).toBe('Rights attested · expires 31 Jan 2027');
    expect(rightsStatus({ ...base, rightsAttestedAt: '2026-09-01T00:00:00Z', rightsExpiresAt: '2026-09-20' }, now).state).toBe('expired');
    expect(rightsStatus({ ...base, rightsAttestedAt: '2026-09-01T00:00:00Z', rightsFrozenAt: '2026-09-25T00:00:00Z' }, now).state).toBe('frozen');
  });

  it('product photos and generated work carry no rights chip', () => {
    expect(rightsStatus({ ...base, kind: 'product_photo' }, now)).toEqual({ state: 'not_applicable', label: null });
    expect(rightsStatus({ ...base, kind: 'final_export', source: 'composed' }, now).label).toBeNull();
  });
});

describe('yes/no offer facts', () => {
  it('reads booleans stored as JSON or as words', () => {
    expect(yesNo({ valueText: null, valueNumber: null, valueJson: true })).toBe(true);
    expect(yesNo({ valueText: 'No', valueNumber: null, valueJson: null })).toBe(false);
    expect(yesNo({ valueText: 'maybe', valueNumber: null, valueJson: null })).toBeNull();
    expect(yesNo(undefined)).toBeNull();
  });
});
