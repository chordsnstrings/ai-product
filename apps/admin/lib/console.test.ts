import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { assertStaff, auditView } from '@arkiv/core';
import { COST_LIMITS, newId, type StaffRole } from '@arkiv/shared';
import { ACTIONS, type ActionName } from './actions';
import { auditFilters, auditRows, jsonDiff } from './audit-query';
import { emailKey } from './email-key';
import { daysFrom, parsePrefs } from './prefs';
import { conversionDrop, hardFailAlert, slaBreach } from './pulse';
import { notTest } from './sql';
import type { StaffUser } from './staff';
import { cogsCap30, tenantFilters, tenantRows } from './tenants-query';

async function staff(roles: StaffRole[]): Promise<StaffUser> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, ${roles.join('+')}, 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: roles.join('+'), roles, sessionId: newId(), reauthAt: new Date() };
}
async function act(s: StaffUser, action: ActionName, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const def = ACTIONS[action];
  assertStaff(s, def.perm);
  const parsed = (def.schema as { parse: (x: unknown) => unknown }).parse(input);
  return ((await (def.run as (s: StaffUser, i: unknown) => Promise<unknown>)(s, parsed)) ?? {}) as Record<string, unknown>;
}
const rowsFor = (f: Record<string, string>) => withAdmin((tx) => tenantRows(tx, tenantFilters(f), { limit: 100, tz: 'America/New_York', freeCapMicros: COST_LIMITS.FREE_PREVIEW_CAP }));

beforeEach(truncateAll);
afterAll(closeAll);

describe('console preferences (plan 05 §1, §2.3)', () => {
  it('defaults to America/New_York, 7 days, test accounts excluded; refuses unknown values', () => {
    expect(parsePrefs({})).toEqual({ tz: 'America/New_York', range: 7, includeTest: false });
    expect(parsePrefs({ tz: 'Europe/London', range: '30', test: '1' })).toEqual({ tz: 'Europe/London', range: 30, includeTest: true });
    expect(parsePrefs({ tz: "UTC'; drop table x", range: '9' })).toMatchObject({ tz: 'America/New_York', range: 7 });
    expect(daysFrom('14', parsePrefs({}))).toBe(14);
    expect(daysFrom(undefined, parsePrefs({ range: '30' }))).toBe(30);
    expect(daysFrom('9999', parsePrefs({}), 365)).toBe(365);
  });

  it('excludes test workspaces from aggregates unless included', async () => {
    const real = await makeTenant();
    const test = await makeTenant();
    await ownerPool()`update workspaces set is_test = true where id = ${test.workspaceId}`;
    await ownerPool()`insert into risk_flags (workspace_id, indicator, evidence) values (${real.workspaceId}, 'idle_7d', '{}'), (${test.workspaceId}, 'idle_7d', '{}')`;
    const count = (includeTest: boolean) => withAdmin(async (tx) => (await tx`select count(*)::int as n from risk_flags where true ${notTest(tx, { includeTest })}`)[0]!.n);
    expect(await count(false)).toBe(1);
    expect(await count(true)).toBe(2);
  });
});

describe('Pulse alert rules (plan 05 §1)', () => {
  it('flags conversion drops, hard-fail rate and SLA breaches', () => {
    expect(conversionDrop(0.3, 0.5)).toBe(true);
    expect(conversionDrop(0.4, 0.5)).toBe(false);
    expect(conversionDrop(0.1, NaN)).toBe(false);
    expect(hardFailAlert(4, 100)).toBe(true);
    expect(hardFailAlert(3, 100)).toBe(false);
    const now = Date.parse('2026-09-23T12:00:00Z');
    expect(slaBreach('Unmatched Stripe', 2, '2026-09-22T11:00:00Z', now)).toBe(true);
    expect(slaBreach('Unmatched Stripe', 2, '2026-09-22T13:00:00Z', now)).toBe(false);
    expect(slaBreach('Unmatched Stripe', 0, '2026-09-01T00:00:00Z', now)).toBe(false);
  });
});

