import { describe, expect, it } from 'vitest';
import { MeasurementContext, MeasurementContextCaveat, MeasurementContextLabel, measurementContextLabel } from './enums';

describe('measurement context labels (§30, §45)', () => {
  it('cover every stored context value', () => {
    for (const c of MeasurementContext) expect(MeasurementContextLabel[c], c).toBeTruthy();
    expect(Object.keys(MeasurementContextLabel).sort()).toEqual([...MeasurementContext].sort());
  });

  it('carry the GMV Max organic/affiliate disclosure', () => {
    expect(measurementContextLabel('TIKTOK_GMV_MAX_TOTAL')).toMatch(/includes organic \+ affiliate/);
    expect(MeasurementContextCaveat.TIKTOK_GMV_MAX_TOTAL).toMatch(/not comparable to paid-only ROAS/);
  });

  it('never prints a raw enum for unknown legacy values', () => {
    expect(measurementContextLabel('SOME_FUTURE_CONTEXT')).toBe('some future context');
  });
});
