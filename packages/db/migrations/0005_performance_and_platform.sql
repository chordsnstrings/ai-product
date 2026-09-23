-- 0005 · Integrations, performance, learning (Parts VII + V) and platform/admin tables (plan 05).

create table integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null check (provider in ('shopify','meta','tiktok')),
  external_account_id text not null,
  display_name text,
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active','degraded','revoked','paused','disconnected')),
  token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  last_success_at timestamptz,
  last_complete_date date,
  cursor jsonb not null default '{}',
  timezone text,
  currency text,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, external_account_id),
  unique (workspace_id, id)
);
create trigger integrations_touch before update on integrations for each row execute function arkiv_touch_updated_at();
select arkiv_tenant_table('integrations'); insert into table_registry values ('integrations','tenant');

-- One active workspace per Shopify shop (webhook routing must be unambiguous, plan 02 §3 layer 8).
create table shopify_shops (
  shop_domain text primary key,
  workspace_id uuid not null,
  integration_id uuid not null,
  created_at timestamptz not null default now()
);
grant select, insert, delete on shopify_shops to app_rw;
grant select, insert, update, delete on shopify_shops to admin_rw, system_rw;
insert into table_registry values ('shopify_shops','global');

create table performance_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  integration_id uuid,
  platform text not null check (platform in ('meta','tiktok','shopify','manual')),
  account_id text not null,
  campaign_id text, adgroup_id text, ad_id text not null,
  creative_id uuid, variant_id uuid,
  date date not null,
  currency text not null,
  spend_micros bigint not null default 0,
  impressions bigint not null default 0,
  reach bigint, frequency numeric,
  clicks bigint not null default 0,
  outbound_clicks bigint,
  video_starts bigint, video_25 bigint, video_50 bigint, video_75 bigint, video_100 bigint,
  avg_watch_ms int,
  add_to_cart bigint, checkout bigint,
  purchases bigint not null default 0,
  purchase_value_micros bigint not null default 0,
  attribution_model text,
  attribution_window text not null default 'default',
  optimization_event text,
  campaign_type text,
  measurement_context text not null check (measurement_context in ('META_PAID_ATTRIBUTED','TIKTOK_PAID_ATTRIBUTED',
    'TIKTOK_GMV_MAX_TOTAL','SHOPIFY_BLENDED_ORDER','MERCHANT_IMPORTED')),
  revision int not null default 1,
  superseded_at timestamptz,
  ingested_at timestamptz not null default now(),
  unique (workspace_id, platform, ad_id, date, measurement_context, attribution_window, revision)
);
create index on performance_observations (workspace_id, variant_id) where superseded_at is null;
select arkiv_tenant_table('performance_observations'); insert into table_registry values ('performance_observations','tenant');

create table confounders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid,
  kind text not null check (kind in ('stockout','site_outage','price_change','offer_change','influencer_event',
    'audience_change','bid_change','landing_change','viral_event','other')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  note text,
  source text not null check (source in ('merchant','automatic','staff')),
  created_by text not null,
  created_at timestamptz not null default now()
);
select arkiv_tenant_table('confounders'); insert into table_registry values ('confounders','tenant');

create table experiment_results (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  experiment_id uuid not null,
  variant_id uuid not null,
  measurement_context text not null,
  metric text not null,
  successes numeric not null,
  trials numeric not null,
  raw_rate numeric,
  posterior_mean numeric,
  ci_low numeric, ci_high numeric,
  prob_best numeric,
  state text not null,
  computed_at timestamptz not null default now(),
  unique (workspace_id, experiment_id, variant_id, measurement_context, metric)
);
select arkiv_tenant_table('experiment_results'); insert into table_registry values ('experiment_results','tenant');

