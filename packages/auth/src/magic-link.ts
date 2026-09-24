import { createHash, randomBytes } from 'node:crypto';
import { globalTx } from '@arkiv/db';
import { DomainError, env } from '@arkiv/shared';
import { hit } from '@arkiv/core';
import { sendEmail } from '@arkiv/email';
import { recordLoginFailure, type LoginMeta } from './login-attempts';
import { createSession, findOrCreateUser } from './sessions';

/**
 * Email magic links (plan 04 L5: email-only signup). The emailed URL opens a confirm page; only a POST consumes
 * the token, so email security scanners that pre-fetch links cannot burn it (plan 03 Part C).
 */
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
/** How long an emailed sign-in link works (plan 03 P6: 15 minutes). Shown in the UI copy. */
export const MAGIC_LINK_TTL_MIN = 15;
const TTL_MIN = MAGIC_LINK_TTL_MIN;

const TYPO_DOMAINS: Record<string, string> = { 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com', 'hotmial.com': 'hotmail.com', 'yaho.com': 'yahoo.com', 'outlok.com': 'outlook.com', 'icloud.co': 'icloud.com' };

export function emailSuggestion(email: string): string | null {
  const [local, domain] = email.toLowerCase().split('@');
  const fix = domain ? TYPO_DOMAINS[domain] : undefined;
  return fix ? `${local}@${fix}` : null;
}

export function validEmail(email: string) {
  return /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(email.trim());
}

/** Plus-addressing counts against the base mailbox for abuse limits (plan 02 §3 layer 8). */
export const baseMailbox = (email: string) => email.toLowerCase().replace(/\+[^@]*@/, '@');

export async function requestMagicLink(input: {
  email: string;
  purpose: 'login' | 'claim' | 'resume' | 'step_up';
  provisionalWorkspaceId?: string | null;
  redirectTo?: string | null;
  ip?: string | null;
  productName?: string | null;
}): Promise<{ sent: true; suggestion: string | null }> {
  const email = input.email.trim().toLowerCase();
  if (!validEmail(email)) throw new DomainError('INVALID', 'Enter a valid email address.', { suggestion: emailSuggestion(email) });
  await hit(`magic:email:${baseMailbox(email)}`, 5, 3600);
  if (input.ip) await hit(`magic:ip:${input.ip}`, 30, 3600);
  const token = randomBytes(32).toString('base64url');
  const redirect = input.redirectTo && input.redirectTo.startsWith('/') && !input.redirectTo.startsWith('//') ? input.redirectTo : null;
  await globalTx((tx) => tx`
    insert into magic_links (email, token_hash, purpose, provisional_workspace_id, redirect_to, expires_at, created_ip)
    values (${email}, ${hash(token)}, ${input.purpose}, ${input.provisionalWorkspaceId ?? null}, ${redirect},
            now() + make_interval(mins => ${TTL_MIN}), ${input.ip ?? null})`);
  await sendEmail('magic_link', email, { url: `${env().APP_URL}/auth/magic/${token}`, purpose: input.purpose, productName: input.productName ?? null }, { idempotencyKey: `magic:${hash(token)}` });
  return { sent: true, suggestion: emailSuggestion(email) };
}

export interface MagicLinkPreview {
  status: 'ok' | 'expired' | 'used' | 'invalid';
  email?: string;
  purpose?: string;
}

/** GET handler: inspect without consuming (scanner-safe). */
export async function previewMagicLink(token: string): Promise<MagicLinkPreview> {
  const [m] = await globalTx((tx) => tx`select email, purpose, expires_at, consumed_at from magic_links where token_hash = ${hash(token)}`);
  if (!m) return { status: 'invalid' };
  if (m.consumed_at) return { status: 'used', email: m.email };
  if (new Date(m.expires_at as string) < new Date()) return { status: 'expired', email: m.email };
  return { status: 'ok', email: m.email, purpose: m.purpose };
}

/** "a•••@domain.com": shows whose link it was without printing the whole address on a shareable page. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

/**
 * One-tap resend from an expired (or already used) link (plan 03 P6 edge: "Link expired (15 min) → a one-tap
 * resend"). A fresh link goes to the same address with the same purpose, saved preview and destination, so the
 * visitor doesn't retype anything; the normal per-address and per-IP limits apply. The address itself is never
 * returned (only masked): the old token proves nothing about who holds it now.
 */
export async function resendMagicLink(token: string, ip: string | null): Promise<{ sent: true; to: string }> {
  const [m] = await globalTx((tx) => tx`select email, purpose, provisional_workspace_id, redirect_to, expires_at, consumed_at from magic_links where token_hash = ${hash(token)}`);
  if (!m) throw new DomainError('NOT_FOUND', 'This link isn’t valid. Request a new one from the sign-in page.');
  if (!m.consumed_at && new Date(m.expires_at as string) > new Date()) throw new DomainError('CONFLICT', 'This link still works — use it to sign in.');
  await requestMagicLink({
    email: m.email as string,
    purpose: m.purpose as 'login' | 'claim' | 'resume' | 'step_up',
    provisionalWorkspaceId: (m.provisional_workspace_id as string) ?? null,
    redirectTo: (m.redirect_to as string) ?? null,
    ip,
  });
  return { sent: true, to: maskEmail(m.email as string) };
}

/** POST handler: consume once, create/verify user, create session. A refused link is recorded as a failed sign-in. */
export async function consumeMagicLink(token: string, meta: LoginMeta) {
  let email: string | null = null;
  try {
    return await consume(token, meta, (e) => (email = e));
  } catch (e) {
    if (e instanceof DomainError) {
      const p = email ? null : await previewMagicLink(token).catch(() => null);
      await recordLoginFailure('magic_link', { email: email ?? p?.email ?? null }, e.message, meta, /locked/i.test(e.message) ? 'locked' : 'failed');
    }
    throw e;
  }
}

async function consume(token: string, meta: LoginMeta, seen: (email: string) => void) {
  return globalTx(async (tx) => {
    const [m] = await tx`update magic_links set consumed_at = now()
                         where token_hash = ${hash(token)} and consumed_at is null and expires_at > now()
                         returning email, purpose, provisional_workspace_id, redirect_to`;
    if (!m) {
      const p = await previewMagicLink(token);
      throw new DomainError('CONFLICT', p.status === 'used' ? 'This link was already used.' : 'This link has expired.', { status: p.status, email: p.email });
    }
    seen(m.email as string);
    const user = await findOrCreateUser(tx, m.email as string, { verified: true });
    await tx`insert into user_identities (user_id, provider, provider_subject, email) values (${user.userId}, 'email', ${m.email}, ${m.email})
             on conflict (provider, provider_subject) do nothing`;
    const session = await createSession(user.userId, meta, tx);
    return {
      ...session,
      userId: user.userId,
      email: user.email,
      created: user.created,
      purpose: m.purpose as string,
      provisionalWorkspaceId: (m.provisional_workspace_id as string) ?? null,
      redirectTo: (m.redirect_to as string) ?? null,
    };
  });
}
