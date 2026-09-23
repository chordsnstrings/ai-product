import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Plan 02 §1.1: "UI hiding is cosmetic; the server always re-checks." Every mutating action of the tenant API
 * must be authorised by role on the server: either the action block calls assertCan itself, or it calls a
 * domain function whose own body calls assertCan. This scans the route sources so a new action (or a new
 * domain function) cannot silently skip the check. The domain functions' behaviour for a Viewer and a held
 * workspace is exercised in packages/core/src/authz.test.ts.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROUTES = ['apps/web/app/api/w/[slug]/[action]/route.ts', 'apps/web/app/api/projects/[id]/[action]/route.ts', 'apps/web/app/api/scenes/[id]/[action]/route.ts'];

/** Exported async functions of core/billing, mapped to whether their body calls assertCan. */
function guardedFunctions(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const pkg of ['packages/core/src', 'packages/billing/src']) {
    for (const f of readdirSync(path.join(root, pkg)).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(path.join(root, pkg, f), 'utf8');
      const re = /export async function (\w+)\s*[(<]/g;
      const starts = [...src.matchAll(re)];
      starts.forEach((m, i) => {
        const body = src.slice(m.index!, starts[i + 1]?.index ?? src.length);
        out.set(m[1]!, (out.get(m[1]!) ?? false) || /\bassertCan\(/.test(body));
      });
    }
  }
  return out;
}

function actionBlocks(src: string): { action: string; body: string }[] {
  const marks = [...src.matchAll(/case '([a-z-]+)':/g)];
  return marks.map((m, i) => ({ action: m[1]!, body: src.slice(m.index!, marks[i + 1]?.index ?? src.length) }));
}

describe('tenant API authorisation coverage', () => {
  const guarded = guardedFunctions();

  it('finds the domain functions it relies on', () => {
    for (const fn of ['createExperiment', 'dismissRecommendation', 'setExperimentState', 'linkAdToVariant', 'attachEvidence', 'importHistoricalCreative', 'ingestBytes', 'decideFact', 'retryProduction', 'cancelDeletion']) {
      expect(guarded.get(fn), fn).toBe(true);
    }
  });

  for (const file of ROUTES) {
    it(`every action in ${file} is authorised server-side`, () => {
      const blocks = actionBlocks(readFileSync(path.join(root, file), 'utf8'));
      expect(blocks.length).toBeGreaterThan(2);
      const unguarded = blocks
        .filter((b) => {
          if (/\bassertCan\(/.test(b.body)) return false;
          const calls = [...b.body.matchAll(/\b(\w+)\(/g)].map((m) => m[1]!);
          return !calls.some((c) => guarded.get(c));
        })
        .map((b) => b.action);
      expect(unguarded).toEqual([]);
    });
  }
});
