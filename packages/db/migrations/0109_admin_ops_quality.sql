-- 0109 · Admin console: providers, prompts & evals, jobs, QA and compliance (plan 05 §10–§14).

-- ───────────── §10 Automatic circuit breaker ─────────────
-- A circuit the breaker sweep opened (circuit_auto) closes itself after its cool-down; one staff opened stays
-- open until staff close it. circuit_changed_at restarts the error window, so failures from before a close never
-- re-trip the circuit; circuit_reason says why it is open (the error rate, or staff's reason).
alter table model_routes add column circuit_auto boolean not null default false;
alter table model_routes add column circuit_reason text;
alter table model_routes add column circuit_changed_at timestamptz;

-- ───────────── §11 Prompt registry ─────────────
-- Routes now choose their template text by prompt_version. New registered versions: the fidelity inspector
-- returns the label text it read (the QA review OCR diff), and the product analyst flags before/after photos and
-- photos that may show minors for compliance review.
update model_routes set prompt_version = 'fidelity@1.1.0' where task = 'qa.fidelity' and prompt_version = 'fidelity@1.0.0';
update model_routes set prompt_version = 'extract-product@1.1.0' where task = 'extract.product_facts' and prompt_version = 'extract-product@1.0.0';

-- ───────────── §12 Jobs: bulk retry by error class ─────────────
alter table ops_commands drop constraint ops_commands_kind_check;
alter table ops_commands add constraint ops_commands_kind_check
  check (kind in ('job.retry', 'job.bulk_retry', 'job.cancel', 'dlq.requeue', 'eval.run', 'integration.verify_webhooks', 'stripe.reconcile'));

-- ───────────── §11 Eval runs: per-case latency and cost ─────────────
-- results[] carries per-case latency_ms and cost_micros; the run keeps its aggregate p50 latency next to its cost.
alter table eval_runs add column latency_p50_ms int;

-- ───────────── §11 Golden datasets extended from production (§51) ─────────────
-- Code seeds (packages/core evals.ts) plus cases staff add. A case built from a tenant's production output needs
-- the tenant's explicit consent reference and is added under break-glass; otherwise it must be a synthetic
-- reproduction (written by staff, no tenant content). Global and staff/system-only: the app role has no access.
create table golden_cases (
  id uuid primary key default gen_random_uuid(),
  dataset text not null,
  input text not null,
  expected text not null,
  note text,
  source text not null check (source in ('synthetic', 'production')),
  consent_ref text,
  -- The tenant a production case came from (metadata; the case is removed when that workspace is purged).
  source_workspace_id uuid,
  origin jsonb not null default '{}',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_by uuid,
  check (source <> 'production' or (consent_ref is not null and length(btrim(consent_ref)) >= 4 and source_workspace_id is not null))
);
create index on golden_cases (dataset) where retired_at is null;
alter table golden_cases enable row level security; alter table golden_cases force row level security;
create policy staff_access on golden_cases to admin_rw using (true) with check (true);
create policy system_access on golden_cases to system_rw using (true) with check (true);
grant select, insert on golden_cases to admin_rw;
grant update (retired_at, retired_by) on golden_cases to admin_rw;
grant select, delete on golden_cases to system_rw;
insert into table_registry values ('golden_cases', 'global');

-- ───────────── §14 Compliance review decisions ─────────────
-- One row per staff decision on a compliance queue item: an implied-claim flag resolved, a before/after or
-- possible-minor asset approved or rejected, a drug/OTC exclusion confirmed, a blocked-claim pattern escalated,
-- a restricted claim kept restricted or sent back for evidence. The tenant may read decisions about its own
-- content; only staff and the system write them.
create table compliance_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('implied_claim', 'asset_review', 'sku_exclusion', 'blocked_pattern', 'claim_review')),
  subject_type text not null,
  subject_id uuid not null,
  verdict text not null,
  note text,
  staff_id uuid not null,
  created_at timestamptz not null default now()
);
create index on compliance_reviews (workspace_id, kind, subject_id);
select arkiv_tenant_table('compliance_reviews', false); insert into table_registry values ('compliance_reviews', 'tenant');

-- Restricted claims: staff's note when keeping a claim restricted, and when more evidence was last requested.
alter table claims add column compliance_note text;
alter table claims add column evidence_requested_at timestamptz;

-- Drug/OTC detector hits: staff confirmed the exclusion (the owner is told the SKU is out of V1 scope).
alter table skus add column exclusion_confirmed_at timestamptz;

-- Before/after and possible minors (standard §48): merchant-supplied media the analyst or upload checks flagged.
-- review_status is null for unflagged media, 'pending' until compliance decides, then 'approved' or 'rejected';
-- production never uses pending or rejected media.
alter table assets add column review_flags jsonb;
alter table assets add column review_status text check (review_status in ('pending', 'approved', 'rejected'));
create index assets_review_pending on assets (created_at) where review_status = 'pending';
