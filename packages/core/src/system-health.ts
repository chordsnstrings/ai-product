import { hostname } from 'node:os';
import { globalTx, withAdmin, withSystem, type Tx } from '@arkiv/db';
import { env } from '@arkiv/shared';
import { storageErrorStats } from './storage';

/**
 * System health (plan 05 §22): service heartbeats, database and queue health, and backups.
 */

export type ServiceName = 'web' | 'worker' | 'admin';

/** A service instance counts as up while its last heartbeat is younger than this. */
export const HEARTBEAT_STALE_SECONDS = 180;

const startedAt = new Date().toISOString();
export const instanceId = () => `${hostname()}:${process.pid}`;

/**
 * Record that this process is alive, with its storage error count. The worker writes with the system role; the web
 * and admin apps go through a narrow definer function (their roles can't read or edit other rows).
 */
export async function recordHeartbeat(service: ServiceName, extra: Record<string, unknown> = {}): Promise<void> {
  const s = storageErrorStats();
  const detail = { startedAt, pid: process.pid, storageErrors: s.count, lastStorageError: s.last, lastStorageErrorAt: s.lastAt, ...extra };
  const id = instanceId();
  if (service === 'worker') {
    await withSystem((tx) => tx`insert into service_heartbeats (service, instance, detail) values ('worker', ${id}, ${tx.json(detail as never)})
                                on conflict (service, instance) do update set last_seen_at = now(), detail = excluded.detail`);
  } else if (service === 'admin') {
    await withAdmin((tx) => tx`select service_heartbeat('admin', ${id}, ${tx.json(detail as never)})`);
  } else {
    await globalTx((tx) => tx`select service_heartbeat('web', ${id}, ${tx.json(detail as never)})`);
  }
}

/** Instances not heard from in a day are dropped (a redeploy replaces every instance id). */
export async function sweepHeartbeats(tx: Tx): Promise<number> {
  const r = await tx`delete from service_heartbeats where last_seen_at < now() - interval '1 day'`;
  return r.count;
}

export interface BackupInfo {
  source: 'digitalocean' | 'manual' | 'none';
  lastAt: string | null;
  detail: string | null;
}

/**
 * Last successful backup: from the DigitalOcean API when a read token and cluster id are configured, else the latest
 * one recorded by staff (setting `ops.backup_check`).
 */
export async function lastBackup(tx: Tx, fetchImpl: typeof fetch = fetch): Promise<BackupInfo> {
  const e = env();
  if (e.DO_API_TOKEN && e.DO_DATABASE_CLUSTER_ID) {
    try {
      const r = await fetchImpl(`https://api.digitalocean.com/v2/databases/${encodeURIComponent(e.DO_DATABASE_CLUSTER_ID)}/backups`, { headers: { Authorization: `Bearer ${e.DO_API_TOKEN}` }, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = (await r.json()) as { backups?: { created_at: string; size_gigabytes?: number }[] };
        const latest = (j.backups ?? []).map((b) => b.created_at).sort().at(-1) ?? null;
        return { source: 'digitalocean', lastAt: latest, detail: `${(j.backups ?? []).length} backups retained` };
      }
      return { source: 'digitalocean', lastAt: null, detail: `DigitalOcean API ${r.status}` };
    } catch (err) {
      return { source: 'digitalocean', lastAt: null, detail: (err as Error).message.slice(0, 120) };
    }
  }
  const [m] = await tx`select value from platform_settings where key = 'ops.backup_check'`;
  const v = m?.value as { at?: string; lastBackupAt?: string; result?: string; notes?: string | null } | null | undefined;
  if (!v?.lastBackupAt) return { source: 'none', lastAt: null, detail: null };
  return { source: 'manual', lastAt: v.lastBackupAt, detail: `checked ${v.at?.slice(0, 10) ?? '?'}: ${v.result ?? ''}${v.notes ? ` · ${v.notes}` : ''}` };
}
