-- 0101 · Admin console corrections (plan 05). Each block names the plan section it serves.

-- §21 Data requests: the console offers access requests and reviewer-data removal. The old
-- 'delete_person_data' kind had no writer; existing rows move to the name the console uses.
alter table data_requests drop constraint data_requests_kind_check;
update data_requests set kind = 'delete_person_in_reviews' where kind = 'delete_person_data';
alter table data_requests add constraint data_requests_kind_check
  check (kind in ('access','export','delete_workspace','delete_user','delete_person_in_reviews'));

-- §17 Churn risk: one canonical indicator vocabulary (shared RiskIndicator enum) and suppressions that
-- survive the daily recomputation until they expire.
update risk_flags set indicator = case indicator
    when 'no_activity_7d' then 'idle_7d'
    when 'repeated_qa_rejection' then 'repeated_qa_rejects'
    when 'recommendations_ignored' then 'ignored_recommendations'
    when 'product_out_of_stock' then 'stockout'
    when 'no_performance_linked_test_30d' then 'no_performance_linked_test'
    else indicator end;
alter table risk_flags add column suppressed_until timestamptz;
create index risk_flags_open on risk_flags (workspace_id, indicator) where resolved_at is null;
-- Negative support sentiment is recorded by staff on tenant notes.
alter table tenant_notes add column sentiment text check (sentiment in ('positive','neutral','negative'));

-- §2.2 Danger zone: cancelling a purge restores the state the workspace was in before it was scheduled.
alter table workspaces add column state_before_purge text check (state_before_purge in
  ('PROVISIONAL','ACTIVE_FREE','ACTIVE_PAID','PAST_DUE','CANCELLED'));

-- §2.3 Suspension: jobs are paused, not dropped. A job that reaches a worker while its workspace is held
-- (SUSPENDED, or PURGE_SCHEDULED until the purge is cancelled) is parked here and re-enqueued through the
-- outbox when the hold ends. Deliveries (emails announcing finished work) are parked the same way.
create table held_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  queue text not null,
  payload jsonb not null,
  original_job_id text,
  reason text not null,
  held_at timestamptz not null default now(),
  released_at timestamptz
);
create index held_jobs_pending on held_jobs (workspace_id) where released_at is null;
create unique index held_jobs_once on held_jobs (workspace_id, original_job_id) where original_job_id is not null;
select arkiv_tenant_table('held_jobs'); insert into table_registry values ('held_jobs','tenant');

-- §6 Offer definitions: Stripe Price, currency (USD only in V1) and the next-eligible-offer policy.
alter table offer_definitions
  add column stripe_price_id text,
  add column currency text not null default 'USD' check (currency = 'USD'),
  add column next_offer_policy jsonb not null default '{}',
  add column created_at timestamptz not null default now();

-- §7 Refund tool: partial refunds are tracked per purchase; every refund (console or Stripe-initiated) has a
-- mirror row keyed by an idempotency key, written in the same transaction as its CREDIT_REFUNDED entry.
alter table purchases add column refunded_micros bigint not null default 0;
create table refunds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  purchase_id uuid,
  invoice_id text,
  payment_intent_id text not null,
  stripe_refund_id text,
  amount_micros bigint not null check (amount_micros > 0),
  reason_code text not null check (reason_code in
    ('requested_by_customer','duplicate','service_failure','goodwill','fraudulent','other')),
  customer_note text,
  idempotency_key text not null,
  status text not null default 'pending' check (status in ('pending','succeeded','failed')),
  requested_by uuid,
  approved_by uuid,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, idempotency_key)
);
create unique index refunds_stripe_id on refunds (stripe_refund_id) where stripe_refund_id is not null;
create index refunds_payment on refunds (workspace_id, payment_intent_id);
select arkiv_tenant_table('refunds'); insert into table_registry values ('refunds','tenant');

-- §11 Canary rollout: which arm of a route served each provider call, so canary and stable can be compared.
alter table provider_jobs add column arm text check (arm in ('stable','canary'));
create index provider_jobs_task_arm on provider_jobs (task, arm, created_at);

-- System sweeps that act on platform config: automatic canary rollback (§11), lazy retirement of superseded
-- rate tables (§9), flag-expiry alerts (§20). Their actions are audited without a staff id. Staff identity is
-- limited to the columns needed to address an alert (never password or TOTP material).
grant update on model_routes to system_rw;
grant update on provider_rate_tables to system_rw;
grant insert on admin_audit_log to system_rw;
grant usage on sequence admin_audit_log_id_seq to system_rw;
grant select (id, email, name, roles, active) on staff_users to system_rw;

-- §20 Kill switches: one per provider.
insert into feature_flags (key, description, owner, kind, enabled) values
  ('kill.provider.anthropic', 'Kill switch: refuse every Anthropic call (LLM tasks fail fast or queue)', 'ops', 'boolean', false),
  ('kill.provider.byteplus', 'Kill switch: refuse every BytePlus call (image/video; TTS fallback)', 'ops', 'boolean', false),
  ('kill.provider.minimax', 'Kill switch: refuse every MiniMax call (voice-over uses the BytePlus fallback)', 'ops', 'boolean', false)
on conflict (key) do nothing;

-- §20 Platform settings the app reads (with code constants as fallback).
insert into platform_settings (key, value) values
  ('retention.purge_grace_days', '7'),
  ('legal.terms_url', '"/legal/terms"'),
  ('legal.privacy_url', '"/legal/privacy"'),
  ('quota.plan_defaults', '{
     "FREE":   {"brands": 1, "members": 2,  "renderConcurrency": 1, "storageGb": 2},
     "LAUNCH": {"brands": 1, "members": 2,  "renderConcurrency": 2, "storageGb": 5},
     "GROWTH": {"brands": 1, "members": 5,  "renderConcurrency": 3, "storageGb": 20},
     "SCALE":  {"brands": 3, "members": 10, "renderConcurrency": 5, "storageGb": 50}
   }')
on conflict (key) do nothing;
