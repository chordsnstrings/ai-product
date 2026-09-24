-- 0107 · Admin console, growth and finance (plan 05 §1, §5–§8, §10): platform alerts, landing pages with a
-- published copy, pre-registered experiment metrics, offer experiments with guardrails and Stripe Price archiving,
-- dunning retry schedule, dispute evidence, nightly Stripe reconciliation, provider invoice reconciliation and the
-- provider registry. Staff/system-only tables follow the 0105 pattern (global, no app_rw access).

-- ───────────── §1 Platform alerts (Pulse queue) ─────────────
-- Raised by system sweeps and webhooks when they changed something on their own (an offer auto-paused, an
-- experiment auto-stopped, a gallery asset unpublished, Stripe drifting from our mirror). One open alert per
-- kind and subject; staff resolve them from Pulse.
create table platform_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  severity text not null default 'warn' check (severity in ('info','warn','risk')),
  subject_type text not null,
  subject_id text not null,
  message text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution text
);
create unique index platform_alerts_open on platform_alerts (kind, subject_type, subject_id) where resolved_at is null;
grant select, insert on platform_alerts to system_rw, admin_rw;
grant update (resolved_at, resolved_by, resolution) on platform_alerts to admin_rw;
insert into table_registry values ('platform_alerts', 'global');

-- ───────────── §5 Landing pages: draft vs published, pre-registered experiment ─────────────
-- `content`/`variants` are the working draft; `live_*` is what the public page renders, written only by publish,
-- rollback and the rights sweep, so a draft can be previewed and diffed before it goes live.
alter table landing_pages add column live_content jsonb;
alter table landing_pages add column live_variants jsonb not null default '[]';
alter table landing_pages add column live_version int;
-- Primary metric (upload-start % or Taste CVR) and the minimum sample per variant before any winner badge.
alter table landing_pages add column experiment jsonb not null default '{"primaryMetric": "upload_start", "minSample": 400}';
update landing_pages set live_content = content, live_variants = variants, live_version = version where status = 'live' or published_at is not null;
alter table landing_pages add constraint landing_pages_live_has_content check (status <> 'live' or live_content is not null);
-- The gallery rights sweep removes example assets whose rights expired (plan 05 §5 edge cases).
grant update (content, variants, live_content, live_variants, version, live_version, history, updated_at) on landing_pages to system_rw;

-- ───────────── §6 Offers: experiments, guardrails, archived Stripe Prices ─────────────
-- Stopped or replaced experiments keep their definition (and why they ended) for the results table.
alter table offer_definitions add column experiment_history jsonb not null default '[]';
-- Why the offer is paused when the system paused it (Stripe Price archived, guardrail).
alter table offer_definitions add column paused_reason text;
-- Set while the referenced Stripe Price is archived/deleted: the offer can't be reactivated with it.
alter table offer_definitions add column stripe_price_archived_at timestamptz;
create index offer_definitions_stripe_price on offer_definitions (stripe_price_id) where stripe_price_id is not null;
grant update (active, experiment, experiment_history, paused_reason, stripe_price_archived_at, updated_at) on offer_definitions to system_rw;
-- Which experiment an issued offer's variant belongs to (variant keys repeat across experiments).
alter table offers add column experiment_key text;
create index offers_experiment on offers (definition_code, experiment_key, variant) where experiment_key is not null;

-- ───────────── §7 Dunning: Stripe's retry schedule ─────────────
alter table subscriptions add column next_payment_attempt timestamptz;
alter table subscriptions add column payment_attempt_count int not null default 0;

-- ───────────── §7 Disputes: evidence pack submitted via Stripe ─────────────
alter table stripe_disputes add column evidence jsonb;
alter table stripe_disputes add column evidence_submitted_at timestamptz;
alter table stripe_disputes add column evidence_submitted_by uuid;

-- ───────────── §7 Nightly full Stripe reconciliation ─────────────
create table stripe_recon_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','completed','failed','skipped')),
  counts jsonb not null default '{}',
  error text
);
-- Differences between Stripe and our mirror. One open row per (kind, Stripe object); a run that no longer finds a
-- difference resolves it. workspace_id is informational (the matched tenant, when there is one).
create table stripe_recon_exceptions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references stripe_recon_runs(id),
  kind text not null,
  stripe_id text not null,
  workspace_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution text
);
create unique index stripe_recon_exceptions_open on stripe_recon_exceptions (kind, stripe_id) where resolved_at is null;
grant select, insert, update on stripe_recon_runs, stripe_recon_exceptions to system_rw;
grant select on stripe_recon_runs to admin_rw;
grant select on stripe_recon_exceptions to admin_rw;
grant update (resolved_at, resolved_by, resolution) on stripe_recon_exceptions to admin_rw;
insert into table_registry values ('stripe_recon_runs', 'global'), ('stripe_recon_exceptions', 'global');
-- FINANCE can run the reconciliation on demand; the worker executes it like other staff-requested operations.
alter table ops_commands drop constraint ops_commands_kind_check;
alter table ops_commands add constraint ops_commands_kind_check
  check (kind in ('job.retry', 'job.cancel', 'dlq.requeue', 'eval.run', 'integration.verify_webhooks', 'stripe.reconcile'));

-- ───────────── §8 Provider invoice reconciliation ─────────────
-- Monthly invoice CSV lines per provider × model; a re-import of the same month and model replaces it.
create table provider_invoice_lines (
  id bigserial primary key,
  provider text not null,
  period date not null check (extract(day from period) = 1),
  model text not null,
  quantity numeric,
  unit text,
  amount_micros bigint not null check (amount_micros >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  import_batch uuid not null,
  imported_by uuid not null,
  created_at timestamptz not null default now(),
  unique (provider, period, model)
);
grant select, insert, update, delete on provider_invoice_lines to admin_rw;
grant usage on sequence provider_invoice_lines_id_seq to admin_rw;
insert into table_registry values ('provider_invoice_lines', 'global');

-- ───────────── §10 Provider registry ─────────────
-- Per provider: status, secret names (never values; secrets live in the platform's secret store), region,
-- concurrency limit, per-request timeout and retry policy. The Model Gateway reads it on every call.
create table providers (
  name text primary key,
  display_name text not null,
  status text not null default 'active' check (status in ('active','degraded','disabled')),
  secret_names text[] not null default '{}',
  region text,
  concurrency_limit int not null default 8 check (concurrency_limit between 1 and 500),
  timeout_ms int not null default 180000 check (timeout_ms between 1000 and 3600000),
  retry_attempts int not null default 3 check (retry_attempts between 1 and 10),
  retry_backoff_ms int not null default 500 check (retry_backoff_ms between 0 and 60000),
  notes text,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into providers (name, display_name, secret_names, region, concurrency_limit, timeout_ms, retry_attempts, retry_backoff_ms) values
  ('anthropic', 'Anthropic (LLM)', '{ANTHROPIC_API_KEY}', 'us', 16, 600000, 3, 500),
  ('byteplus', 'BytePlus (Seedream, Seedance, Seed Speech fallback)', '{ARK_API_KEY,BYTEPLUS_SPEECH_APP_ID,BYTEPLUS_SPEECH_TOKEN}', 'ap-southeast-1', 8, 180000, 3, 500),
  ('minimax', 'MiniMax (TTS)', '{MINIMAX_API_KEY}', 'global', 8, 60000, 3, 500);
grant select on providers to app_rw, system_rw;
grant select, update on providers to admin_rw;
insert into table_registry values ('providers', 'global');
