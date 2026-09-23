import { globalTx, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';

/**
 * Fixed-window counter in Postgres (no Redis in V1). Returns remaining budget or throws RATE_LIMITED.
 * Keys look like `login:ip:1.2.3.4`, `magic:email:a@b.com`, `upload:ws:<id>`.
 */
export async function hit(key: string, limit: number, windowSeconds: number, tx?: Tx): Promise<number> {
  const run = async (t: Tx) => {
    const [row] = await t`
      insert into rate_limits (key, window_start, count)
      values (${key}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
      on conflict (key, window_start) do update set count = rate_limits.count + 1
      returning count, window_start`;
    const count = row!.count as number;
    if (count > limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(row!.window_start as string).getTime() + windowSeconds * 1000 - Date.now()) / 1000),
      );
      throw new DomainError('RATE_LIMITED', 'Too many requests. Please wait a moment.', { retryAfter });
    }
    return limit - count;
  };
  return tx ? run(tx) : globalTx(run);
}

export async function sweepRateLimits(tx: Tx): Promise<number> {
  const r = await tx`delete from rate_limits where window_start < now() - interval '1 day'`;
  return r.count;
}
