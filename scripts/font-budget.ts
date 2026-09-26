/**
 * Design §5 font budget: 3 families, latin subset, `font-display: swap`, and only the 2 above-the-fold files
 * preloaded. next/font writes the preloaded files per route into `.next/server/next-font-manifest.json`.
 */
export type FontManifest = { app?: Record<string, string[]>; pages?: Record<string, string[]> };

export const MAX_PRELOADED_FONTS = 2;

/** Routes (layouts/pages) that preload more font files than the budget allows, with what they preload. */
export function fontBudgetViolations(manifest: FontManifest, max = MAX_PRELOADED_FONTS): { route: string; files: string[] }[] {
  const out: { route: string; files: string[] }[] = [];
  for (const table of [manifest.app ?? {}, manifest.pages ?? {}]) {
    for (const [route, files] of Object.entries(table)) {
      const preloaded = [...new Set(files.filter((f) => /\.(woff2?|ttf|otf)$/i.test(f)))];
      if (preloaded.length > max) out.push({ route, files: preloaded });
    }
  }
  return out;
}
