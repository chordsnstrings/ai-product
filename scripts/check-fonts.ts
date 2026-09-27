/**
 * Build check (design §5): after `next build`, fail if any route of the given apps preloads more than 2 font
 * files. Usage: tsx scripts/check-fonts.ts apps/web apps/admin
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fontBudgetViolations, MAX_PRELOADED_FONTS, type FontManifest } from './font-budget';

const apps = process.argv.slice(2);
if (!apps.length) apps.push('apps/web');
let failed = false;
for (const app of apps) {
  const file = join(app, '.next/server/next-font-manifest.json');
  if (!existsSync(file)) {
    console.error(`${file} not found — build ${app} first`);
    failed = true;
    continue;
  }
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as FontManifest;
  const bad = fontBudgetViolations(manifest);
  for (const b of bad) console.error(`${app} ${b.route} preloads ${b.files.length} font files (max ${MAX_PRELOADED_FONTS}): ${b.files.join(', ')}`);
  if (bad.length) failed = true;
  else console.log(`${app}: every route preloads at most ${MAX_PRELOADED_FONTS} font files`);
}
process.exit(failed ? 1 : 0);
