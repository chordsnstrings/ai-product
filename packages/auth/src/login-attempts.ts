import { isIP } from 'node:net';
import { globalTx } from '@arkiv/db';
import type { EdgeGeo } from '@arkiv/shared';

/** Request details every sign-in path passes along (for sessions and failed-attempt records). */
export interface LoginMeta {
  ip?: string | null;
  userAgent?: string | null;
  geo?: EdgeGeo | null;
}

export type LoginMethod = 'magic_link' | 'passkey' | 'google' | 'apple' | 'password';

/**
 * A failed sign-in (plan 05 §3 Users "failed logins"): written in its own transaction, so it survives the failed
 * attempt's rollback, and never allowed to change the outcome the user sees. The app can write these rows but not
 * read them back; staff read them on the user's page.
 */
export async function recordLoginFailure(
  method: LoginMethod,
  who: { email?: string | null; userId?: string | null },
  reason: string,
  meta: LoginMeta = {},
  outcome: 'failed' | 'locked' = 'failed',
): Promise<void> {
  const ip = meta.ip && isIP(meta.ip) ? meta.ip : null;
  let userId = who.userId ?? null;
  const email = who.email?.trim().toLowerCase() || null;
  await globalTx(async (tx) => {
    if (!userId && email) userId = ((await tx`select id from users where email = ${email}`)[0]?.id as string) ?? null;
    await tx`insert into login_attempts (email, user_id, method, outcome, reason, ip, user_agent, geo)
             values (${email}, ${userId}, ${method}, ${outcome}, ${reason.slice(0, 200)}, ${ip}, ${meta.userAgent?.slice(0, 300) ?? null}, ${meta.geo ? tx.json(meta.geo as never) : null})`;
  }).catch((e) => console.warn('[auth] could not record failed sign-in', (e as Error).message));
}
