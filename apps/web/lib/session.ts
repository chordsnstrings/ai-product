import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession, SESSION_COOKIE, SESSION_DAYS, type SessionUser } from '@arkiv/auth';
import { env } from '@arkiv/shared';

export const PROVISIONAL_COOKIE = 'arkiv_preview';
export const VISITOR_COOKIE = 'arkiv_v';

const secure = () => env().NODE_ENV === 'production';

export async function currentUser(): Promise<SessionUser | null> {
  const c = await cookies();
  return getSession(c.get(SESSION_COOKIE)?.value);
}

export async function requireUser(next?: string): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) redirect(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  return u;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86400 });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function provisionalToken(): Promise<string | null> {
  return (await cookies()).get(PROVISIONAL_COOKIE)?.value ?? null;
}

export async function setProvisionalCookie(token: string) {
  (await cookies()).set(PROVISIONAL_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/', maxAge: 7 * 86400 });
}

export async function clearProvisionalCookie() {
  (await cookies()).delete(PROVISIONAL_COOKIE);
}

/** First-party random visitor id for server-side funnel events (no fingerprinting). */
/** Whether this browser already carried our visitor cookie before this request (a returning visitor). */
export async function hasVisitorCookie(): Promise<boolean> {
  return !!(await cookies()).get(VISITOR_COOKIE)?.value;
}

export async function visitorId(): Promise<string> {
  const c = await cookies();
  const v = c.get(VISITOR_COOKIE)?.value;
  if (v) return v;
  const id = randomBytes(12).toString('base64url');
  try {
    c.set(VISITOR_COOKIE, id, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/', maxAge: 365 * 86400 });
  } catch {
    /* read-only context (server component render) */
  }
  return id;
}
