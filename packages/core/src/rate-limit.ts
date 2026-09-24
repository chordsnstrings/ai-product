import { sideTx, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { isAllowlisted } from './allowlist';

/**
 * Fixed-window counter in Postgres (no Redis in V1). Returns remaining budget or throws RATE_LIMITED.
 * Keys look like `login:ip:1.2.3.4`, `magic:email:a@b.com`, `upload:ws:<id>`.
 * `allow` and `subject` name who is asking (normalised abuse keys: ip:/24, domain:, ws:). Staff can tighten the
 * limit to a fraction for any of them (plan 05 §15 "rate-limit tighten"); an allowlisted `allow` key also lifts it.
 */
export async function hit(key: string, limit: number, windowSeconds: number, tx?: Tx, opts: { allow?: (string | null | undefined)[]; subject?: (string | null | undefined)[] } = {}): Promise<number> {
  const run = async (t: Tx) => {
    limit = Math.max(1, Math.floor(limit * (await tightenFactor(t, [...(opts.allow ?? []), ...(opts.subject ?? [])]))));
    const [row] = await t`
      insert into rate_limits (key, window_start, count)
      values (${key}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
      on conflict (key, window_start) do update set count = rate_limits.count + 1
      returning count, window_start`;
    const count = row!.count as number;
    // Abuse heuristics honour staff allowlists (plan 05 §15); checked only once the limit is exceeded.
    if (count > limit && opts.allow?.length && (await isAllowlisted(t, opts.allow))) return 0;
    if (count > limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(row!.window_start as string).getTime() + windowSeconds * 1000 - Date.now()) / 1000),
      );
      throw new DomainError('RATE_LIMITED', 'Too many requests. Please wait a moment.', { retryAfter });
    }
    return limit - count;
  };
  return tx ? run(tx) : sideTx(run);
}

export async function sweepRateLimits(tx: Tx): Promise<number> {
  const r = await tx`delete from rate_limits where window_start < now() - interval '1 day'`;
  return r.count;
}

/** How long sign-in records are kept (plan 05 §3 "login history, failed logins"; standard §40 data minimisation). */
export const SIGN_IN_RECORD_DAYS = 180;

/**
 * Daily retention for sign-in records: failed attempts, finished (signed-out or expired) sessions and sign-in links
 * older than SIGN_IN_RECORD_DAYS, and OAuth/passkey challenges a day after they expired. Live sessions are kept.
 */
export async function sweepSignInRecords(tx: Tx): Promise<number> {
  const days = SIGN_IN_RECORD_DAYS;
  const a = await tx`delete from login_attempts where at < now() - make_interval(days => ${days})`;
  const s = await tx`delete from sessions where (revoked_at is not null or expires_at < now())
                     and greatest(coalesce(revoked_at, expires_at), last_seen_at) < now() - make_interval(days => ${days})`;
  const m = await tx`delete from magic_links where created_at < now() - make_interval(days => ${days})`;
  const o = await tx`delete from oauth_states where expires_at < now() - interval '1 day'`;
  return a.count + s.count + m.count + o.count;
}

/** Smallest active staff-set rate-limit factor for these keys (1 when none). */
async function tightenFactor(t: Tx, keys: (string | null | undefined)[] | undefined): Promise<number> {
  const ks = [...new Set((keys ?? []).filter((k): k is string => !!k))];
  if (!ks.length) return 1;
  const [o] = await t`select min(rate_limit_factor)::float8 as f from abuse_overrides where key in ${t(ks)} and until > now() and rate_limit_factor is not null`;
  return o?.f == null ? 1 : Math.min(1, Math.max(0.01, Number(o.f)));
}
