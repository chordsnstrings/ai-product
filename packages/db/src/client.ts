import postgres from 'postgres';
import { env, isUuid, DomainError } from '@arkiv/shared';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Anything that can run a query: a pool or an open transaction. */
export type Db = Sql | Tx;

type RoleName = 'owner' | 'app' | 'admin' | 'system';

// Shared across bundle layers and dev hot-reloads in one process, so connections are never duplicated.
// The 'app:side' pool is the app role's second, small pool for sideTx() (see below).
type PoolKey = RoleName | 'app:side';
const g = globalThis as { __arkivPools?: Map<PoolKey, Sql> };
const pools = (g.__arkivPools ??= new Map<PoolKey, Sql>());

function urlFor(role: RoleName): string {
  const e = env();
  switch (role) {
    case 'owner':
      return e.DATABASE_URL;
    case 'app':
      return e.APP_DATABASE_URL;
    case 'admin':
      return e.ADMIN_DATABASE_URL;
    case 'system':
      return e.APP_DATABASE_URL.replace(/\/\/app_rw:app_rw@/, '//system_rw:system_rw@').replace(
        /\/\/app_rw@/,
        '//system_rw@',
      );
  }
}

const URL_ENV: Record<RoleName, string> = { owner: 'DATABASE_URL', app: 'APP_DATABASE_URL', admin: 'ADMIN_DATABASE_URL', system: 'SYSTEM_DATABASE_URL' };

/**
 * Least privilege per process (plan 02 §3 layer 2): a component may only open the roles in DB_ROLES, and in production
 * only with a connection string it was given explicitly (never a dev default or one derived from another role's).
 * Checked on every use (a cached pool included), before any query runs.
 */
export function assertRoleAllowed(role: RoleName): void {
  const allowed = env().DB_ROLES?.split(',');
  if (allowed && !allowed.includes(role)) throw new Error(`This process may not use the ${role} database role (DB_ROLES=${env().DB_ROLES})`);
  if (env().NODE_ENV === 'production' && !process.env[URL_ENV[role]]) throw new Error(`${URL_ENV[role]} is not configured for this process`);
}

function pool(role: RoleName, side = false): Sql {
  assertRoleAllowed(role);
  const key: PoolKey = side ? 'app:side' : role;
  let p = pools.get(key);
  if (!p) {
    const url = role === 'system' ? (env().SYSTEM_DATABASE_URL ?? urlFor(role)) : urlFor(role);
    p = postgres(url, {
      max: side ? 4 : role === 'owner' ? 3 : 10,
      idle_timeout: 20,
      // PgBouncer transaction pooling can't keep named prepared statements; tenant context uses set_config(..., true)
      // (transaction-local), which is pooling-safe. The owner and system roles connect directly.
      prepare: !(env().DB_PGBOUNCER === '1' && (role === 'app' || role === 'admin')),
      onnotice: () => {},
      // bigint → number is safe for our magnitudes (micros < 2^53) and keeps the domain code simple.
      types: {
        bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number) => String(x) },
        numeric: { to: 1700, from: [1700], parse: (x: string) => Number(x), serialize: (x: number) => String(x) },
      },
      transform: { undefined: null },
    });
    pools.set(key, p);
  }
  return p;
}

/** RLS-bound pool. Only usable through withTenant()/globalTx() so a tenant context is always explicit. */
export const appPool = () => pool('app');
/** Staff console pool (admin_rw). All usage must be audited by the admin app. */
export const adminPool = () => pool('admin');
/** Background system work that legitimately spans tenants (dispatcher, sweeps, purge). */
export const systemPool = () => pool('system');
/** Migration owner. Never used by request handlers. */
export const ownerPool = () => pool('owner');

/**
 * Run `fn` inside a transaction bound to one workspace (plan 02 §3 layer 2).
 * `SET LOCAL`-equivalent (`set_config(..., true)`) is transaction-scoped, so it is safe with PgBouncer transaction pooling.
 */
export async function withTenant<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(workspaceId)) throw new DomainError('NOT_FOUND', 'Workspace not found');
  return appPool().begin(async (tx) => {
    await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Transaction on the app pool without tenant context: only global tables are reachable (RLS fails closed). */
export async function globalTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return appPool().begin(fn) as Promise<T>;
}

/**
 * A short, independent transaction on the app role without tenant context, committed on its own whatever the
 * caller's transaction does (rate-limit counters, best-effort abuse signals). It runs on a separate small pool so
 * that code already holding an app connection (inside withTenant/globalTx) never waits on the pool it is itself
 * exhausting: with the main pool full of such callers, a nested globalTx() would wait forever.
 * `fn` must not open further transactions.
 */
export async function sideTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return pool('app', true).begin(fn) as Promise<T>;
}

export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return systemPool().begin(fn) as Promise<T>;
}

export async function withAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return adminPool().begin(fn) as Promise<T>;
}

export async function closeAll(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end({ timeout: 5 })));
  pools.clear();
}

/** Convert snake_case row keys to camelCase (explicit, so repositories stay readable). */
export function camel<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
  return out as T;
}
export const camelAll = <T>(rows: readonly Record<string, unknown>[]): T[] => rows.map((r) => camel<T>(r));
