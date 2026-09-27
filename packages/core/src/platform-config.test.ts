import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { COST_LIMITS, DomainError, newId, PROVISIONAL } from '@arkiv/shared';
import { allowKey, isAllowlisted, normalizeAllowKey } from './allowlist';
import { startPreview } from './analysis';
import { authorize } from './cost-governor';
import { utilisationSignals } from './lifecycle';
import { hit } from './rate-limit';
import { clearSettingsCache, getSetting, planQuota, setting } from './settings';
import { createProvisionalWorkspace, inviteMember } from './workspaces';
import { ctxFor } from './testing';

beforeEach(async () => {
  await truncateAll();
  clearSettingsCache();
});
afterEach(async () => {
  // Reference data survives truncation; restore anything a test changed.
  await ownerPool()`update platform_settings set value = '200000' where key = 'free_preview.cogs_cap_micros'`;
  await ownerPool()`delete from platform_settings where key = 'test.value'`;
  await ownerPool()`update platform_settings set value = jsonb_set(value, '{LAUNCH,members}', '2') where key = 'quota.plan_defaults'`;
  clearSettingsCache();
});
afterAll(closeAll);

describe('abuse allowlist (plan 05 §15)', () => {
  it('normalises keys and only honours unexpired entries', async () => {
    expect(allowKey.ip('203.0.113.77')).toBe('ip:203.0.113');
    expect(allowKey.ip('2001:db8:1:2:3::1')).toBe('ip:2001:db8:1:2');
    expect(allowKey.domain('Buyer@Agency.COM')).toBe('domain:agency.com');
    expect(normalizeAllowKey('203.0.113')).toBe('ip:203.0.113');
    expect(normalizeAllowKey('ip:203.0.113.9')).toBe('ip:203.0.113');
    expect(normalizeAllowKey('agency.com')).toBe('domain:agency.com');
    const ws = newId();
    expect(normalizeAllowKey(ws)).toBe(`ws:${ws}`);
    await ownerPool()`insert into abuse_allowlist (key, reason, until, created_by) values ('ip:203.0.113', 'agency', now() + interval '1 day', ${newId()}),
                                                                                      ('domain:old.com', 'expired', now() - interval '1 day', ${newId()})`;
    const run = (keys: (string | null)[]) => withSystem((tx) => isAllowlisted(tx, keys));
    expect(await run([allowKey.ip('203.0.113.200')])).toBe(true);
    expect(await run(['domain:old.com'])).toBe(false);
    expect(await run([null])).toBe(false);
  });

  it('lifts the provisional multi-SKU limit (bounded) and the per-network rate limit', async () => {
    const { workspaceId } = await createProvisionalWorkspace();
    const ctx = { ...ctxFor(workspaceId, workspaceId, 'OWNER', 'PROVISIONAL'), actor: { kind: 'provisional' as const, id: workspaceId } };
    const preview = () => withTenant(workspaceId, (tx) => startPreview(tx, ctx, { url: `https://shop.example/p/${newId()}`, ip: '198.51.100.23' }));
    for (let i = 0; i < PROVISIONAL.MAX_SKUS; i++) await preview();
    await expect(preview()).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    await ownerPool()`insert into abuse_allowlist (key, reason, until, created_by) values ('ip:198.51.100', 'photographer testing SKUs', now() + interval '30 days', ${newId()})`;
    await preview();
    const [n] = await ownerPool()`select count(*)::int as n from skus where workspace_id = ${workspaceId}`;
    expect(n!.n).toBe(PROVISIONAL.MAX_SKUS + 1);

    const key = `provisional:ip:${newId()}`;
    await hit(key, 1, 3600);
    await expect(hit(key, 1, 3600)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(hit(key, 1, 3600, undefined, { allow: ['domain:nobody.example'] })).rejects.toBeInstanceOf(DomainError);
    expect(await hit(key, 1, 3600, undefined, { allow: ['ip:198.51.100'] })).toBe(0);
  });
});

describe('platform settings (plan 05 §20)', () => {
  it('read through a short cache with typed fallbacks', async () => {
    const run = <T>(key: string, fb: T) => withSystem((tx) => getSetting(tx, key, fb));
    expect(await run('test.value', 5)).toBe(5);
    await ownerPool()`insert into platform_settings (key, value) values ('test.value', '"not a number"')`;
    clearSettingsCache();
    expect(await run('test.value', 5)).toBe(5); // wrong shape → fallback
    await ownerPool()`update platform_settings set value = '9' where key = 'test.value'`;
    expect(await run('test.value', 5)).toBe(5); // still cached
    clearSettingsCache('test.value');
    expect(await run('test.value', 5)).toBe(9);
    expect(await withSystem((tx) => setting(tx, 'support.email'))).toBe('support@localhost');
    expect(await withSystem((tx) => setting(tx, 'legal.terms_url'))).toBe('/legal/terms');
  });

  it('the free-preview COGS cap comes from settings', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const line = { kind: 'image' as const, provider: 'byteplus', model: 'seedream-5-0-pro', images: 3 }; // 3 × $0.045 = $0.135
    await ownerPool()`update platform_settings set value = '100000' where key = 'free_preview.cogs_cap_micros'`;
    clearSettingsCache();
    await expect(withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'free_preview', skuId: newId(), lines: [line], idempotencyKey: 'fp-1' }))).rejects.toMatchObject({ code: 'GATE_BLOCKED', details: { ceilingMicros: 100_000 } });
    await ownerPool()`update platform_settings set value = ${String(COST_LIMITS.FREE_PREVIEW_CAP)} where key = 'free_preview.cogs_cap_micros'`;
    clearSettingsCache();
    await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'free_preview', skuId: newId(), lines: [line], idempotencyKey: 'fp-2' }));
  });

  it('per-plan quota defaults override the plan constants', async () => {
    const t = await makeTenant({ plan: 'LAUNCH', state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    expect((await withTenant(t.workspaceId, (tx) => planQuota(tx, 'LAUNCH'))).members).toBe(2);
    await withTenant(t.workspaceId, (tx) => inviteMember(tx, ctx, 'second@example.com', 'MEMBER'));
    await expect(withTenant(t.workspaceId, (tx) => inviteMember(tx, ctx, 'third@example.com', 'MEMBER'))).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    await ownerPool()`update platform_settings set value = jsonb_set(value, '{LAUNCH,members}', '3') where key = 'quota.plan_defaults'`;
    clearSettingsCache();
    await withTenant(t.workspaceId, (tx) => inviteMember(tx, ctx, 'third@example.com', 'MEMBER'));
    expect((await withTenant(t.workspaceId, (tx) => planQuota(tx, null))).members).toBe(2);
  });
});

