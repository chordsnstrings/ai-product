import { globalTx } from '@arkiv/db';
import type { LandingRoute } from './landing-routing';

/** How long the proxy reuses the routing table (a page paused or published takes effect within this). */
const TTL_MS = 30_000;
let cached: { at: number; table: LandingRoute[] } | null = null;
let inflight: Promise<LandingRoute[] | null> | null = null;

/**
 * Live campaign pages (plus the default page) with their utm_content prefixes and variant weights: the routing
 * table the proxy decides from. Read once per TTL per server, never per request; null when the database is
 * unreachable (the proxy then leaves routing to the dynamic pages).
 */
export async function landingTable(now = Date.now()): Promise<LandingRoute[] | null> {
  if (cached && now - cached.at < TTL_MS) return cached.table;
  inflight ??= globalTx(async (tx) => {
    const rows = await tx`select slug, coalesce(utm_match, '{}') as utm_match, coalesce(live_variants, '[]'::jsonb) as variants from landing_pages
                          where status = 'live' or slug = 'default'`;
    return rows.map((r) => ({
      slug: r.slug as string,
      utmMatch: (r.utm_match as string[]) ?? [],
      variants: ((r.variants as { key: string; weight: number }[]) ?? []).map((v) => ({ key: String(v.key), weight: Number(v.weight) })),
    }));
  })
    .then((table) => {
      cached = { at: Date.now(), table };
      return table;
    })
    .catch(() => (cached ? cached.table : null))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