create table learnings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  statement text not null,
  scope_platform text not null,
  scope_market text not null default 'US',
  measurement_context text not null,
  relevant_genes jsonb not null default '{}',
  supporting_experiments uuid[] not null default '{}',
  contradicting_experiments uuid[] not null default '{}',
  confidence numeric not null,
  state text not null check (state in ('GATHERING_SIGNAL','DIRECTIONAL','ACTIONABLE','WEAKENING','INVALIDATED')),
  valid_from timestamptz not null default now(),
  last_revalidated_at timestamptz not null default now(),
  do_not_generalize_to text[] not null default '{}',
  history jsonb not null default '[]',
  created_at timestamptz not null default now(),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade
);
select arkiv_tenant_table('learnings'); insert into table_registry values ('learnings','tenant');

create table risk_flags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  indicator text not null,
  evidence jsonb not null default '{}',
  raised_at timestamptz not null default now(),
  resolved_at timestamptz,
  suppressed_reason text,
  unique (workspace_id, indicator, raised_at)
);
select arkiv_tenant_table('risk_flags'); insert into table_registry values ('risk_flags','tenant');

-- Staff-only tenant tables (app gets no rows because it has no grant).
create table tenant_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  staff_id uuid not null,
  body text not null,
  created_at timestamptz not null default now()
);
alter table tenant_notes enable row level security; alter table tenant_notes force row level security;
create policy staff_access on tenant_notes to admin_rw using (true) with check (true);
grant select, insert, delete on tenant_notes to admin_rw;
insert into table_registry values ('tenant_notes','tenant');

-- Break-glass sessions are visible to the tenant in its access log (plan 05 §0.3).
create table break_glass_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  staff_id uuid not null,
  staff_name text not null,
  reason text not null,
  ticket text,
  write_access boolean not null default false,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);
select arkiv_tenant_table('break_glass_sessions', false); insert into table_registry values ('break_glass_sessions','tenant');

-- ───────────── Global platform tables ─────────────
create table staff_users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  name text not null,
  password_hash text not null,
  totp_secret_enc text,
  roles text[] not null default '{}',
  ip_allowlist cidr[],
  active boolean not null default true,
  roles_confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table staff_sessions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff_users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  reauth_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip inet, user_agent text,
  revoked_at timestamptz
);
create table admin_audit_log (
  id bigserial primary key,
  staff_id uuid,
  staff_roles text[],
  action text not null,
  target_type text,
  target_id text,
  workspace_id uuid,
  reason text,
  before jsonb, after jsonb,
  ip inet, user_agent text,
  at timestamptz not null default now()
);
create trigger audit_append_only before update or delete on admin_audit_log for each row execute function arkiv_forbid_mutation();
create table approvals (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  payload jsonb not null,
  required_role text not null,
  requested_by uuid not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','executed','failed')),
  decided_by uuid,
  decided_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);
grant select, insert, update on staff_users, staff_sessions, approvals to admin_rw;
grant select, insert on admin_audit_log to admin_rw;
grant usage on sequence admin_audit_log_id_seq to admin_rw;
insert into table_registry values ('staff_users','global'),('staff_sessions','global'),('admin_audit_log','global'),('approvals','global');

