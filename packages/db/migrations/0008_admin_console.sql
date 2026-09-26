-- 0008 · Admin console support tables (plan 05). All are staff-only: the customer app role gets no grant.

-- Queue operations requested by staff and executed by the worker (which owns pg-boss). Keeps the admin DB
-- role free of queue-write privileges and gives every retry/cancel an auditable record (plan 05 §12).
create table ops_commands (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('job.retry', 'job.cancel', 'dlq.requeue', 'eval.run', 'integration.verify_webhooks')),
  payload jsonb not null,
  requested_by uuid not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  executed_at timestamptz
);
create index ops_commands_pending on ops_commands (created_at) where status = 'pending';
grant select, insert on ops_commands to admin_rw;
grant select, update on ops_commands to system_rw;
insert into table_registry values ('ops_commands', 'global');

-- Allowlist for the multi-SKU / provisional-farm heuristics (plan 05 §15 edge case): time-boxed, with a reason.
create table abuse_allowlist (
  key text primary key,
  reason text not null,
  until timestamptz not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on abuse_allowlist to admin_rw;
grant select on abuse_allowlist to app_rw, system_rw;
insert into table_registry values ('abuse_allowlist', 'global');

-- Human QA verdicts (plan 05 §13): calibrate automated checks; never copied into golden sets without consent.
create table qa_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  staff_id uuid not null,
  verdicts jsonb not null,           -- { checkName: 'agree' | 'disagree' }
  failure_label text,
  notes text,
  created_at timestamptz not null default now()
);
alter table qa_reviews enable row level security; alter table qa_reviews force row level security;
create policy staff_access on qa_reviews to admin_rw using (true) with check (true);
do $$ begin execute format('create policy owner_access on qa_reviews to %I using (true) with check (true)', current_user); end $$;
grant select, insert on qa_reviews to admin_rw;
insert into table_registry values ('qa_reviews', 'tenant');

-- Rights / takedown cases (plan 05 §15).
create table rights_cases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  asset_id uuid,
  complainant text not null,
  detail text not null,
  status text not null default 'open' check (status in ('open', 'frozen', 'resolved_kept', 'resolved_removed')),
  resolution text,
  created_by uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
grant select, insert, update on rights_cases to admin_rw;
insert into table_registry values ('rights_cases', 'global');

-- Evaluation runs over golden datasets (plan 05 §11).
create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  task text not null,
  prompt_version text not null,
  model text not null,
  dataset text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'passed', 'failed', 'error')),
  cases int not null default 0,
  score numeric,
  results jsonb not null default '[]',
  cost_micros bigint not null default 0,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
grant select, insert on eval_runs to admin_rw;
grant select, update on eval_runs to system_rw;
insert into table_registry values ('eval_runs', 'global');

-- Staff need to read platform-wide metadata that the worker/billing layer writes.
grant update on data_requests to admin_rw;
grant update on testimonials to admin_rw;
