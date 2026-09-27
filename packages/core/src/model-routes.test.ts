import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';

afterAll(closeAll);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_DIRS = ['packages', 'apps'];
const SKIP = new Set(['node_modules', '.next', 'dist', '.storage', 'migrations']);

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Every task the code sends through the Model Gateway: `task: '<family>.<name>'` literals (gateway calls and the
 * planned cost lines priced on the same route) and `*_TASK = '…'` constants.
 */
async function gatewayTasks(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const d of SOURCE_DIRS) {
    for (const f of await sourceFiles(path.join(ROOT, d))) {
      const src = await readFile(f, 'utf8');
      for (const m of src.matchAll(/\btask:\s*'([a-z_]+\.[a-z_]+)'|\b[A-Z_]+_TASK\s*=\s*'([a-z_]+\.[a-z_]+)'/g)) {
        const task = (m[1] ?? m[2])!;
        found.set(task, [...(found.get(task) ?? []), path.relative(ROOT, f)]);
      }
    }
  }
  return found;
}

describe('model routes match the code (plan 05 §10; x-contracts-14)', () => {
  it('every gateway task has a route, and every route is called by the code or is an approved fallback', async () => {
    const tasks = await gatewayTasks();
    expect(tasks.size).toBeGreaterThan(5);
    const routes = await ownerPool()`select task, fallback_task from model_routes`;
    const routed = new Set(routes.map((r) => r.task as string));
    const fallbacks = new Set(routes.map((r) => r.fallback_task as string | null).filter((t): t is string => !!t));
    // A call with no route fails at runtime (UNAVAILABLE); a route no code calls makes console route changes and
    // circuit toggles silently do nothing.
    expect([...tasks.keys()].filter((t) => !routed.has(t)).map((t) => `${t} (${tasks.get(t)!.join(', ')})`)).toEqual([]);
    expect([...routed].filter((t) => !tasks.has(t) && !fallbacks.has(t))).toEqual([]);
  });
});
