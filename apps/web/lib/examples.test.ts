import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { BUILT_IN_EXAMPLES, EXAMPLE_INPUT, EXAMPLE_LOOP, exampleFor } from './examples';

afterAll(closeAll);

const PUBLIC = path.resolve(__dirname, '../public');

describe('built-in landing examples (plan 03 P1 §7, plan 04 L1, standard §8)', () => {
  it('ship as small static files: the input photo, one 9:16 frame per archetype and the desktop loop', () => {
    for (const src of [EXAMPLE_INPUT, EXAMPLE_LOOP, ...BUILT_IN_EXAMPLES.map((e) => e.src)]) {
      const f = path.join(PUBLIC, src);
      expect(existsSync(f), src).toBe(true);
      expect(statSync(f).size, src).toBeLessThan(200_000);
    }
    expect(BUILT_IN_EXAMPLES.length).toBeGreaterThanOrEqual(3);
    expect(BUILT_IN_EXAMPLES.length).toBeLessThanOrEqual(6);
  });

  it('there is a live page per ad archetype, and each page’s hero shows the example of its own archetype', async () => {
    const pages = await ownerPool()`select slug, archetype, utm_match from landing_pages where status = 'live' order by slug`;
    const bySlug = Object.fromEntries(pages.map((p) => [p.slug as string, p]));
    for (const slug of ['default', 'texture', 'fatigue', 'serum-launch', 'ugc', 'founder']) expect(bySlug[slug], slug).toBeTruthy();
    expect(bySlug['serum-launch']!.utm_match).toEqual(['serum', 'launch']);
    for (const p of pages) {
      if (p.archetype === 'general') continue;
      expect(exampleFor(p.archetype as string).archetype, p.slug as string).toBe(p.archetype);
    }
    expect(exampleFor('general').key).toBe('texture');
  });
});
