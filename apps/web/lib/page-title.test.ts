import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { itemTitle } from './page-title';

const APP = path.resolve(__dirname, '../app');
function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? pages(p) : /^(page|layout)\.tsx$/.test(f) ? [p] : [];
  });
}

describe('page titles (WCAG 2.4.2 Page Titled; plan 06 Phase 6 #1)', () => {
  const files = pages(APP);
  it('never repeat the brand the root layout already adds (“· Arkiv · Arkiv”)', () => {
    const layout = readFileSync(path.join(APP, 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/template: '%s · Arkiv'/);
    const offenders = files.filter((f) => f !== path.join(APP, 'layout.tsx') && /title:\s*['`"][^'`"]*·\s*Arkiv['`"]/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(APP, f))).toEqual([]);
  });

  it('name the item on pages about one product, experiment, project or legal document', () => {
    const dynamic = [
      '(marketing)/legal/[doc]/page.tsx',
      'w/[slug]/products/[skuId]/page.tsx',
      'w/[slug]/products/[skuId]/claims/page.tsx',
      'w/[slug]/products/[skuId]/review/page.tsx',
      'w/[slug]/studio/[experimentId]/page.tsx',
      'w/[slug]/results/[experimentId]/page.tsx',
      '(flow)/start/[projectId]/page.tsx',
      '(flow)/concepts/[projectId]/page.tsx',
      '(flow)/storyboard/[projectId]/page.tsx',
      '(flow)/produce/[projectId]/page.tsx',
      '(flow)/checkout/[projectId]/page.tsx',
      '(flow)/deliver/[projectId]/page.tsx',
    ];
    for (const f of dynamic) expect(readFileSync(path.join(APP, f), 'utf8'), f).toMatch(/export async function generateMetadata/);
  });

  it('put the item first and keep a generic title when it can’t be read', () => {
    expect(itemTitle('Serum No. 3', 'Storyboard')).toBe('Serum No. 3 · Storyboard');
    expect(itemTitle(null, 'Storyboard')).toBe('Storyboard');
  });
});
