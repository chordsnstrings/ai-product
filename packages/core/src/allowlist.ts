import type { Tx } from '@arkiv/db';

/**
 * Abuse allowlist (plan 05 §15 edge case): legitimate agencies or photographers evaluating many SKUs trip the
 * multi-SKU / provisional-farm heuristics. Staff allowlist a key for up to 30 days, with a reason; the
 * heuristics consult it before refusing. Keys are normalised so the console and the checks agree:
 *   ip:<a.b.c>        an IPv4 /24 (or the first four groups of an IPv6 address, a /64)
 *   domain:<domain>   an email domain
 *   ws:<uuid>         a workspace
 */
export const allowKey = {
  ip(ip: string | null | undefined): string | null {
    if (!ip) return null;
    const v = ip.trim().toLowerCase();
    if (v.includes(':')) return `ip:${v.split(':').slice(0, 4).join(':')}`;
    const parts = v.split('.');
    return parts.length === 4 ? `ip:${parts.slice(0, 3).join('.')}` : null;
  },
  domain(email: string | null | undefined): string | null {
    const d = email?.trim().toLowerCase().split('@')[1];
    return d ? `domain:${d}` : null;
  },
  ws(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `ws:${workspaceId}` : null;
  },
};

/** Normalise a key typed by staff (e.g. "1.2.3.4" → "ip:1.2.3", "a@b.com" → "domain:b.com"). */
export function normalizeAllowKey(raw: string): string {
  const k = raw.trim().toLowerCase();
  if (/^(ip|domain|ws):/.test(k)) {
    if (k.startsWith('ip:')) return allowKey.ip(k.slice(3)) ?? k;
    return k;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(k)) return `ws:${k}`;
  if (k.includes('@')) return allowKey.domain(k) ?? k;
  if (/^\d{1,3}(\.\d{1,3}){2,3}$/.test(k) || k.includes(':')) return allowKey.ip(k.split('.').length === 3 ? `${k}.0` : k) ?? k;
  return `domain:${k}`;
}

/** Is any of these keys on an unexpired allowlist entry? */
export async function isAllowlisted(tx: Tx, keys: (string | null | undefined)[]): Promise<boolean> {
  const ks = [...new Set(keys.filter((k): k is string => !!k))];
  if (!ks.length) return false;
  const [r] = await tx`select 1 from abuse_allowlist where key in ${tx(ks)} and until > now() limit 1`;
  return !!r;
}