create table feature_flags (
  key text primary key,
  description text not null,
  owner text not null,
  kind text not null check (kind in ('boolean','percentage','workspace_allowlist','plan')),
  enabled boolean not null default false,
  rules jsonb not null default '{}',
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create table platform_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create table provider_rate_tables (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model text not null,
  version int not null,
  unit text not null,
  rates jsonb not null,
  currency text not null default 'USD',
  effective_from timestamptz not null,
  source_url text,
  notes text,
  status text not null default 'draft' check (status in ('draft','published','retired')),
  created_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  unique (provider, model, version)
);
create table model_routes (
  task text primary key,
  provider text not null,
  model text not null,
  prompt_version text not null,
  rollout_pct int not null default 100,
  canary jsonb,
  pinned_model_version text,
  circuit_open boolean not null default false,
  updated_at timestamptz not null default now()
);
create table offer_definitions (
  code text primary key,
  type text not null check (type in ('TASTE','STANDALONE','PLAN_UPGRADE','WIN_BACK')),
  price_micros bigint not null,
  reference_code text,
  window_minutes int,
  bonus jsonb not null default '{}',
  eligibility jsonb not null default '{}',
  experiment jsonb,
  active boolean not null default true,
  version int not null default 1,
  updated_at timestamptz not null default now()
);
create table landing_pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  archetype text not null,
  status text not null default 'draft' check (status in ('draft','live','paused')),
  content jsonb not null,
  variants jsonb not null default '[]',
  utm_match text[] not null default '{}',
  version int not null default 1,
  history jsonb not null default '[]',
  published_at timestamptz,
  updated_at timestamptz not null default now()
);
create table testimonials (
  id uuid primary key default gen_random_uuid(),
  quote text not null,
  person_name text not null,
  brand_name text,
  consent_document text not null,
  consent_given_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table taxonomy_versions (
  version int primary key,
  spec jsonb not null,
  created_at timestamptz not null default now()
);
grant select on feature_flags, platform_settings, provider_rate_tables, model_routes, offer_definitions, landing_pages,
  testimonials, taxonomy_versions to app_rw, system_rw;
grant select, insert, update, delete on feature_flags, platform_settings, provider_rate_tables, model_routes,
  offer_definitions, landing_pages, testimonials, taxonomy_versions to admin_rw;
insert into table_registry values ('feature_flags','global'),('platform_settings','global'),('provider_rate_tables','global'),
  ('model_routes','global'),('offer_definitions','global'),('landing_pages','global'),('testimonials','global'),('taxonomy_versions','global');

-- Funnel events recorded server-side (plan 04 §1); visitor_id is a random first-party cookie.
create table funnel_events (
  id bigserial primary key,
  type text not null,
  visitor_id text,
  workspace_id uuid,
  page text,
  variant text,
  utm jsonb,
  props jsonb not null default '{}',
  at timestamptz not null default now()
);
create index on funnel_events (type, at);
grant insert on funnel_events to app_rw, system_rw;
grant usage on sequence funnel_events_id_seq to app_rw, system_rw;
grant select on funnel_events to admin_rw;
insert into table_registry values ('funnel_events','global');

create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);
grant select, insert, update, delete on rate_limits to app_rw, admin_rw, system_rw;
insert into table_registry values ('rate_limits','global');

create table abuse_signals (
  id bigserial primary key,
  kind text not null,
  key text not null,
  workspace_id uuid,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
grant insert on abuse_signals to app_rw, system_rw;
grant usage on sequence abuse_signals_id_seq to app_rw, system_rw;
grant select on abuse_signals to admin_rw;
insert into table_registry values ('abuse_signals','global');

create table email_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  to_email citext not null,
  template text not null,
  stream text not null check (stream in ('transactional','marketing')),
  idempotency_key text not null unique,
  provider_id text,
  status text not null default 'queued',
  events jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create table email_suppressions (
  email citext primary key,
  reason text not null,
  stream text not null default 'all',
  created_at timestamptz not null default now()
);
grant select, insert, update on email_log, email_suppressions to app_rw, system_rw, admin_rw;
grant delete on email_suppressions to admin_rw;
insert into table_registry values ('email_log','global'),('email_suppressions','global');

create table data_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  kind text not null check (kind in ('export','delete_workspace','delete_user','delete_person_data')),
  requester_email citext not null,
  status text not null default 'open' check (status in ('open','in_progress','completed','rejected')),
  due_at timestamptz not null,
  notes text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create table purge_certificates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  counts jsonb not null,
  objects_deleted int not null,
  undeletable jsonb not null default '[]',
  completed_at timestamptz not null default now()
);
grant select, insert, update on data_requests to admin_rw, system_rw;
grant insert on data_requests to app_rw;
grant select, insert on purge_certificates to admin_rw, system_rw;
insert into table_registry values ('data_requests','global'),('purge_certificates','global');

-- Every table in public must be registered (checked in CI too).
create or replace function arkiv_unregistered_tables() returns setof text language sql stable as $$
  select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname not in ('schema_migrations', 'table_registry')
    and c.relname not in (select table_name from table_registry)
$$;
