-- 0124 · Staff invites and access reviews (plan 05 §23), acquisition metrics (standard §7), subscriber price
-- changes (plan 04 §3), provider job moderation/usage (standard §41). New tables: RLS enabled + forced, one explicit
-- policy per role that may touch them (and the owner, whose SECURITY DEFINER functions run under FORCE RLS).

-- ───────────── §23 Staff invites ─────────────
-- A SUPER_ADMIN invites by email: the invitee opens a single-use link (48 hours), sets their own password and
-- enrols their authenticator. The inviter never knows either factor. The staff row exists from the invite (inactive,
-- no usable password) so the requested roles can go through four-eyes approval meanwhile.
create table staff_invites (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff_users(id) on delete cascade,
  email citext not null,
  token_hash text not null unique,
  -- The authenticator secret shown to the invitee on the invite page, confirmed by a code before it is kept.
  totp_secret text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz
);
create unique index staff_invites_open on staff_invites (staff_id) where accepted_at is null and revoked_at is null;
alter table staff_invites enable row level security; alter table staff_invites force row level security;
create policy staff_access on staff_invites to admin_rw using (true) with check (true);
do $$ begin execute format('create policy owner_access on staff_invites to %I using (true) with check (true)', current_user); end $$;
grant select, insert, update on staff_invites to admin_rw;
insert into table_registry values ('staff_invites', 'global');

-- §23 quarterly access review: roles not re-confirmed within 14 days of the review falling due are removed by a
-- system sweep, which also ends the member's sessions. Only the columns it needs.
grant select (roles_confirmed_at) on staff_users to system_rw;
grant update (roles) on staff_users to system_rw;
grant select (id, staff_id, revoked_at), update (revoked_at) on staff_sessions to system_rw;

-- ───────────── Standard §7 acquisition metrics ─────────────
-- Ad impression (CPM, creative ID, campaign) and click (CTR, CPC) from the same Ads Manager export as spend.
alter table ad_spend add column impressions bigint check (impressions >= 0);
alter table ad_spend add column clicks bigint check (clicks >= 0);

-- ───────────── Plan 04 §3 subscriber price changes ─────────────
-- Plan prices are versioned: the constants in packages/shared plans.ts are the fallback until a version exists.
-- A new version takes effect no sooner than 30 days after it is scheduled; each affected subscriber is told
-- (price_change_notices) and moves to it at their first renewal on or after the effective date.
create table plan_prices (
  id uuid primary key default gen_random_uuid(),
  plan_code text not null check (plan_code in ('LAUNCH', 'GROWTH', 'SCALE')),
  price_micros bigint not null check (price_micros > 0),
  stripe_price_id text,
  effective_from timestamptz not null,
  reason text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (plan_code, effective_from)
);
alter table plan_prices enable row level security; alter table plan_prices force row level security;
create policy app_read on plan_prices for select to app_rw using (true);
create policy staff_access on plan_prices to admin_rw using (true) with check (true);
create policy system_read on plan_prices for select to system_rw using (true);
do $$ begin execute format('create policy owner_access on plan_prices to %I using (true) with check (true)', current_user); end $$;
grant select on plan_prices to app_rw, system_rw;
grant select, insert on plan_prices to admin_rw;
insert into table_registry values ('plan_prices', 'global');

create table price_change_notices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  subscription_id uuid not null,
  plan_price_id uuid not null references plan_prices(id),
  plan_code text not null,
  old_price_micros bigint not null,
  new_price_micros bigint not null,
  effective_from timestamptz not null,
  notified_at timestamptz not null default now(),
  -- Set when the subscription's Stripe price was switched (at its first renewal on/after effective_from).
  applied_at timestamptz,
  unique (subscription_id, plan_price_id)
);
create index price_change_notices_due on price_change_notices (effective_from) where applied_at is null;
select arkiv_tenant_table('price_change_notices', false);
insert into table_registry values ('price_change_notices', 'tenant');

-- ───────────── Standard §41 provider job records ─────────────
-- Moderation outcome (a safety filter declined the request) and the provider's usage report (tokens, seconds,
-- characters, images), so the console reads them instead of guessing from error text.
alter table provider_jobs add column moderation_status text check (moderation_status in ('passed', 'rejected'));
alter table provider_jobs add column usage jsonb;
-- Which provider job produced a scene version (render or frame), and what it cost.
alter table scene_versions add column provider_job_id uuid;
