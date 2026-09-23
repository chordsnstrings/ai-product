import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DATA_RECIPIENTS, isListedHost } from './subprocessors';

/** Standard §40 data inventory: every external host the code talks to must appear on the public list. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCES = ['packages', 'apps'];
/** Hosts in code that never receive customer or visitor data. */
const NOT_RECIPIENTS: Record<string, string> = {
  'schema.org': 'JSON-LD vocabulary identifier; never fetched',
  'yourstore.com': 'placeholder text in the upload form',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('data recipients inventory (§40)', () => {
  it('lists every external host the code calls', () => {
    const hosts = new Map<string, string>();
    for (const base of SOURCES) {
      for (const f of sourceFiles(path.join(root, base))) {
        for (const m of readFileSync(f, 'utf8').matchAll(/https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) hosts.set(m[1]!.toLowerCase(), path.relative(root, f));
      }
    }
    expect(hosts.size).toBeGreaterThan(8);
    const missing = [...hosts].filter(([h]) => !isListedHost(h) && !NOT_RECIPIENTS[h] && !h.endsWith('.example')).map(([h, f]) => `${h} (${f})`);
    expect(missing).toEqual([]);
  });

  it('describes each recipient completely and separates what users choose to connect', () => {
    for (const r of DATA_RECIPIENTS) {
      expect(r.purpose && r.data && r.region && r.hosts.length, r.name).toBeTruthy();
    }
    const kinds = new Set(DATA_RECIPIENTS.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['connected', 'sign_in', 'subprocessor']);
    for (const n of ['Google', 'Apple', 'Cloudflare', 'Shopify', 'TikTok']) expect(DATA_RECIPIENTS.some((r) => r.name.startsWith(n)), n).toBe(true);
  });
});
