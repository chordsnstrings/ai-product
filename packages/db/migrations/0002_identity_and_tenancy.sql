-- 0002 · Identity (global) and tenancy (plan 02 §1–2, §5).

-- ───────────── Global identity ─────────────
create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  name text,
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  locked_at timestamptz,
  locked_reason text
);

create table user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('email', 'google', 'apple')),
  provider_subject text not null,
  email citext,
  created_at timestamptz not null default now(),
  unique (provider, provider_subject)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip inet,
  user_agent text,
  revoked_at timestamptz,
  last_workspace_id uuid
);
create index on sessions (user_id);

create table magic_links (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  token_hash text not null unique,
  purpose text not null check (purpose in ('login', 'claim', 'resume', 'step_up')),
  provisional_workspace_id uuid,
  redirect_to text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_ip inet,
  created_at timestamptz not null default now()
);
create index on magic_links (email, created_at);

create table passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  credential_id text not null unique,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[],
  name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table oauth_states (
  state text primary key,
  provider text not null,
  code_verifier text,
  nonce text,
  redirect_to text,
  provisional_workspace_id uuid,
  expires_at timestamptz not null
);

grant select, insert, update, delete on users, user_identities, sessions, magic_links, passkeys, oauth_states to app_rw, admin_rw, system_rw;
insert into table_registry values ('users','global'),('user_identities','global'),('sessions','global'),
  ('magic_links','global'),('passkeys','global'),('oauth_states','global');

-- ───────────── Tenancy ─────────────
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid generated always as (id) stored,   -- uniform RLS column
  slug text not null unique,
  name text not null,
  state text not null default 'ACTIVE_FREE' check (state in
    ('PROVISIONAL','ACTIVE_FREE','ACTIVE_PAID','PAST_DUE','CANCELLED','PURGE_SCHEDULED','PURGED','SUSPENDED','LOCKED')),
  state_before_hold text,           -- restored when SUSPENDED/LOCKED is lifted
  state_reason text,
  plan_code text check (plan_code in ('LAUNCH','GROWTH','SCALE')),
  provisional_token_hash text unique,
  provisional_expires_at timestamptz,
  stripe_customer_id text unique,
  timezone text not null default 'America/New_York',
  reporting_currency text not null default 'USD',
  is_test boolean not null default false,
  is_vip boolean not null default false,
  tags text[] not null default '{}',
  membership_version int not null default 1,
  purge_at timestamptz,
  cancelled_at timestamptz,
  next_catalogue_no int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger workspaces_touch before update on workspaces for each row execute function arkiv_touch_updated_at();
select arkiv_tenant_table('workspaces');
insert into table_registry values ('workspaces','tenant');

-- Slugs are globally reserved for 90 days after rename (plan 02 M12).
create table workspace_slug_history (
  slug text primary key,
  workspace_id uuid not null,
  reserved_until timestamptz not null
);
grant select, insert, delete on workspace_slug_history to app_rw, admin_rw, system_rw;
insert into table_registry values ('workspace_slug_history','global');

create table memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('OWNER','ADMIN','MEMBER','VIEWER')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on memberships (user_id);
select arkiv_tenant_table('memberships');
insert into table_registry values ('memberships','tenant');

create table invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email citext not null,
  role text not null check (role in ('ADMIN','MEMBER','VIEWER')),
  token_hash text not null unique,
  invited_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
select arkiv_tenant_table('invites');
insert into table_registry values ('invites','tenant');

-- Narrow SECURITY DEFINER lookups: the only way to cross the tenant boundary before a context exists.
create or replace function resolve_membership(p_user uuid, p_slug text)
returns table (workspace_id uuid, slug text, name text, state text, role text, membership_version int, plan_code text)
language sql stable security definer set search_path = public as $$
  select w.id, w.slug, w.name, w.state, m.role, w.membership_version, w.plan_code
  from workspaces w join memberships m on m.workspace_id = w.id
  where m.user_id = p_user and w.slug = p_slug and w.state <> 'PURGED'
$$;

create or replace function list_user_workspaces(p_user uuid)
returns table (workspace_id uuid, slug text, name text, state text, role text, plan_code text)
language sql stable security definer set search_path = public as $$
  select w.id, w.slug, w.name, w.state, m.role, w.plan_code
  from workspaces w join memberships m on m.workspace_id = w.id
  where m.user_id = p_user and w.state not in ('PURGED')
  order by w.created_at
$$;

create or replace function resolve_provisional(p_token_hash text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from workspaces where provisional_token_hash = p_token_hash and state = 'PROVISIONAL'
    and provisional_expires_at > now()
$$;

create or replace function find_invite(p_token_hash text)
returns table (invite_id uuid, workspace_id uuid, email citext, role text, expires_at timestamptz,
               accepted_at timestamptz, revoked_at timestamptz, workspace_name text)
language sql stable security definer set search_path = public as $$
  select i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, w.name
  from invites i join workspaces w on w.id = i.workspace_id where i.token_hash = p_token_hash
$$;

create or replace function slug_taken(p_slug text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspaces where slug = p_slug)
      or exists (select 1 from workspace_slug_history where slug = p_slug and reserved_until > now())
$$;

revoke all on function resolve_membership, list_user_workspaces, resolve_provisional, find_invite, slug_taken from public;
grant execute on function resolve_membership, list_user_workspaces, resolve_provisional, find_invite, slug_taken to app_rw;

-- ───────────── Events (append-only, §36) ─────────────
create table events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  type text not null,
  actor text not null,
  subject_type text,
  subject_id uuid,
  payload jsonb not null default '{}',
  schema_version int not null default 1,
  at timestamptz not null default now()
);
create index on events (workspace_id, at desc);
create index on events (workspace_id, subject_id);
create trigger events_append_only before update or delete on events for each row execute function arkiv_forbid_mutation();
select arkiv_tenant_table('events', true, true);
insert into table_registry values ('events','tenant');

-- ───────────── Idempotency (§39) ─────────────
create table idempotency_keys (
  workspace_id uuid not null,
  operation text not null,
  key text not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, operation, key)
);
select arkiv_tenant_table('idempotency_keys');
insert into table_registry values ('idempotency_keys','tenant');

-- ───────────── Outbox → job queue (transactional enqueue) ─────────────
create table outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  queue text not null,
  payload jsonb not null,
  singleton_key text,
  run_after timestamptz not null default now(),
  priority int not null default 0,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz
);
create index outbox_pending on outbox (created_at) where dispatched_at is null;
select arkiv_tenant_table('outbox');
insert into table_registry values ('outbox','tenant');

create or replace function outbox_notify() returns trigger language plpgsql as $$
begin perform pg_notify('outbox', new.queue); return new; end $$;
create trigger outbox_notify after insert on outbox for each row execute function outbox_notify();

-- Per-workspace concurrency leases (plan 02 §3 layer 5 fairness).
create table workspace_leases (
  workspace_id uuid not null,
  resource text not null,
  holder text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (workspace_id, resource, holder)
);
select arkiv_tenant_table('workspace_leases');
insert into table_registry values ('workspace_leases','tenant');

-- Progress steps shown in the production ledger (plan 03 P9) — only real server events.
create table progress_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  subject_id uuid not null,
  step_key text not null,
  label text not null,
  status text not null check (status in ('pending','active','done','failed','skipped')),
  detail text,
  started_at timestamptz,
  completed_at timestamptz,
  position int not null default 0,
  unique (workspace_id, subject_id, step_key)
);
select arkiv_tenant_table('progress_steps');
insert into table_registry values ('progress_steps','tenant');