describe('tenant list (plan 05 §2.1)', () => {
  it('filters by churn-risk band, connection health, created range, COGS cap and test accounts', async () => {
    const risky = await makeTenant();
    const calm = await makeTenant({ state: 'ACTIVE_PAID', plan: 'LAUNCH' });
    const test = await makeTenant();
    await ownerPool()`update workspaces set is_test = true, created_at = now() - interval '40 days' where id = ${test.workspaceId}`;
    await ownerPool()`update workspaces set created_at = '2026-01-15T12:00:00Z' where id = ${risky.workspaceId}`;
    await ownerPool()`insert into risk_flags (workspace_id, indicator, evidence) values (${risky.workspaceId}, 'paid_no_export', '{}'), (${risky.workspaceId}, 'idle_7d', '{}'), (${calm.workspaceId}, 'stockout', '{}')`;
    await ownerPool()`insert into integrations (workspace_id, provider, external_account_id, status, scopes, last_success_at) values
                        (${calm.workspaceId}, 'shopify', 'calm.myshopify.com', 'active', '{}', now()),
                        (${risky.workspaceId}, 'meta', 'act_1', 'degraded', '{}', now() - interval '20 days')`;
    // The free tenant spent more than its per-SKU preview caps; the paying one is well under its plan cap.
    await makeSku(risky.workspaceId);
    await ownerPool()`insert into ledger_entries (workspace_id, type, unit, amount, actor, idempotency_key) values
                        (${risky.workspaceId}, 'PROVIDER_COST_RECORDED', 'usd_micros', 2000000, 'system:t', 'c1'),
                        (${calm.workspaceId}, 'PROVIDER_COST_RECORDED', 'usd_micros', 5000000, 'system:t', 'c2')`;
    const ids = (rows: readonly Record<string, unknown>[]) => rows.map((r) => r.id as string).sort();
    expect(ids(await rowsFor({}))).toEqual([risky.workspaceId, calm.workspaceId].sort());
    expect(ids(await rowsFor({ test: '1' }))).toHaveLength(3);
    const [r] = await rowsFor({ risk: 'high' });
    expect(r).toMatchObject({ id: risky.workspaceId, risk_score: 40, risk_band: 'high' });
    expect(ids(await rowsFor({ risk: 'any' }))).toEqual([risky.workspaceId, calm.workspaceId].sort());
    expect(ids(await rowsFor({ integration: 'healthy' }))).toEqual([calm.workspaceId]);
    expect(ids(await rowsFor({ integration: 'degraded' }))).toEqual([risky.workspaceId]);
    expect(ids(await rowsFor({ from: '2026-01-15', to: '2026-01-15' }))).toEqual([risky.workspaceId]);
    expect(ids(await rowsFor({ from: 'not-a-date' }))).toHaveLength(2); // ignored, not an error
    const over = await rowsFor({ filter: 'over_cogs_cap' });
    expect(ids(over)).toEqual([risky.workspaceId]);
    expect(Number(over[0]!.cogs_cap30)).toBe(cogsCap30({ plan: null, paying: false, oneTimePaid30: 0, skus: 1 }));
    expect(cogsCap30({ plan: 'LAUNCH', paying: true, oneTimePaid30: 1, skus: 5 })).toBe(4 * COST_LIMITS.CREATIVE_TEST_CEILING);
  });

  it('saved views belong to one staff member; bulk tag is audited per workspace', async () => {
    const a = await staff(['SUPPORT']);
    const b = await staff(['OPS']);
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    await act(a, 'view.save', { module: 'tenants', name: 'At risk', query: { risk: 'high', bogus: 'x', from: 'nope' } });
    await act(a, 'view.save', { module: 'tenants', name: 'At risk', query: { risk: 'medium' } }); // same name overwrites
    const [v] = await ownerPool()`select id, query from staff_saved_views where staff_id = ${a.staffId}`;
    expect(v!.query).toEqual({ risk: 'medium' });
    await expect(act(b, 'view.delete', { id: v!.id })).rejects.toThrow(/not found/);
    await act(a, 'view.delete', { id: v!.id });

    await ownerPool()`update workspaces set tags = '{vip-2026}' where id = ${t1.workspaceId}`;
    const r = await act(a, 'tenant.bulk_tag', { workspaceIds: [t1.workspaceId, t2.workspaceId], tag: 'Agency' });
    expect(r.message).toMatch(/Tagged 2 of 2/);
    const tags = await ownerPool()`select id, tags from workspaces order by tags`;
    expect(Object.fromEntries(tags.map((x) => [x.id, x.tags]))).toEqual({ [t1.workspaceId]: ['vip-2026', 'agency'], [t2.workspaceId]: ['agency'] });
    const audits = await ownerPool()`select workspace_id, before, after from admin_audit_log where action = 'tenant.bulk_tag' order by workspace_id`;
    expect(audits).toHaveLength(2);
    expect(audits.find((x) => x.workspace_id === t1.workspaceId)).toMatchObject({ before: { tags: ['vip-2026'] }, after: { tags: ['vip-2026', 'agency'] } });
    await act(a, 'tenant.bulk_tag', { workspaceIds: [t1.workspaceId], tag: 'agency', mode: 'remove' });
    expect((await ownerPool()`select tags from workspaces where id = ${t1.workspaceId}`)[0]!.tags).toEqual(['vip-2026']);
    await expect(act(await staff(['FINANCE']), 'tenant.bulk_tag', { workspaceIds: [t1.workspaceId], tag: 'x' })).rejects.toThrow(/role/);
  });
});

