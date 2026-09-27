-- 0004 · Offers, purchases, subscriptions, consent, cost authorizations, usage ledger, provider jobs.

create table offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  definition_code text not null,
  type text not null check (type in ('TASTE','STANDALONE','PLAN_UPGRADE','WIN_BACK')),
  project_id uuid,
  price_micros bigint not null,
  reference_price_micros bigint,
  starts_at timestamptz not null,
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active','expired','redeemed','superseded')),
  bonus jsonb not null default '{}',
  variant text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);
-- A TASTE offer is issued at most once per workspace, ever (standard §5: expired offers are never reissued).
create unique index offers_taste_once on offers (workspace_id) where type = 'TASTE';
select arkiv_tenant_table('offers'); insert into table_registry values ('offers','tenant');

create table purchases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('taste','standalone')),
  offer_id uuid,
  project_id uuid,
  amount_micros bigint not null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  status text not null default 'pending' check (status in ('pending','paid','refunded','failed','expired')),
  created_by text not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  unique (workspace_id, id)
);
select arkiv_tenant_table('purchases'); insert into table_registry values ('purchases','tenant');

create table consent_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid,
  kind text not null check (kind in ('auto_renew','rights_attestation','terms')),
  text_version text not null,
  text_snapshot text not null,
  context jsonb not null default '{}',
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);
create trigger consent_append_only before update or delete on consent_records for each row execute function arkiv_forbid_mutation();
select arkiv_tenant_table('consent_records', true, true); insert into table_registry values ('consent_records','tenant');

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  stripe_subscription_id text unique,
  plan_code text not null check (plan_code in ('LAUNCH','GROWTH','SCALE')),
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  pending_plan_code text,
  consent_record_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscriptions_touch before update on subscriptions for each row execute function arkiv_touch_updated_at();
select arkiv_tenant_table('subscriptions'); insert into table_registry values ('subscriptions','tenant');

-- Cost Governor authorizations (§37). Model Gateway refuses any billable call without an active one.
create table cost_authorizations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid,
  purpose text not null,
  token_hash text not null unique,
  idempotency_key text not null,
  rate_table_versions jsonb not null,
  estimate jsonb not null,
  max_cost_micros bigint not null,
  spent_micros bigint not null default 0,
  entitlement_unit text,
  entitlement_amount int not null default 0,
  status text not null default 'active' check (status in ('active','settled','released','expired','refunded')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key)
);
select arkiv_tenant_table('cost_authorizations'); insert into table_registry values ('cost_authorizations','tenant');

-- Usage ledger (§37): immutable. Balances are always derived, never stored.
create table ledger_entries (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  type text not null check (type in ('CREDIT_GRANTED','CREDIT_RESERVED','CREDIT_CONSUMED','CREDIT_RELEASED','CREDIT_REFUNDED',
    'CREDIT_EXPIRED','CREDIT_ADJUSTED','FREE_QA_RETRY','PROVIDER_COST_RECORDED')),
  unit text not null check (unit in ('creative_test','taste','standalone','usd_micros')),
  amount bigint not null,
  authorization_id uuid,
  project_id uuid,
  provider_job_id uuid,
  period_key text,
  reference text,
  reason text,
  actor text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
create index on ledger_entries (workspace_id, unit, created_at);
create trigger ledger_append_only before update or delete on ledger_entries for each row execute function arkiv_forbid_mutation();
select arkiv_tenant_table('ledger_entries', true, true); insert into table_registry values ('ledger_entries','tenant');
grant usage on sequence ledger_entries_id_seq to app_rw, admin_rw, system_rw;

create table provider_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid,
  subject_type text,
  subject_id uuid,
  provider text not null,
  task text not null,
  model text not null,
  model_version_returned text,
  prompt_version text,
  request_hash text not null,
  input_refs jsonb not null default '{}',
  provider_request_id text,
  status text not null default 'created' check (status in ('created','dispatched','succeeded','failed','cancelled')),
  authorization_id uuid,
  estimate_micros bigint not null default 0,
  actual_micros bigint,
  latency_ms int,
  error text,
  output_asset_id uuid,
  output jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, id)
);
create unique index provider_jobs_request on provider_jobs (provider, provider_request_id) where provider_request_id is not null;
select arkiv_tenant_table('provider_jobs'); insert into table_registry values ('provider_jobs','tenant');

-- Stripe customer → workspace routing (global, plan 02 §3 layer 8).
create table stripe_customers (
  customer_id text primary key,
  workspace_id uuid not null unique,
  created_at timestamptz not null default now()
);
grant select, insert on stripe_customers to app_rw;
grant select, insert, update, delete on stripe_customers to admin_rw, system_rw;
insert into table_registry values ('stripe_customers','global');

-- Raw Stripe events: dedupe by event id, async processing, unmatched queue (plan 02 B1–B3).
create table stripe_events (
  id text primary key,
  type text not null,
  payload jsonb not null,
  workspace_id uuid,
  status text not null default 'received' check (status in ('received','processed','unmatched','ignored','failed')),
  attempts int not null default 0,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
grant select, insert on stripe_events to app_rw;
grant select, insert, update on stripe_events to admin_rw, system_rw;
insert into table_registry values ('stripe_events','global');
