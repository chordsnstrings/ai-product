import { withTenant } from '@arkiv/db';

/**
 * Non-overlapping jobs (standard §39 "queue workers use leases/timeouts"). A job that must never run twice at
 * once for the same subject (an export, an integration sync, a theme clustering) holds a lease row in
 * `workspace_leases` for its run. The TTL is the job's own expiry, so a crashed run's lease lapses on its own.
 * Lease rows rather than session advisory locks: runs span several transactions and pooled connections.
 */
export async function tryJobLease(workspaceId: string, resource: string, holder: string, ttlSeconds: number): Promise<boolean> {
  return withTenant(workspaceId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${'lease:' + workspaceId + ':' + resource}))`;
    await tx`delete from workspace_leases where resource = ${resource} and expires_at < now()`;
    const [live] = await tx`select holder from workspace_leases where resource = ${resource}`;
    if (live) return live.holder === holder;
    await tx`insert into workspace_leases (workspace_id, resource, holder, expires_at)
             values (${workspaceId}, ${resource}, ${holder}, now() + make_interval(secs => ${ttlSeconds}))`;
    return true;
  });
}

export async function releaseJobLease(workspaceId: string, resource: string, holder: string): Promise<void> {
  await withTenant(workspaceId, (tx) => tx`delete from workspace_leases where resource = ${resource} and holder = ${holder}`);
}

/** Extend a lease this holder still owns; false when it lapsed and someone else may hold it now. */
export async function renewJobLease(workspaceId: string, resource: string, holder: string, ttlSeconds: number): Promise<boolean> {
  const r = await withTenant(workspaceId, (tx) => tx`update workspace_leases set expires_at = now() + make_interval(secs => ${ttlSeconds})
                                                     where resource = ${resource} and holder = ${holder} returning 1`);
  return r.length > 0;
}

export const LEASE_BUSY = Symbol('lease-busy');

/** Run `fn` while holding the lease, or return LEASE_BUSY when another live run holds it. */
export async function withJobLease<T>(workspaceId: string, resource: string, holder: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | typeof LEASE_BUSY> {
  if (!(await tryJobLease(workspaceId, resource, holder, ttlSeconds))) return LEASE_BUSY;
  try {
    return await fn();
  } finally {
    await releaseJobLease(workspaceId, resource, holder);
  }
}
