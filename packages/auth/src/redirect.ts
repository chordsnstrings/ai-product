import { env } from '@arkiv/shared';

/**
 * Where a sign-in may send the browser afterwards (`next`, `redirectTo`): a path on our own app, never another
 * site. Browsers treat a backslash as a slash (`/\evil.com` resolves to the host evil.com) and drop tabs and
 * newlines inside URLs, so a plain "starts with / but not //" check is not enough. Returns the normalised
 * path + query + hash, or null when the value is unsafe or absent.
 */
export function safeRedirect(next: string | null | undefined): string | null {
  if (typeof next !== 'string' || !next || next.length > 2000) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  if (next.includes('\\') || /[\x00-\x1f\x7f]/.test(next)) return null;
  // An encoded backslash or slash right after the leading slash is decoded by some routers into the same trick.
  if (/^\/(%5c|%2f)/i.test(next)) return null;
  let base: URL;
  try {
    base = new URL(env().APP_URL);
  } catch {
    return null;
  }
  let u: URL;
  try {
    u = new URL(next, base);
  } catch {
    return null;
  }
  if (u.origin !== base.origin) return null;
  return `${u.pathname}${u.search}${u.hash}`;
}
