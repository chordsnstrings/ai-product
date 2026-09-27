import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { hit } from '@arkiv/core';
import { globalTx } from '@arkiv/db';
import { DomainError, MIN_PASSWORD_LENGTH } from '@arkiv/shared';
import { recordLoginFailure, type LoginMeta } from './login-attempts';
import { createSession } from './sessions';
import { notifyIfNewDevice } from './signals';

/**
 * Optional customer password (standard §34 "optional password (Argon2id)"; plan 03 Part C "Use password (if set)").
 * Sign-in stays passwordless by default: a password is something a signed-in user adds from Profile, and a
 * forgotten one is reset with an emailed link (which signs them in; they then set a new one).
 */
const WRONG = 'Email or password is wrong.';
/** Verified against when the address has no password, so a miss costs the same as a wrong password. */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$Wf6n2cV2p6lzYxS2yXg9Rw';

export function assertPasswordStrength(pw: string, email?: string | null) {
  if (pw.length < MIN_PASSWORD_LENGTH) throw new DomainError('INVALID', `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (pw.length > 200) throw new DomainError('INVALID', 'That password is too long.');
  if (email && pw.trim().toLowerCase() === email.trim().toLowerCase()) throw new DomainError('INVALID', 'Don’t use your email address as your password.');
  if (new Set(pw).size < 4) throw new DomainError('INVALID', 'Choose a less predictable password.');
}

/** Set or change the user's password. The caller enforces a recent sign-in and rotates/revokes sessions. */
export async function setPassword(userId: string, pw: string): Promise<void> {
  const [u] = await globalTx((tx) => tx`select email from users where id = ${userId} and deleted_at is null`);
  if (!u) throw new DomainError('NOT_FOUND', 'Account not found.');
  assertPasswordStrength(pw, u.email as string);
  const h = await argonHash(pw);
  await globalTx((tx) => tx`update users set password_hash = ${h}, password_set_at = now() where id = ${userId}`);
}

export async function removePassword(userId: string): Promise<void> {
  await globalTx((tx) => tx`update users set password_hash = null, password_set_at = null where id = ${userId}`);
}

export async function hasPassword(userId: string): Promise<boolean> {
  const [u] = await globalTx((tx) => tx`select password_hash is not null as has from users where id = ${userId}`);
  return !!u?.has;
}

/**
 * Email + password sign-in. One uniform refusal for an unknown address, an account without a password and a wrong
 * password (no account enumeration); at most 10 tries per address per 15 minutes on top of the per-IP budget the
 * route applies. A locked or deleted account is refused by createSession, after the password matched.
 */
export async function passwordLogin(email: string, pw: string, meta: LoginMeta) {
  const addr = email.trim().toLowerCase();
  try {
    await hit(`password:email:${addr}`, 10, 900);
    const [u] = await globalTx((tx) => tx`select id, password_hash from users where email = ${addr}`);
    const ok = await argonVerify((u?.password_hash as string) ?? DUMMY_HASH, pw).catch(() => false);
    if (!u || !u.password_hash || !ok) throw new DomainError('UNAUTHENTICATED', WRONG);
    const s = await createSession(u.id as string, meta, undefined, 'password');
    await notifyIfNewDevice(u.id as string, s.sessionId, meta);
    return { ...s, userId: u.id as string, email: addr };
  } catch (e) {
    if (e instanceof DomainError && e.code !== 'RATE_LIMITED') {
      await recordLoginFailure('password', { email: addr }, e.message, meta, /locked/i.test(e.message) ? 'locked' : 'failed');
    }
    throw e;
  }
}
