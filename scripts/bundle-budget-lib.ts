/**
 * Plan 06 Phase 0 D2 bundle-size check: the first-load JavaScript of the marketing and funnel routes, from what
 * `next build` writes. A route's first load is the app's root main files (build-manifest.json) plus the client
 * chunks of its layouts, boundaries and page, as recorded in the route's client-reference manifest
 * (`server/app/<route>/page_client-reference-manifest.js`, `entryJSFiles`). Sizes are gzip bytes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';

export interface Budget {
  /** Route as a visitor sees it, for messages. */
  route: string;
  /** App-router entry, e.g. "(marketing)/pricing/page". */
  entry: string;
  /** Maximum first-load JS, gzip kilobytes (enforced). */
  maxKb: number;
  /** The design goal, reported while it isn't met (plan 01 §performance). */
  targetKb?: number;
}

/** The client chunks a route loads first, relative to `.next/` (deduplicated, in order). */
export function routeChunks(nextDir: string, entry: string): string[] {
  const build = JSON.parse(readFileSync(join(nextDir, 'build-manifest.json'), 'utf8')) as { rootMainFiles?: string[] };
  const file = join(nextDir, 'server/app', `${entry}_client-reference-manifest.js`);
  if (!existsSync(file)) throw new Error(`${file} not found — is "${entry}" a route of this app, and was it built?`);
  const sandbox: { globalThis: Record<string, unknown>; __RSC_MANIFEST?: Record<string, { entryJSFiles?: Record<string, string[]> }> } = { globalThis: {} };
  sandbox.globalThis = sandbox as unknown as Record<string, unknown>;
  runInNewContext(readFileSync(file, 'utf8'), sandbox);
  const m = sandbox.__RSC_MANIFEST?.[`/${entry}`];
  if (!m) throw new Error(`${file} has no manifest for /${entry}`);
  const chunks = [...(build.rootMainFiles ?? []), ...Object.values(m.entryJSFiles ?? {}).flat()];
  return [...new Set(chunks.map((c) => c.replace(/^\/?_next\//, '')))];
}

export const gzipKb = (bytes: Buffer) => gzipSync(bytes, { level: 9 }).length / 1024;

/** First-load JS of a route, gzip kilobytes. */
export function firstLoadKb(nextDir: string, entry: string): number {
  return routeChunks(nextDir, entry).reduce((kb, c) => kb + gzipKb(readFileSync(join(nextDir, c))), 0);
}

/** Routes over their budget. */
export function overBudget(measured: { route: string; kb: number; maxKb: number }[]): { route: string; kb: number; maxKb: number }[] {
  return measured.filter((m) => m.kb > m.maxKb);
}
