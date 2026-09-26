/**
 * Visitor location from the edge's request headers (Cloudflare "visitor location headers", Vercel IP headers),
 * for the staff console's session city (plan 05 §3) and funnel country/state slices (§4). Informational only: it is
 * never used for access decisions, and it is absent when the app is reached without such an edge.
 */
export interface EdgeGeo {
  city: string | null;
  region: string | null;
  country: string | null;
}

interface HeaderBag {
  get(name: string): string | null;
}

const clean = (v: string | null | undefined, max: number) => {
  if (!v) return null;
  let s = v;
  try {
    s = decodeURIComponent(v); // Vercel URL-encodes city names
  } catch {
    /* keep raw */
  }
  s = s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
  return s && s !== 'XX' && s !== 'T1' ? s : null; // Cloudflare: XX = unknown, T1 = Tor
};

export function geoFromHeaders(h: HeaderBag): EdgeGeo | null {
  const country = clean(h.get('cf-ipcountry') ?? h.get('x-vercel-ip-country') ?? h.get('x-country-code'), 2)?.toUpperCase() ?? null;
  const region = clean(h.get('cf-region-code') ?? h.get('cf-region') ?? h.get('x-vercel-ip-country-region'), 64);
  const city = clean(h.get('cf-ipcity') ?? h.get('x-vercel-ip-city'), 80);
  if (!country && !region && !city) return null;
  return { city, region, country: country && /^[A-Z]{2}$/.test(country) ? country : null };
}

/** "Austin, TX, US" — the parts the edge knew. */
export const geoLabel = (g: Partial<EdgeGeo> | null | undefined) => (g ? [g.city, g.region, g.country].filter(Boolean).join(', ') : '');
