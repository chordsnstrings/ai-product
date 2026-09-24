-- 0103 · Admin console, second pass (plan 05): staff factors and network policy, break-glass reasons, saved
-- views, and funnel attribution that survives a preview being merged into an existing account. Each block
-- names the plan section it serves. New staff tables follow the staff_users pattern: global, admin_rw only.

-- ───────────── Funnel attribution (plan 04 §1, plan 05 §4) ─────────────
-- The visitor whose free preview created a SKU. Later funnel stages (storyboard, checkout, payment, export)
-- carry it, so moving the SKU into an existing account (moveProvisionalSkus) keeps its first-touch slice.
alter table skus add column origin_visitor_id text;

-- ───────────── §0.1 Staff identity: passkeys (WebAuthn) ─────────────
-- A passkey is a second factor at sign-in and the 🔐 re-authentication tap. "Require passkey" (§23) makes it
-- the only accepted second factor for that staff member.
alter table staff_users add column require_passkey boolean not null default false;

create table staff_passkeys (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff_users(id) on delete cascade,
  credential_id text not null unique,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[],
  name text not null default 'Passkey',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index staff_passkeys_staff on staff_passkeys (staff_id);
grant select, insert, update, delete on staff_passkeys to admin_rw;
insert into table_registry values ('staff_passkeys', 'global');

-- Single-use WebAuthn challenges for the console (registration, sign-in, re-auth); expire after 5 minutes.
create table staff_webauthn_challenges (
  key text primary key,
  staff_id uuid not null references staff_users(id) on delete cascade,
  purpose text not null check (purpose in ('register', 'login', 'reauth')),
  challenge text not null,
  expires_at timestamptz not null
);
grant select, insert, update, delete on staff_webauthn_challenges to admin_rw;
insert into table_registry values ('staff_webauthn_challenges', 'global');

-- ───────────── §0.1 IP allowlist per staff role ─────────────
-- On by default for FINANCE and SUPER_ADMIN. A policy is enforced once it lists at least one network (an
-- enabled policy with no networks would lock the founders out of a fresh deployment); the Staff page flags
-- enabled-but-empty policies. Enforced at sign-in and on every request; an unknown client IP is refused.
create table staff_role_ip_policies (
  role text primary key check (role in ('SUPER_ADMIN','OPS','SUPPORT','FINANCE','COMPLIANCE','GROWTH','ENGINEERING','ANALYST')),
  enabled boolean not null default false,
  cidrs cidr[] not null default '{}',
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into staff_role_ip_policies (role, enabled) values
  ('SUPER_ADMIN', true), ('FINANCE', true), ('OPS', false), ('SUPPORT', false),
  ('COMPLIANCE', false), ('GROWTH', false), ('ENGINEERING', false), ('ANALYST', false);
grant select, insert, update on staff_role_ip_policies to admin_rw;
insert into table_registry values ('staff_role_ip_policies', 'global');

-- ───────────── §0.3 Break-glass: reason category ─────────────
-- "Choose a reason (support ticket #, incident #, compliance review) and write free text." Older sessions keep
-- a null category.
alter table break_glass_sessions add column reason_kind text check (reason_kind in ('ticket', 'incident', 'compliance_review'));

-- ───────────── §2.1 Saved views per staff member ─────────────
create table staff_saved_views (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff_users(id) on delete cascade,
  module text not null check (module in ('tenants')),
  name text not null check (length(name) between 1 and 60),
  query jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (staff_id, module, name)
);
grant select, insert, update, delete on staff_saved_views to admin_rw;
insert into table_registry values ('staff_saved_views', 'global');
