import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, globalTx, ownerPool, withAdmin, withSystem } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { DomainError, newId } from '@arkiv/shared';
import { bannerApplies, describeAudience, parseBannerAudience, type StatusBannerValue } from './status-banner';
import { storage, storageErrorStats } from './storage';
import { instanceId, lastBackup, recordHeartbeat, sweepHeartbeats } from './system-health';

beforeEach(truncateAll);
afterAll(closeAll);

describe('status banner audiences (plan 05 §22)', () => {
  const viewer = (o: Partial<{ workspaceId: string; planCode: string | null; providers: string[] }> = {}) => ({ workspaceId: newId(), planCode: 'LAUNCH', providers: [] as string[], ...o });
  const b = (audience?: StatusBannerValue['audience']): StatusBannerValue => ({ text: 'TikTok sync delayed', tone: 'warn', audience });

  it('shows a banner to everyone, a plan subset, workspaces with a connector, or listed workspaces', () => {
    const ws = newId();
    expect(bannerApplies(b(), null)).toBe(true);
    expect(bannerApplies(b({ kind: 'all' }), viewer())).toBe(true);
    expect(bannerApplies(b({ kind: 'plans', plans: ['GROWTH', 'FREE'] }), viewer())).toBe(false);
    expect(bannerApplies(b({ kind: 'plans', plans: ['GROWTH', 'FREE'] }), viewer({ planCode: null }))).toBe(true);
    expect(bannerApplies(b({ kind: 'integration', provider: 'tiktok' }), viewer({ providers: ['meta'] }))).toBe(false);
    expect(bannerApplies(b({ kind: 'integration', provider: 'tiktok' }), viewer({ providers: ['tiktok'] }))).toBe(true);
    expect(bannerApplies(b({ kind: 'workspaces', ids: [ws] }), viewer({ workspaceId: ws }))).toBe(true);
    expect(bannerApplies(b({ kind: 'workspaces', ids: [ws] }), viewer())).toBe(false);
    // Outside a workspace (the funnel) only banners for everyone show.
    expect(bannerApplies(b({ kind: 'integration', provider: 'tiktok' }), null)).toBe(false);
    expect(bannerApplies({ text: '', tone: 'info' }, viewer())).toBe(false);
  });

  it('parses and validates the console form', () => {
    expect(parseBannerAudience({ audience: 'plans', plans: 'launch, growth' })).toEqual({ kind: 'plans', plans: ['LAUNCH', 'GROWTH'] });
    expect(() => parseBannerAudience({ audience: 'plans', plans: 'gold' })).toThrow(DomainError);
    expect(parseBannerAudience({ audience: 'integration', provider: 'TikTok' })).toEqual({ kind: 'integration', provider: 'tiktok' });
    expect(() => parseBannerAudience({ audience: 'workspaces', workspaceIds: 'abc' })).toThrow(/UUIDs/);
    const id = newId();
    expect(describeAudience(parseBannerAudience({ audience: 'workspaces', workspaceIds: `${id}, ${id}` }))).toBe('1 workspace');
  });
});

describe('service heartbeats (plan 05 §22)', () => {
  it('records web, admin and worker instances; the app role cannot pose as the worker or read the table', async () => {
    await recordHeartbeat('web');
    await recordHeartbeat('admin');
    await recordHeartbeat('worker', { queues: 3 });
    await recordHeartbeat('web');
    const rows = await ownerPool()`select service, instance, detail from service_heartbeats order by service`;
    expect(rows.map((r) => [r.service, r.instance])).toEqual([['admin', instanceId()], ['web', instanceId()], ['worker', instanceId()]]);
    expect(rows[2]!.detail).toMatchObject({ queues: 3, pid: process.pid, storageErrors: expect.any(Number) });
    await expect(globalTx((tx) => tx`select service_heartbeat('worker', 'x', '{}')`)).rejects.toThrow(/web and admin only/);
    await expect(globalTx((tx) => tx`select * from service_heartbeats`)).rejects.toThrow(/permission denied/);
    await ownerPool()`update service_heartbeats set last_seen_at = now() - interval '2 days' where service = 'admin'`;
    expect(await withSystem((tx) => sweepHeartbeats(tx))).toBe(1);
  });

  it('counts storage errors in the process', async () => {
    const before = storageErrorStats().count;
    await expect(storage().get(`t/${newId()}/missing.bin`)).rejects.toThrow();
    expect(storageErrorStats()).toMatchObject({ count: before + 1, last: expect.stringMatching(/^get:/) });
  });
});

describe('backups (plan 05 §22)', () => {
  it('reads the latest backup recorded by staff when the provider API is not configured', async () => {
    expect(await withAdmin((tx) => lastBackup(tx))).toEqual({ source: 'none', lastAt: null, detail: null });
    await ownerPool()`insert into platform_settings (key, value) values ('ops.backup_check', ${ownerPool().json({ at: '2026-09-24T09:00:00Z', lastBackupAt: '2026-09-24T03:00:00Z', result: 'ok', notes: null })})`;
    try {
      expect(await withAdmin((tx) => lastBackup(tx))).toMatchObject({ source: 'manual', lastAt: '2026-09-24T03:00:00Z' });
    } finally {
      await ownerPool()`delete from platform_settings where key = 'ops.backup_check'`;
    }
  });
});
