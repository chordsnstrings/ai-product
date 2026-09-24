import { recordAbuseSignalSafe } from '@arkiv/core';
import { globalTx } from '@arkiv/db';
import { sendEmail } from '@arkiv/email';
import { disposableEmailDomain, env, type SignInMethod } from '@arkiv/shared';
import type { LoginMeta } from './login-attempts';

/**
 * Side effects of a sign-in that must never block it: the new-device security email (plan 03 A10) and the
 * disposable-address abuse signal (plan 03 P6).
 */

/** "Chrome on macOS": the coarse device a session came from (browser family + OS), for new-sign-in alerts. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'an unknown device';
}

/** The network a sign-in came from: IPv4 /24 or IPv6 /48 (a phone moving between towers stays "known"). */
function network(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.trim().toLowerCase().replace(/\/\d+$/, '');
  if (v.includes(':')) return v.split(':').slice(0, 3).join(':');
  const p = v.split('.');
  return p.length === 4 ? p.slice(0, 3).join('.') : null;
}

/**
 * Security email for a sign-in from a new device (plan 03 A10 "security (new login …)"): sent when none of the
 * user's earlier sessions came from the same browser family and network. The very first sign-in (account
 * creation) sends nothing. Best-effort: a failure never blocks the sign-in.
 */
export async function notifyIfNewDevice(userId: string, sessionId: string, meta: LoginMeta = {}): Promise<boolean> {
  try {
    return await globalTx(async (tx) => {
      const prior = await tx`select ip::text as ip, user_agent from sessions where user_id = ${userId} and id <> ${sessionId} order by created_at desc limit 100`;
      if (!prior.length) return false;
      const device = deviceLabel(meta.userAgent);
      const net = network(meta.ip);
      const known = prior.some((p) => deviceLabel(p.user_agent as string | null) === device && network(p.ip as string | null) === net);
      if (known) return false;
      const [u] = await tx`select email from users where id = ${userId}`;
      if (!u) return false;
      const where = [meta.geo?.city, meta.geo?.country].filter(Boolean).join(', ');
      await sendEmail(
        'security_alert',
        u.email as string,
        { event: `New sign-in on ${device}${where ? ` near ${where}` : ''}`, when: new Date().toUTCString(), url: `${env().APP_URL}/app` },
        { idempotencyKey: `newlogin:${sessionId}` },
        tx,
      );
      return true;
    });
  } catch (e) {
    console.warn('[auth] could not send the new sign-in notice', (e as Error).message);
    return false;
  }
}

/**
 * A new account on a throwaway mailbox (plan 03 P6: "Disposable email domains → allowed for the free step but
 * flagged for abuse scoring"): allowed, but recorded as an abuse signal staff see grouped by domain.
 */
export async function flagDisposableSignup(email: string, ctx: { workspaceId?: string | null; ip?: string | null; method: SignInMethod }): Promise<boolean> {
  const domain = disposableEmailDomain(email);
  if (!domain) return false;
  await recordAbuseSignalSafe({ kind: 'disposable_email', key: `domain:${domain}`, workspaceId: ctx.workspaceId ?? null, detail: { ip: ctx.ip ?? null, method: ctx.method } });
  return true;
}

/**
 * A security email about a change to the account itself (plan 03 A10 "security (new login, ownership change)"): a
 * sign-in method added or removed, a password set or changed. Best-effort; `key` makes a retry send it once.
 */
export async function securityNotice(userId: string, event: string, key: string): Promise<void> {
  try {
    await globalTx(async (tx) => {
      const [u] = await tx`select email from users where id = ${userId} and deleted_at is null`;
      if (!u) return;
      await sendEmail('security_alert', u.email as string, { event, when: new Date().toUTCString(), url: `${env().APP_URL}/app` }, { idempotencyKey: `security:${key}` }, tx);
    });
  } catch (e) {
    console.warn('[auth] could not send a security notice', (e as Error).message);
  }
}
