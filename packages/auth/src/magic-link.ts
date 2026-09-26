import { createHash, randomBytes } from 'node:crypto';
import { globalTx } from '@arkiv/db';
import { DomainError, emailSuggestion, env, MAGIC_LINK_TTL_MIN, validEmail } from '@arkiv/shared';
import { allowKey, assertNotBlocked, hit } from '@arkiv/core';
import { sendEmail } from '@arkiv/email';
import { recordLoginFailure, type LoginMeta } from './login-attempts';
import { safeRedirect } from './redirect';
import { createSession, findOrCreateUser } from './sessions';
import { flagDisposableSignup, notifyIfNewDevice } from './signals';

/**
 * Email magic links (plan 04 L5: email-only signup). The emailed URL opens a confirm page; only a POST consumes
 * the token, so email security scanners that pre-fetch links cannot burn it (plan 03 Part C).
 */
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
/** How long an emailed sign-in link works (plan 03 P6: 15 minutes); shared with the UI copy and the email. */
export { MAGIC_LINK_TTL_MIN, emailSuggestion, validEmail };
const TTL_MIN = MAGIC_LINK_TTL_MIN;

/** Plus-addressing counts against the base mailbox for abuse limits (plan 02 §3 layer 8). */
export const baseMailbox = (email: string) => email.toLowerCase().replace(/\+[^@]*@/, '@');

export async function requestMagicLink(input: {
  email: string;
  purpose: 'login' | 'claim' | 'resume' | 'step_up';
  provisionalWorkspaceId?: string | null;
  redirectTo?: string | null;
  ip?: string | null;
  productName?: string | null;
}): Promise<{ sent: true; suggestion: string | null; pendingHandle: string }> {
  const email = input.email.trim().toLowerCase();
  if (!validEmail(email)) throw new DomainError('INVALID', 'Enter a valid email address.', { suggestion: emailSuggestion(email) });
  // Blocked ranges and staff-tightened limits (plan 05 §15) apply to sign-up/sign-in links too.
  await assertNotBlocked(input.ip);
  const who = [allowKey.ip(input.ip), allowKey.domain(email)];
  await hit(`magic:email:${baseMailbox(email)}`, 5, 3600, undefined, { subject: who });
  if (input.ip) await hit(`magic:ip:${input.ip}`, 30, 3600, undefined, { subject: who });
  const token = randomBytes(32).toString('base64url');
  // The requesting tab polls with this handle to learn the link was used on another device (plan 03 P6).
  const pendingHandle = randomBytes(24).toString('base64url');
  await globalTx((tx) => tx`
    insert into magic_links (email, token_hash, purpose, provisional_workspace_id, redirect_to, expires_at, created_ip, pending_handle_hash)
    values (${email}, ${hash(token)}, ${input.purpose}, ${input.provisionalWorkspaceId ?? null}, ${safeRedirect(input.redirectTo)},
            now() + make_interval(mins => ${TTL_MIN}), ${input.ip ?? null}, ${hash(pendingHandle)})`);
  await sendEmail('magic_link', email, { url: `${env().APP_URL}/auth/magic/${token}`, purpose: input.purpose, productName: input.productName ?? null }, { idempotencyKey: `magic:${hash(token)}` });
  return { sent: true, suggestion: emailSuggestion(email), pendingHandle };
}

/**
 * Whether the link a tab asked for has been used (plan 03 P6: "Link opened on a different device → … the original
 * tab updates via polling"). Knows nothing but the random handle returned to that tab; says nothing about who.
 */
export async function magicLinkStatus(handle: string): Promise<'pending' | 'consumed' | 'expired' | 'unknown'> {
  if (!handle || handle.length < 20 || handle.length > 64) return 'unknown';
  const [m] = await globalTx((tx) => tx`select consumed_at, expires_at from magic_links where pending_handle_hash = ${hash(handle)}`);
  if (!m) return 'unknown';
  if (m.consumed_at) return 'consumed';
  return new Date(m.expires_at as string) < new Date() ? 'expired' : 'pending';
}

export interface MagicLinkPreview {
  status: 'ok' | 'expired' | 'used' | 'invalid';
  email?: string;
  purpose?: string;
  /** For a used link: who signed in with it and where it was headed ("Already signed in" in the same browser). */
  consumedUserId?: string | null;
  consumedSessionId?: string | null;
  redirectTo?: string | null;
}

/** GET handler: inspect without consuming (scanner-safe). */
export async function previewMagicLink(token: string): Promise<MagicLinkPreview> {
  const [m] = await globalTx((tx) => tx`select email, purpose, expires_at, consumed_at, consumed_user_id, consumed_session_id, redirect_to from magic_links where token_hash = ${hash(token)}`);
  if (!m) return { status: 'invalid' };
  if (m.consumed_at) {
    return { status: 'used', email: m.email, consumedUserId: (m.consumed_user_id as string) ?? null, consumedSessionId: (m.consumed_session_id as string) ?? null, redirectTo: safeRedirect(m.redirect_to as string | null) };
  }
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
    const r = await consume(token, meta, (e) => (email = e));
    await notifyIfNewDevice(r.userId, r.sessionId, meta);
    // A throwaway mailbox may still sign up for the free step, but the new account is scored (plan 03 P6).
    if (r.created) await flagDisposableSignup(r.email, { workspaceId: r.provisionalWorkspaceId, ip: meta.ip ?? null, method: 'magic_link' });
    return r;
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
    const user = await findOrCreateUser(tx, m.email as string, { verified: true, method: 'magic_link' });
    await tx`insert into user_identities (user_id, provider, provider_subject, email) values (${user.userId}, 'email', ${m.email}, ${m.email})
             on conflict (provider, provider_subject) do nothing`;
    const session = await createSession(user.userId, meta, tx, 'magic_link');
    await tx`update magic_links set consumed_user_id = ${user.userId}, consumed_session_id = ${session.sessionId} where token_hash = ${hash(token)}`;
    return {
      ...session,
      userId: user.userId,
      email: user.email,
      created: user.created,
      purpose: m.purpose as string,
      provisionalWorkspaceId: (m.provisional_workspace_id as string) ?? null,
      redirectTo: safeRedirect(m.redirect_to as string | null),
    };
  });
}
