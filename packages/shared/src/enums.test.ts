import { describe, expect, it } from 'vitest';
import { MeasurementContext, MeasurementContextCaveat, MeasurementContextLabel, measurementContextLabel, platformAssets } from './enums';

describe('variant platform assets (§20 Variant.platform_assets[])', () => {
  it('maps each export to the placements that use it, in platform order', () => {
    expect(platformAssets([{ aspect: '1x1', assetId: 'c' }, { aspect: '9x16', assetId: 'a' }, { aspect: '4x5', assetId: 'b' }])).toEqual([
      { platform: 'TIKTOK', aspect: '9x16', assetId: 'a' },
      { platform: 'INSTAGRAM_REELS', aspect: '9x16', assetId: 'a' },
      { platform: 'FACEBOOK_FEED', aspect: '4x5', assetId: 'b' },
      { platform: 'FACEBOOK_FEED', aspect: '1x1', assetId: 'c' },
    ]);
    expect(platformAssets([{ aspect: '4x5', assetId: 'b' }])).toEqual([{ platform: 'FACEBOOK_FEED', aspect: '4x5', assetId: 'b' }]);
  });
});

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
