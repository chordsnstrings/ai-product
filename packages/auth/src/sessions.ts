import { createHash, randomBytes } from 'node:crypto';
import { globalTx, type Tx } from '@arkiv/db';
import { DomainError, PRIVACY_VERSION, TERMS_VERSION, type SignInMethod } from '@arkiv/shared';
import type { LoginMeta } from './login-attempts';

/**
 * Server-side sessions in Postgres (decided: in-house auth). Cookie holds a random token; DB holds its hash.
 * 30-day rolling expiry; rotated on privilege change; listable and revocable (plan 03 Part C).
 */
export const SESSION_COOKIE = 'arkiv_session';
export const SESSION_DAYS = 30;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  name: string | null;
  lastWorkspaceId: string | null;
  createdAt: string;
}

/**
 * A new session for an active user. Every sign-in path ends here, so a locked or deleted account can never get a
 * session, whichever way it signs in (plan 05 §3 "lock account"). `method` is kept as sign-in history.
 */
export async function createSession(
  userId: string,
  meta: LoginMeta = {},
  tx?: Tx,
  method: SignInMethod | null = null,
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  const run = async (t: Tx) => {
    await assertUserActive(t, userId);
    // The edge's city/region/country, shown to staff next to the IP (plan 05 §3 "sessions (device, IP city…)").
    const [r] = await t`insert into sessions (user_id, token_hash, expires_at, ip, user_agent, geo, method)
                        values (${userId}, ${hash(token)}, ${expiresAt}, ${meta.ip ?? null}, ${meta.userAgent?.slice(0, 300) ?? null},
                                ${meta.geo ? t.json(meta.geo as never) : null}, ${method}) returning id`;
    return r!.id as string;
  };
  const sessionId = tx ? await run(tx) : await globalTx(run);
  return { token, expiresAt, sessionId };
}

/** Refuse a locked or deleted account (FORBIDDEN, customer-safe wording). */
export async function assertUserActive(tx: Tx, userId: string): Promise<void> {
  const [u] = await tx`select locked_at, deleted_at from users where id = ${userId}`;
  if (u?.locked_at) throw new DomainError('FORBIDDEN', 'This account is locked. Contact support.');
  if (!u || u.deleted_at) throw new DomainError('FORBIDDEN', 'This account was deleted.');
}

/**
 * Rotate a session on a privilege change (plan 03 Part C "rotated on privilege change"): a new token replaces the
 * old one, which is revoked in the same transaction, so a token captured before the change stops working. The
 * caller sets the new cookie.
 */
export async function rotateSession(oldSessionId: string, userId: string): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  return globalTx(async (tx) => {
    const [old] = await tx`update sessions set revoked_at = now()
                           where id = ${oldSessionId} and user_id = ${userId} and revoked_at is null and expires_at > now()
                           returning ip, user_agent, geo, last_workspace_id, method, created_at`;
    if (!old) throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');
    await assertUserActive(tx, userId);
    // The sign-in time carries over: rotation is not a fresh sign-in, so it doesn't satisfy a step-up check.
    const [r] = await tx`insert into sessions (user_id, token_hash, expires_at, ip, user_agent, geo, last_workspace_id, method, created_at)
                         values (${userId}, ${hash(token)}, ${expiresAt}, ${old.ip}, ${old.user_agent}, ${old.geo ? tx.json(old.geo as never) : null},
                                 ${old.last_workspace_id}, ${old.method}, ${old.created_at}) returning id`;
    return { token, expiresAt, sessionId: r!.id as string };
  });
}

export async function getSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length < 20) return null;
  return globalTx(async (tx) => {
    const [s] = await tx`
      select s.id, s.user_id, s.last_seen_at, s.last_workspace_id, s.created_at, u.email, u.name, u.locked_at, u.deleted_at
      from sessions s join users u on u.id = s.user_id
      where s.token_hash = ${hash(token)} and s.revoked_at is null and s.expires_at > now()`;
    if (!s || s.locked_at || s.deleted_at) return null;
    // Rolling expiry, touched at most every 10 minutes to avoid write amplification.
    if (Date.now() - new Date(s.last_seen_at as string).getTime() > 10 * 60_000) {
      await tx`update sessions set last_seen_at = now(), expires_at = now() + make_interval(days => ${SESSION_DAYS}) where id = ${s.id}`;
    }
    return { sessionId: s.id, userId: s.user_id, email: s.email, name: s.name, lastWorkspaceId: s.last_workspace_id, createdAt: s.created_at };
  });
}

export async function revokeSession(sessionId: string, userId?: string) {
  await globalTx((tx) => tx`update sessions set revoked_at = now() where id = ${sessionId} ${userId ? tx`and user_id = ${userId}` : tx``}`);
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  await globalTx((tx) => tx`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null
                             ${exceptSessionId ? tx`and id <> ${exceptSessionId}` : tx``}`);
}

export async function listSessions(userId: string) {
  return globalTx((tx) => tx`select id, created_at, last_seen_at, ip, user_agent from sessions
                             where user_id = ${userId} and revoked_at is null and expires_at > now() order by last_seen_at desc`);
}

export async function rememberWorkspace(sessionId: string, workspaceId: string) {
  await globalTx((tx) => tx`update sessions set last_workspace_id = ${workspaceId} where id = ${sessionId}`);
}

/** Step-up (plan 02 M14): sensitive actions need a login within the last 10 minutes. */
export function assertRecentLogin(s: SessionUser, minutes = 10) {
  if (Date.now() - new Date(s.createdAt).getTime() > minutes * 60_000) {
    throw new DomainError('FORBIDDEN', 'Please confirm it’s you to continue.', { stepUp: true });
  }
}

/**
 * The user for a verified email, created on first sign-in. A new account records its acceptance of the Terms and
 * Privacy Policy with the sign-in method and time (plan 03 P6: "acceptance logged by the action and timestamp").
 */
export async function findOrCreateUser(tx: Tx, email: string, opts: { name?: string | null; verified: boolean; method?: SignInMethod | null }) {
  const normalized = email.trim().toLowerCase();
  const [u] = await tx`
    insert into users (email, name, email_verified_at, terms_accepted_at, terms_version, privacy_version, terms_method)
    values (${normalized}, ${opts.name ?? null}, ${opts.verified ? new Date() : null}, now(), ${TERMS_VERSION}, ${PRIVACY_VERSION}, ${opts.method ?? null})
    on conflict (email) do update set
      name = coalesce(users.name, excluded.name),
      email_verified_at = coalesce(users.email_verified_at, excluded.email_verified_at)
    returning id, email, (xmax = 0) as created, locked_at, deleted_at`;
  if (u!.locked_at) throw new DomainError('FORBIDDEN', 'This account is locked. Contact support.');
  if (u!.deleted_at) throw new DomainError('FORBIDDEN', 'This account was deleted.');
  return { userId: u!.id as string, email: u!.email as string, created: !!u!.created };
}
