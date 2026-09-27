-- 0114 · Platform edge cases (standard §44–§48): confounder windows and automatic signals, placement and
-- compatible-context aggregation, reporting currency and source timezone, measured fatigue, ad-account picking,
-- render feedback and re-planning, returning-customer revalidation and creator-asset rights attestation.

-- ───────────── Confounders (§45) ─────────────
-- An automatic signal the merchant has not confirmed yet (e.g. a sales spike with no matching rise in spend) is a
-- candidate: it does not confound anything until confirmed. Dismissed confounders stay (history) but no longer
-- count. Only 'active' rows exclude days or confound a test.
alter table confounders add column status text not null default 'active' check (status in ('active', 'pending_confirmation', 'dismissed'));
alter table confounders add column decided_at timestamptz;
alter table confounders add column decided_by text;
alter table confounders add column detail jsonb not null default '{}';
create index confounders_sku_active on confounders (workspace_id, sku_id, starts_at) where status = 'active';

-- The confounder windows that overlapped an experiment's observation dates, and the compatible campaign context
-- (optimization event × campaign type) the comparison was computed under (§45 "aggregate only under compatible
-- context").
alter table experiment_results add column confounder_windows jsonb not null default '[]';
alter table experiment_results add column scope jsonb not null default '{}';

-- ───────────── Observations: placement, source timezone, reporting currency (§45, §47) ─────────────
-- placement: publisher platform × position ('all' when the source gives no breakdown). Part of the dedupe key, so
-- a placement row never supersedes another placement's row.
alter table performance_observations add column placement text not null default 'all';
alter table performance_observations add column source_timezone text;
alter table performance_observations add column fx_rate numeric;
alter table performance_observations add column reporting_currency text;
alter table performance_observations add column spend_reporting_micros bigint;
alter table performance_observations add column value_reporting_micros bigint;
alter table performance_observations drop constraint performance_observations_workspace_id_platform_ad_id_date_m_key;
alter table performance_observations add constraint performance_observations_obs_key
  unique (workspace_id, platform, ad_id, date, measurement_context, attribution_window, placement, revision);

-- Versioned FX rates (reference data, staff-editable): usd_per_unit converts one unit of `currency` to USD; a
-- conversion between two currencies goes through USD. The newest effective version wins.
create table fx_rates (
  id uuid primary key default gen_random_uuid(),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  usd_per_unit numeric not null check (usd_per_unit > 0),
  version int not null default 1,
  effective_from date not null default current_date,
  source text not null default 'seed',
  created_by text,
  created_at timestamptz not null default now(),
  unique (currency, version)
);
grant select on fx_rates to app_rw, system_rw;
grant select, insert, update on fx_rates to admin_rw;
insert into table_registry values ('fx_rates', 'global');
insert into fx_rates (currency, usd_per_unit, effective_from, source) values
  ('USD', 1, '2026-01-01', 'seed'), ('EUR', 1.08, '2026-01-01', 'seed'), ('GBP', 1.27, '2026-01-01', 'seed'),
  ('CAD', 0.73, '2026-01-01', 'seed'), ('AUD', 0.66, '2026-01-01', 'seed'), ('NZD', 0.60, '2026-01-01', 'seed'),
  ('JPY', 0.0067, '2026-01-01', 'seed'), ('KRW', 0.00073, '2026-01-01', 'seed'), ('SEK', 0.095, '2026-01-01', 'seed'),
  ('NOK', 0.093, '2026-01-01', 'seed'), ('DKK', 0.145, '2026-01-01', 'seed'), ('CHF', 1.12, '2026-01-01', 'seed'),
  ('SGD', 0.74, '2026-01-01', 'seed'), ('HKD', 0.128, '2026-01-01', 'seed'), ('MXN', 0.058, '2026-01-01', 'seed'),
  ('BRL', 0.19, '2026-01-01', 'seed'), ('INR', 0.012, '2026-01-01', 'seed'), ('PLN', 0.25, '2026-01-01', 'seed');

-- ───────────── Measured fatigue (§45 "Creative winner fatigues") ─────────────
-- Per-variant decay read from observations (recent CTR / hold rate against the first days live, frequency trend,
-- days live), refreshed with results. A fatigued winner asks for a controlled refresh (same angle, new hook,
-- the winner as control).
alter table experiments add column fatigue jsonb not null default '{}';
alter table experiments add column fatigue_at timestamptz;
alter table recommendations add column control_creative_id uuid;
alter table recommendations add column kind text not null default 'standard' check (kind in ('standard', 'refresh'));

-- ───────────── Ad-account picker (§47 "Wrong ad account selected") ─────────────
-- The exchanged token waits here (encrypted, short-lived) while the merchant chooses which accounts to connect.
create table pending_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null check (provider in ('meta', 'tiktok')),
  token_enc text not null,
  accounts jsonb not null default '[]',
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes'
);
select arkiv_tenant_table('pending_connections'); insert into table_registry values ('pending_connections', 'tenant');

-- ───────────── "Customer hates first render" (§48) ─────────────
create table project_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  diagnosis text not null check (diagnosis in ('strategy', 'fidelity', 'execution')),
  scene_ids uuid[] not null default '{}',
  note text,
  revision_project_id uuid,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on project_feedback (workspace_id, project_id);
select arkiv_tenant_table('project_feedback'); insert into table_registry values ('project_feedback', 'tenant');
alter table projects add column revision_of uuid;

-- ───────────── Returning customer (§48 "Customer returns months later") ─────────────
-- While pending, recommendations and new production wait for the merchant to confirm the checklist.
alter table workspaces add column revalidation jsonb;
alter table workspaces add column revalidation_pending boolean not null default false;
alter table workspaces add column revalidated_at timestamptz;

-- ───────────── Creator / customer asset rights (§48 adversarial) ─────────────
alter table assets add column rights_owner text;
alter table assets add column rights_scope text check (rights_scope in ('paid_ads', 'organic', 'all_marketing'));
alter table assets add column rights_includes_people boolean;
alter table assets add column rights_includes_minors boolean;

-- Rights cases can be opened by the system from an attestation (identifiable people / minors) as well as by staff
-- from a complaint. The app never reads the table; it opens a review for an asset of its own workspace through a
-- narrow definer function.
alter table rights_cases add column origin text not null default 'complaint' check (origin in ('complaint', 'attestation', 'vision'));
create or replace function arkiv_open_rights_review(p_asset uuid, p_detail text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ws uuid := arkiv_current_workspace();
  rid uuid;
begin
  if not exists (select 1 from assets where id = p_asset and workspace_id = ws) then
    raise exception 'asset not in this workspace' using errcode = 'insufficient_privilege';
  end if;
  select id into rid from rights_cases where asset_id = p_asset and workspace_id = ws and status in ('open', 'frozen') limit 1;
  if rid is null then
    insert into rights_cases (workspace_id, asset_id, complainant, detail, origin)
    values (ws, p_asset, 'merchant attestation', left(p_detail, 1000), 'attestation') returning id into rid;
  end if;
  return rid;
end $$;
revoke all on function arkiv_open_rights_review(uuid, text) from public;
grant execute on function arkiv_open_rights_review(uuid, text) to app_rw, system_rw;
