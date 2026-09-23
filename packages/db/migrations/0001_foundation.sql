-- 0001 · Roles, tenancy primitives and RLS helpers (plan 02 §3).
-- Roles are cluster-level and may already exist; passwords are set out-of-band (dev: cli.ts, prod: bootstrap).

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_rw') then create role app_rw login; end if;
  if not exists (select 1 from pg_roles where rolname = 'admin_rw') then create role admin_rw login; end if;
  if not exists (select 1 from pg_roles where rolname = 'system_rw') then create role system_rw login; end if;
end $$;

create extension if not exists citext;
create extension if not exists pgcrypto;

grant usage on schema public to app_rw, admin_rw, system_rw;

-- Current tenant. Throws (fails closed) when no tenant context was set in this transaction.
create or replace function arkiv_current_workspace() returns uuid
language plpgsql stable as $$
declare v text := current_setting('app.workspace_id', true);
begin
  if v is null or v = '' then
    raise exception 'tenant context not set' using errcode = 'insufficient_privilege';
  end if;
  return v::uuid;
end $$;

-- Turn a table into a tenant table: RLS enabled + forced; app_rw sees only its workspace;
-- admin_rw (staff console, audited in app) and system_rw (dispatcher, sweeps, purge) see all.
create or replace function arkiv_tenant_table(t regclass, app_writes boolean default true, append_only boolean default false)
returns void language plpgsql as $$
begin
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant_isolation on %s to app_rw using (workspace_id = arkiv_current_workspace()) with check (workspace_id = arkiv_current_workspace())', t);
  execute format('create policy staff_access on %s to admin_rw using (true) with check (true)', t);
  execute format('create policy system_access on %s to system_rw using (true) with check (true)', t);
  -- FORCE RLS also binds the table owner. On managed Postgres the owner is not a superuser, and the
  -- SECURITY DEFINER lookup functions run as the owner, so the owner gets its own explicit policy.
  execute format('create policy owner_access on %s to %I using (true) with check (true)', t, current_user);
  if append_only then
    execute format('grant select, insert on %s to app_rw, system_rw', t);
    execute format('grant select, insert on %s to admin_rw', t);
  elsif app_writes then
    execute format('grant select, insert, update, delete on %s to app_rw, admin_rw, system_rw', t);
  else
    execute format('grant select on %s to app_rw', t);
    execute format('grant select, insert, update, delete on %s to admin_rw, system_rw', t);
  end if;
end $$;

-- Registry used by the CI coverage test: every table must be declared tenant or global.
create table table_registry (
  table_name text primary key,
  kind text not null check (kind in ('tenant', 'global'))
);
grant select on table_registry to app_rw, admin_rw, system_rw;

create or replace function arkiv_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- Append-only guard for ledger/event/audit tables even against owner mistakes.
create or replace function arkiv_forbid_mutation() returns trigger language plpgsql as $$
begin raise exception '% is append-only', tg_table_name; end $$;
