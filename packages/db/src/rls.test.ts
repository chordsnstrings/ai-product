import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@arkiv/shared';
import { appPool, closeAll, globalTx, ownerPool, withAdmin, withSystem, withTenant } from './client';
import { makeSku, makeTenant, truncateAll } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

describe('RLS coverage (plan 02 §8.1)', () => {
  it('every table is registered as tenant or global', async () => {
    const rows = await ownerPool()`select * from arkiv_unregistered_tables()`;
    expect(rows.map((r) => r.arkiv_unregistered_tables)).toEqual([]);
  });

  it('every tenant table has RLS enabled + forced and a tenant policy (or is staff-only)', async () => {
    const rows = await ownerPool()<{ table_name: string; rls: boolean; forced: boolean; policies: string[] }[]>`
      select r.table_name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             coalesce(array_agg(p.polname) filter (where p.polname is not null), '{}') as policies
      from table_registry r join pg_class c on c.relname = r.table_name
      left join pg_policy p on p.polrelid = c.oid
      where r.kind = 'tenant' group by r.table_name, c.relrowsecurity, c.relforcerowsecurity`;
    expect(rows.length).toBeGreaterThan(30);
    for (const r of rows) {
      expect(r.rls, `${r.table_name} rls`).toBe(true);
      expect(r.forced, `${r.table_name} forced`).toBe(true);
      const staffOnly = r.table_name === 'tenant_notes' || r.table_name === 'qa_reviews';
      if (!staffOnly) expect(r.policies, r.table_name).toContain('tenant_isolation');
    }
  });

  it('every table with a workspace_id column is tenant-scoped, or is justified here and unreadable by app_rw', async () => {
    // Global tables that carry a workspace_id but hold no rows the app role may read (plan 02 §3 layer 2).
    const JUSTIFIED: Record<string, string> = {
      stripe_events: 'raw Stripe payloads; written via stripe_event_receive(), read by system/staff only',
      funnel_events: 'insert-only funnel log (pre-tenant visitors); read by staff analytics only',
      abuse_signals: 'insert-only abuse log; read by staff only',
      data_requests: 'privacy requests; app inserts, staff and system process',
      purge_certificates: 'written by the purge job after the workspace is gone; staff/system only',
      rights_cases: 'staff rights/takedown cases; staff only',
      admin_audit_log: 'append-only staff audit log; admin_rw only',
    };
    const rows = await ownerPool()<{ table_name: string; kind: string | null; rls: boolean; forced: boolean; policies: string[]; app_select: boolean; app_update: boolean; app_delete: boolean }[]>`
      select t.table_name, r.kind, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             coalesce((select array_agg(p.polname) from pg_policy p where p.polrelid = c.oid), '{}') as policies,
             has_table_privilege('app_rw', c.oid, 'SELECT') as app_select,
             has_table_privilege('app_rw', c.oid, 'UPDATE') as app_update,
             has_table_privilege('app_rw', c.oid, 'DELETE') as app_delete
      from information_schema.columns t
      join pg_class c on c.relname = t.table_name and c.relkind = 'r'
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      left join table_registry r on r.table_name = t.table_name
      where t.table_schema = 'public' and t.column_name = 'workspace_id'`;
    expect(rows.length).toBeGreaterThan(40);
    const problems: string[] = [];
    for (const r of rows) {
      if (JUSTIFIED[r.table_name]) {
        if (r.app_select || r.app_update || r.app_delete) problems.push(`${r.table_name}: justified global table is readable/writable by app_rw`);
        continue;
      }
      const staffOnly = r.table_name === 'tenant_notes' || r.table_name === 'qa_reviews';
      if (r.kind !== 'tenant') problems.push(`${r.table_name}: has workspace_id but is registered ${r.kind ?? 'nowhere'}`);
      if (!r.rls || !r.forced) problems.push(`${r.table_name}: RLS not enabled + forced`);
      if (!staffOnly && !r.policies.includes('tenant_isolation')) problems.push(`${r.table_name}: no tenant_isolation policy`);
    }
    expect(problems).toEqual([]);
  });

  it('every tenant table has a workspace_id column', async () => {
    const missing = await ownerPool()`
      select r.table_name from table_registry r where r.kind = 'tenant' and not exists (
        select 1 from information_schema.columns c where c.table_name = r.table_name and c.column_name = 'workspace_id')`;
    expect(missing).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('queries without tenant context fail closed', async () => {
    await expect(globalTx((tx) => tx`select * from skus`)).rejects.toThrow(/tenant context not set/);
    await expect(appPool()`select * from workspaces`).rejects.toThrow(/tenant context not set/);
  });

  it('a tenant sees only its own rows', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await makeSku(a.workspaceId, 'A serum');
    await makeSku(b.workspaceId, 'B cream');
    const seenByA = await withTenant(a.workspaceId, (tx) => tx`select name from skus`);
    expect(seenByA.map((r) => r.name)).toEqual(['A serum']);
    const wsSeenByA = await withTenant(a.workspaceId, (tx) => tx`select id from workspaces`);
    expect(wsSeenByA.map((r) => r.id)).toEqual([a.workspaceId]);
  });

  it('a tenant cannot read, update or delete another tenant row by id', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const bSku = await makeSku(b.workspaceId);
    await withTenant(a.workspaceId, async (tx) => {
      expect(await tx`select * from skus where id = ${bSku}`).toHaveLength(0);
      const upd = await tx`update skus set name = 'pwned' where id = ${bSku}`;
      expect(upd.count).toBe(0);
      const del = await tx`delete from skus where id = ${bSku}`;
      expect(del.count).toBe(0);
    });
    const [row] = await ownerPool()`select name from skus where id = ${bSku}`;
    expect(row!.name).toBe('Serum No. 3');
  });

  it('a tenant cannot insert rows into another workspace', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await expect(
      withTenant(a.workspaceId, (tx) => tx`insert into skus (workspace_id, catalogue_no, name) values (${b.workspaceId}, 99, 'x')`),
    ).rejects.toThrow(/row-level security/);
  });

  it('composite foreign keys prevent cross-tenant references', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const bSku = await makeSku(b.workspaceId);
    // Even the owner (bypassing RLS) cannot link A's claim to B's SKU.
    await expect(
      ownerPool()`insert into claims (workspace_id, sku_id, canonical_meaning, preferred_wording, claim_category, risk_level, status, origin)
                  values (${a.workspaceId}, ${bSku}, 'm', 'w', 'c', 'low', 'VERIFIED', 'merchant')`,
    ).rejects.toThrow(/foreign key/);
  });

  it('ledger, events and consent records are append-only', async () => {
    const a = await makeTenant();
    await withTenant(a.workspaceId, async (tx) => {
      await tx`insert into ledger_entries (workspace_id, type, unit, amount, actor, idempotency_key)
               values (${a.workspaceId}, 'CREDIT_GRANTED', 'creative_test', 3, 'system:test', 'k1')`;
    });
    await expect(withTenant(a.workspaceId, (tx) => tx`update ledger_entries set amount = 999`)).rejects.toThrow(
      /permission denied|append-only/,
    );
    await expect(ownerPool()`delete from ledger_entries`).rejects.toThrow(/append-only/);
  });

  it('staff (admin_rw) and system (system_rw) can see across tenants', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await makeSku(a.workspaceId);
    await makeSku(b.workspaceId);
    expect(await withAdmin((tx) => tx`select id from skus`)).toHaveLength(2);
    expect(await withSystem((tx) => tx`select id from skus`)).toHaveLength(2);
  });

  it('staff-only tables are invisible to the app role', async () => {
    const a = await makeTenant();
    await withAdmin((tx) => tx`insert into tenant_notes (workspace_id, staff_id, body) values (${a.workspaceId}, ${newId()}, 'vip')`);
    await expect(withTenant(a.workspaceId, (tx) => tx`select * from tenant_notes`)).rejects.toThrow(/permission denied/);
  });

  it('billing customers, Shopify shops, slug history and email logs are tenant-scoped', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_a', ${a.workspaceId}), ('cus_b', ${b.workspaceId})`;
    await ownerPool()`insert into shopify_shops (shop_domain, workspace_id, integration_id) values ('a.myshopify.com', ${a.workspaceId}, ${newId()}), ('b.myshopify.com', ${b.workspaceId}, ${newId()})`;
    await ownerPool()`insert into email_log (workspace_id, to_email, template, stream, idempotency_key) values
                      (${a.workspaceId}, 'a@x.com', 'receipt', 'transactional', 'k-a'), (${b.workspaceId}, 'b@x.com', 'receipt', 'transactional', 'k-b'),
                      (null, 'c@x.com', 'magic_link', 'transactional', 'k-c')`;
    await withTenant(a.workspaceId, async (tx) => {
      // The billing page / portal read: only this workspace's customer, even without a filter.
      expect((await tx`select customer_id from stripe_customers`).map((r) => r.customer_id)).toEqual(['cus_a']);
      expect((await tx`select shop_domain from shopify_shops`).map((r) => r.shop_domain)).toEqual(['a.myshopify.com']);
      expect((await tx`select to_email from email_log`).map((r) => r.to_email)).toEqual(['a@x.com']);
      const [r] = await tx`select shop_connected_elsewhere('b.myshopify.com') as elsewhere, shop_connected_elsewhere('a.myshopify.com') as mine`;
      expect(r).toMatchObject({ elsewhere: true, mine: false });
    });
    // Log rows are written only through the email_log_* functions.
    await expect(withTenant(a.workspaceId, (tx) => tx`update email_log set status = 'x'`)).rejects.toThrow(/permission denied/);
    // Pre-tenant lookups only through the narrow functions.
    const [ws] = await globalTx((tx) => tx`select workspace_for_shop('b.myshopify.com') as w`);
    expect(ws!.w).toBe(b.workspaceId);
    await expect(globalTx((tx) => tx`select * from stripe_customers`)).rejects.toThrow();
    // Raw Stripe payloads are not readable by the app role at all.
    await expect(globalTx((tx) => tx`select * from stripe_events`)).rejects.toThrow(/permission denied/);
    const [ins] = await globalTx((tx) => tx`select stripe_event_receive('evt_rls', 't', '{}'::jsonb) as inserted`);
    const [dup] = await globalTx((tx) => tx`select stripe_event_receive('evt_rls', 't', '{}'::jsonb) as inserted`);
    expect([ins!.inserted, dup!.inserted]).toEqual([true, false]);
  });

  it('email log rows can only be opened for the tenant being acted for', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const [ok] = await withTenant(a.workspaceId, (tx) => tx`select * from email_log_open(${a.workspaceId}, 'x@y.com', 'receipt', 'transactional', 'k1')`);
    expect(ok!.outcome).toBe('opened');
    await expect(withTenant(a.workspaceId, (tx) => tx`select * from email_log_open(${b.workspaceId}, 'x@y.com', 'receipt', 'transactional', 'k2')`)).rejects.toThrow(/tenant context/);
    const [none] = await globalTx((tx) => tx`select * from email_log_open(null, 'x@y.com', 'magic_link', 'transactional', 'k3')`);
    expect(none!.outcome).toBe('opened');
  });

  it('membership resolution crosses the boundary only for the member', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const ok = await globalTx((tx) => tx`select * from resolve_membership(${a.userId}, ${a.slug})`);
    expect(ok).toHaveLength(1);
    const denied = await globalTx((tx) => tx`select * from resolve_membership(${a.userId}, ${b.slug})`);
    expect(denied).toHaveLength(0);
  });

  it('tenant context does not leak across pooled transactions', async () => {
    const a = await makeTenant();
    await withTenant(a.workspaceId, (tx) => tx`select 1`);
    // Same pool, new transaction, no context: must fail closed rather than reuse A.
    for (let i = 0; i < 5; i++) {
      await expect(globalTx((tx) => tx`select * from skus`)).rejects.toThrow();
    }
  });
});
