import { describe, expect, it } from 'vitest';
import { assignVariantOrNull } from '@arkiv/shared/variants';
import { BASE_VARIANT, routeLanding, type LandingRoute } from './landing-routing';

/** Plan 04 L6 (static landing pages) and plan 05 §5 (utm_content routing, sticky variants, previews). */
const table: LandingRoute[] = [
  { slug: 'default', utmMatch: [], variants: [] },
  { slug: 'texture', utmMatch: ['texture'], variants: [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }] },
  { slug: 'fatigue', utmMatch: ['fatigue', 'refresh'], variants: [] },
];
const q = (s = '') => new URLSearchParams(s);

describe('landing routing (static campaign pages)', () => {
  it('serves the default page at /, and routes utm_content prefixes to their campaign page', () => {
    expect(routeLanding('/', q(), table, 'v1')).toEqual({ kind: 'rewrite', slug: 'default', variant: null, path: `/lp/default/${BASE_VARIANT}` });
    expect(routeLanding('/', q('utm_content=Refresh-hooks-02'), table, 'v1')).toMatchObject({ kind: 'rewrite', slug: 'fatigue' });
    expect(routeLanding('/', q('utm_content=other'), table, 'v1')).toMatchObject({ slug: 'default' });
  });

  it('gives each visitor the same variant the dynamic page would (sticky, same hash)', () => {
    for (const vid of ['v1', 'v2', 'v3', 'v4', 'v5']) {
      const d = routeLanding('/for/texture', q('utm_source=tiktok'), table, vid);
      const want = assignVariantOrNull('lp:texture', vid, table[1]!.variants);
      expect(d).toEqual({ kind: 'rewrite', slug: 'texture', variant: want, path: `/lp/texture/${want}` });
      expect(routeLanding('/for/texture', q(), table, vid)).toEqual(d);
    }
  });

  it('leaves previews, pages that are not live and an unknown table to the dynamic routes', () => {
    expect(routeLanding('/for/texture', q('preview=tok'), table, 'v1')).toEqual({ kind: 'pass' });
    expect(routeLanding('/for/paused', q(), table, 'v1')).toEqual({ kind: 'pass' });
    expect(routeLanding('/', q(), null, 'v1')).toEqual({ kind: 'pass' });
    expect(routeLanding('/pricing', q(), table, 'v1')).toEqual({ kind: 'pass' });
  });
});