describe('audit log (plan 05 §0.4)', () => {
  it('diffs before/after field by field', () => {
    expect(jsonDiff({ status: 'active', tags: ['a'], n: { x: 1, y: 2 } }, { status: 'paused', tags: ['a'], n: { x: 1, y: 3 }, extra: true })).toEqual([
      { path: 'extra', before: undefined, after: true },
      { path: 'n.y', before: 2, after: 3 },
      { path: 'status', before: 'active', after: 'paused' },
    ]);
    expect(jsonDiff({ a: 1 }, undefined)).toEqual([{ path: 'a', before: 1, after: undefined }]);
    expect(jsonDiff('x', 'y')).toEqual([{ path: '(value)', before: 'x', after: 'y' }]);
  });

  it('page views and mutations are recorded with before snapshots; the export honours every filter', async () => {
    const ops = await staff(['OPS']);
    const sup = await staff(['SUPPORT']);
    const t = await makeTenant();
    await withAdmin((tx) => auditView(tx, sup, 'tenants', { q: 'acme', risk: '', test: undefined }));
    await act(ops, 'user.lock', { userId: t.userId, reason: 'ATO suspicion, ticket #4' });
    await act(ops, 'user.unlock', { userId: t.userId, reason: 'owner verified by phone' });
    const [view] = await ownerPool()`select action, after from admin_audit_log where action = 'view.tenants'`;
    expect(view!.after).toEqual({ q: 'acme' });
    const [lock] = await ownerPool()`select before, after from admin_audit_log where action = 'user.lock'`;
    expect(lock).toMatchObject({ before: { locked_at: null, locked_reason: null }, after: { locked: true } });
    const [unlock] = await ownerPool()`select before from admin_audit_log where action = 'user.unlock'`;
    expect((unlock!.before as { locked_reason: string }).locked_reason).toBe('ATO suspicion, ticket #4');

    const rows = (f: Record<string, string>) => withAdmin((tx) => auditRows(tx, auditFilters(f), 100));
    expect((await rows({ q: 'user.' })).map((r) => r.action).sort()).toEqual(['user.lock', 'user.unlock']);
    expect((await rows({ staff: sup.email })).map((r) => r.action)).toEqual(['view.tenants']);
    expect(await rows({ ws: newId() })).toHaveLength(0);
    expect((await rows(new URLSearchParams({ q: 'lock', staff: ops.email }) as never)).length).toBe(2);
  });

  it('unsuppress takes an opaque key so masked pages never carry the address', async () => {
    const sup = await staff(['SUPPORT']);
    await ownerPool()`insert into email_suppressions (email, reason) values ('Jane.Doe@Acme.com', 'bounce')`;
    await expect(act(sup, 'email.unsuppress', { emailKey: emailKey('someone@else.com'), reason: 'typo fixed' })).rejects.toThrow(/isn’t suppressed/);
    await act(sup, 'email.unsuppress', { emailKey: emailKey('jane.doe@acme.com'), reason: 'mailbox fixed, confirmed by phone' });
    expect(await ownerPool()`select 1 from email_suppressions`).toHaveLength(0);
    const [a] = await ownerPool()`select before from admin_audit_log where action = 'email.unsuppress'`;
    expect(a!.before).toMatchObject({ reason: 'bounce' });
  });
});
