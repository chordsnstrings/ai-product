import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { firstLoadKb, gzipKb, overBudget, routeChunks } from '../../scripts/bundle-budget-lib';

/** A minimal `.next` as Next 16 writes it: root main files and a route's client-reference manifest. */
const dir = mkdtempSync(path.join(tmpdir(), 'bundle-budget-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (rel: string, body: string) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body);
};
write('build-manifest.json', JSON.stringify({ rootMainFiles: ['static/chunks/runtime.js', 'static/chunks/react.js'] }));
write('static/chunks/runtime.js', 'x'.repeat(5000));
write('static/chunks/react.js', 'abcdefghij'.repeat(4000));
write('static/chunks/layout.js', 'l'.repeat(2000));
write('static/chunks/page.js', Array.from({ length: 3000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join(''));
const entry = '(marketing)/pricing/page';
write(
  `server/app/${entry}_client-reference-manifest.js`,
  `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};
globalThis.__RSC_MANIFEST["/${entry}"] = {"entryJSFiles":{"[project]/apps/web/app/layout":["static/chunks/layout.js"],"[project]/apps/web/app/(marketing)/pricing/page":["static/chunks/layout.js","/_next/static/chunks/page.js"]}};`,
);

describe('first-load JS budget (plan 06 Phase 0 D2)', () => {
  it('counts the root main files plus the route’s layout and page chunks, each once', () => {
    expect(routeChunks(dir, entry)).toEqual(['static/chunks/runtime.js', 'static/chunks/react.js', 'static/chunks/layout.js', 'static/chunks/page.js']);
    const expected = ['runtime', 'react', 'layout', 'page'].reduce((kb, f) => kb + gzipKb(readFileSync(path.join(dir, `static/chunks/${f}.js`))), 0);
    expect(firstLoadKb(dir, entry)).toBeCloseTo(expected, 6);
  });

  it('fails on a route that was not built, and flags only routes over budget', () => {
    expect(() => routeChunks(dir, '(flow)/start/[projectId]/page')).toThrow(/not found/);
    expect(overBudget([{ route: '/a', kb: 10, maxKb: 12 }, { route: '/b', kb: 13, maxKb: 12 }])).toEqual([{ route: '/b', kb: 13, maxKb: 12 }]);
  });
});
