import { abuseGate, allowKey, hit } from '@arkiv/core';
import { globalTx } from '@arkiv/db';
import { DomainError, env } from '@arkiv/shared';

/**
 * Cloudflare Turnstile verification (plan 03 P1 edge cases: the upload's bot challenge; plan 03 Part C: sign-in
 * attempts past the per-IP limit). Siteverify is the only network call; a failure of any kind is a "no".
 */
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare's documented always-pass test site key; its widget returns the dummy token below. */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export async function verifyTurnstile(
  token: string | null | undefined,
  secret: string,
  remoteIp: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetchImpl(SITEVERIFY, { method: 'POST', body: new URLSearchParams({ secret, response: token, remoteip: remoteIp ?? '' }) });
    if (!res.ok) return false;
    const j = (await res.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}

/**
 * The site key the sign-in challenge renders: the configured one, or — in mock mode without keys, outside
 * production (local and e2e) — Cloudflare's always-pass test key, whose dummy token is then accepted. Null when no
 * challenge can be shown.
 */
export function loginChallengeSiteKey(): string | null {
  const e = env();
  if (e.TURNSTILE_SITE_KEY) return e.TURNSTILE_SITE_KEY;
  return e.PROVIDERS_MODE === 'mock' && e.NODE_ENV !== 'production' ? TURNSTILE_TEST_SITE_KEY : null;
}

export async function verifyLoginChallenge(token: string | null | undefined, ip: string | null, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!token) return false;
  const e = env();
  if (e.TURNSTILE_SECRET) return verifyTurnstile(token, e.TURNSTILE_SECRET, ip, fetchImpl);
  return e.PROVIDERS_MODE === 'mock' && e.NODE_ENV !== 'production' && token === TURNSTILE_DUMMY_TOKEN;
}

/** Sign-in attempts allowed per IP per window before the human check (plan 03 Part C: "10 … per 15 min, then Turnstile"). */
export const LOGIN_ATTEMPTS_PER_IP = 10;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

/**
 * Count one sign-in attempt against the caller's IP (plan 03 Part C). Past the limit — or when staff forced the
 * challenge for the network (plan 05 §15) — the attempt needs a valid Turnstile token; without one it is refused
 * with `{ challenge: true, siteKey }` so the form can show the widget and retry. Blocked ranges are refused.
 */
export async function assertLoginBudget(ip: string | null | undefined, turnstileToken?: string | null, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!ip) return;
  const gate = await globalTx((tx) => abuseGate(tx, ip, [allowKey.ip(ip)]));
  if (gate.blocked) throw new DomainError('FORBIDDEN', 'Requests from your network are temporarily blocked. Contact support if you think this is a mistake.', { blocked: true });
  let over = gate.forceChallenge;
  let retryAfter: number | undefined;
  try {
    await hit(`login:ip:${ip}`, LOGIN_ATTEMPTS_PER_IP, LOGIN_WINDOW_SECONDS, undefined, { allow: [allowKey.ip(ip)] });
  } catch (e) {
    if (!(e instanceof DomainError) || e.code !== 'RATE_LIMITED') throw e;
    over = true;
    retryAfter = (e.details as { retryAfter?: number } | undefined)?.retryAfter;
  }
  if (!over) return;
  if (await verifyLoginChallenge(turnstileToken, ip, fetchImpl)) return;
  throw new DomainError('RATE_LIMITED', turnstileToken ? 'We couldn’t confirm you’re human. Please try the check again.' : 'Too many sign-in attempts from your network. Confirm you’re human to continue.', {
    challenge: true,
    siteKey: loginChallengeSiteKey(),
    ...(retryAfter ? { retryAfter } : {}),
  });
}