describe('utilisation indicators (plan 05 §17)', () => {
  const p = (periodKey: string, granted: number, consumed: number) => ({ periodKey, granted, consumed });
  it('low: two completed periods under 25%; the running period does not count', () => {
    expect(utilisationSignals([p('2026-07-01', 7, 1), p('2026-08-01', 7, 1), p('2026-09-01', 7, 0)], '2026-09-01', null).map((s) => s.indicator)).toEqual(['low_utilisation']);
    expect(utilisationSignals([p('2026-08-01', 7, 1), p('2026-09-01', 7, 0)], '2026-09-01', null)).toEqual([]);
    expect(utilisationSignals([p('2026-07-01', 7, 1), p('2026-08-01', 7, 3), p('2026-09-01', 7, 0)], '2026-09-01', null)).toEqual([]);
  });
  it('high: over 95% only with friction', () => {
    expect(utilisationSignals([p('2026-09-01', 7, 7)], '2026-09-01', null)).toEqual([]);
    const s = utilisationSignals([p('2026-09-01', 7, 7)], '2026-09-01', { at: '2026-09-20T10:00:00Z' });
    expect(s).toEqual([{ indicator: 'high_utilisation_friction', evidence: { period: '2026-09-01', used: 7, granted: 7, frictionAt: '2026-09-20T10:00:00Z' } }]);
  });
});
