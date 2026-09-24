import { describe, expect, it } from 'vitest';
import { fontBudgetViolations } from '../../scripts/font-budget';

describe('font preload budget (design §5)', () => {
  it('accepts routes preloading two files', () => {
    expect(fontBudgetViolations({ app: { '[project]/apps/web/app/layout': ['static/media/sans.p.woff2', 'static/media/serif.p.woff2'] } })).toEqual([]);
  });

  it('flags a route preloading more than two files', () => {
    const files = ['static/media/a.p.woff2', 'static/media/b.p.woff2', 'static/media/c.p.woff2'];
    expect(fontBudgetViolations({ app: { '[project]/apps/web/app/page': files }, pages: {} })).toEqual([{ route: '[project]/apps/web/app/page', files }]);
  });

  it('counts each file once and ignores non-font entries', () => {
    expect(fontBudgetViolations({ pages: { '/_app': ['static/media/a.p.woff2', 'static/media/a.p.woff2', 'static/media/b.p.woff2', 'static/css/x.css'] } })).toEqual([]);
  });
});
