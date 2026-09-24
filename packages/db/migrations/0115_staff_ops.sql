-- 0115 · Admin console: trust & safety, integrations health, email & lifecycle, taxonomy, system health
-- (plan 05 §15–§22).

-- Global staff/system tables below follow the same shape: RLS enabled + forced, one explicit policy per role
-- that may touch the table (and the owner, whose SECURITY DEFINER functions run under FORCE RLS).

-- ───────────── §15 Abuse enforcement ─────────────
-- Time-boxed IP range blocks. The app reads them to refuse abuse-prone endpoints (preview, uploads, sign-in links);
-- staff create and lift them. A block is lifted (never deleted), so the history stays visible.
create table ip_blocks (
  id uuid primary key default gen_random_uuid(),
  cidr cidr not null,
  reason text not null,
  until timestamptz not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid
);
create index ip_blocks_active on ip_blocks using gist (cidr inet_ops) where lifted_at is null;
alter table ip_blocks enable row level security; alter table ip_blocks force row level security;
create policy app_read on ip_blocks for select to app_rw using (true);
create policy staff_access on ip_blocks to admin_rw using (true) with check (true);
create policy system_read on ip_blocks for select to system_rw using (true);
do $$ begin execute format('create policy owner_access on ip_blocks to %I using (true) with check (true)', current_user); end $$;
grant select on ip_blocks to app_rw, system_rw;
grant select, insert on ip_blocks to admin_rw;
grant update (lifted_at, lifted_by) on ip_blocks to admin_rw;
insert into table_registry values ('ip_blocks', 'global');

-- Per-key enforcement (keys as in abuse_allowlist: ip:<a.b.c>, domain:<d>, ws:<uuid>): force the bot challenge,
-- and/or tighten rate limits to a fraction of normal, until a time.
create table abuse_overrides (
  key text primary key,
  force_challenge boolean not null default false,
  rate_limit_factor numeric check (rate_limit_factor is null or (rate_limit_factor > 0 and rate_limit_factor <= 1)),
  reason text not null,
  until timestamptz not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table abuse_overrides enable row level security; alter table abuse_overrides force row level security;
create policy app_read on abuse_overrides for select to app_rw using (true);
create policy staff_access on abuse_overrides to admin_rw using (true) with check (true);
create policy system_read on abuse_overrides for select to system_rw using (true);
do $$ begin execute format('create policy owner_access on abuse_overrides to %I using (true) with check (true)', current_user); end $$;
grant select on abuse_overrides to app_rw, system_rw;
grant select, insert, update, delete on abuse_overrides to admin_rw;
insert into table_registry values ('abuse_overrides', 'global');

-- Signals are grouped by kind/key over a window in the console and counted by the detectors.
create index abuse_signals_kind_key on abuse_signals (kind, key, at);
-- The system's sweep records free-preview COGS outliers once a day per workspace (it must read what it wrote).
grant select on abuse_signals to system_rw;

-- ───────────── §15 Rights: freeze, intake by form and email ─────────────
-- A frozen asset (open takedown case) is unavailable for new production until the case is resolved as kept;
-- rights_expires_at stays the real expiry date the merchant attested.
alter table assets add column rights_frozen_at timestamptz;
alter table rights_cases drop constraint rights_cases_origin_check;
alter table rights_cases add constraint rights_cases_origin_check check (origin in ('complaint', 'attestation', 'vision', 'form', 'email'));
alter table rights_cases add column complainant_email citext;
-- Landing examples follow the same rule (mirrors landingAssetProblems() in packages/core/src/landing.ts).
create or replace function landing_example_assets(p_ids uuid[]) returns table (id uuid, storage_key text, mime text)
language sql stable security definer set search_path = public as $$
  select a.id, a.storage_key, a.mime
  from assets a join workspaces w on w.id = a.workspace_id
  left join skus s on s.id = a.sku_id and s.workspace_id = a.workspace_id
  where a.id = any(p_ids) and a.deleted_at is null and w.is_test
    and (a.rights_expires_at is null or a.rights_expires_at > now()) and a.rights_frozen_at is null
    and a.kind in ('final_export', 'scene_render', 'storyboard_frame', 'thumbnail') and a.mime ~ '^(image|video)/'
    and s.category in ('serum', 'cleanser', 'moisturizer', 'eye', 'mask', 'facial_oil', 'toner', 'exfoliant', 'balm', 'skincare')
    and s.status <> 'rejected'
    and not (a.source in ('upload', 'import') and a.rights_attested_at is null)
$$;
-- Email intake (Resend inbound → webhook receipt → worker) is processed by the system role.
grant select, insert on rights_cases to system_rw;
-- The public takedown form: anyone may file a complaint; nobody outside staff can read cases.
create or replace function rights_complaint_submit(p_name text, p_email citext, p_detail text, p_url text) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare rid uuid;
begin
  if coalesce(length(btrim(p_name)), 0) < 2 or p_email is null or position('@' in p_email) < 2 or coalesce(length(btrim(p_detail)), 0) < 10 then
    raise exception 'incomplete complaint' using errcode = 'check_violation';
  end if;
  insert into rights_cases (complainant, complainant_email, detail, origin)
  values (left(btrim(p_name), 200), p_email, left(btrim(p_detail) || coalesce(E'\n\nContent: ' || nullif(btrim(p_url), ''), ''), 4000), 'form')
  returning id into rid;
  return rid;
end $$;
revoke all on function rights_complaint_submit(text, citext, text, text) from public;
grant execute on function rights_complaint_submit(text, citext, text, text) to app_rw;

-- ───────────── §16 Integrations health ─────────────
-- Nightly Shopify webhook verification: when each shop's registrations were last checked and what was found.
alter table shopify_shops add column webhooks_verified_at timestamptz;
alter table shopify_shops add column webhook_health jsonb;

-- Connector contract test results (standard §51), recorded by the contract suite runner. An API-version switch flag
-- can only be enabled when a passing run exists for that provider and version.
create table contract_test_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('shopify', 'meta', 'tiktok')),
  api_version text not null,
  suite text not null,
  passed boolean not null,
  total int not null default 0,
  failed int not null default 0,
  commit_sha text,
  detail jsonb not null default '{}',
  ran_at timestamptz not null default now()
);
create index on contract_test_runs (provider, api_version, ran_at desc);
alter table contract_test_runs enable row level security; alter table contract_test_runs force row level security;
create policy staff_read on contract_test_runs for select to admin_rw using (true);
create policy system_access on contract_test_runs to system_rw using (true) with check (true);
do $$ begin execute format('create policy owner_access on contract_test_runs to %I using (true) with check (true)', current_user); end $$;
grant select on contract_test_runs to admin_rw;
grant select, insert on contract_test_runs to system_rw;
insert into table_registry values ('contract_test_runs', 'global');

-- API versions in use with their deprecation / sunset dates (staff keep them current with setting.set), and the
-- platform app review / listing status.
insert into platform_settings (key, value) values
  ('integrations.api_versions', '[{"provider":"meta","api":"Meta Marketing API","version":"v23.0","deprecatesOn":null,"sunsetOn":null,"notes":"Check the sunset calendar quarterly."},{"provider":"tiktok","api":"TikTok API for Business","version":"v1.3","deprecatesOn":null,"sunsetOn":null,"notes":null},{"provider":"shopify","api":"Shopify Admin API","version":"2026-07","deprecatesOn":null,"sunsetOn":"2027-07-01","notes":"Quarterly versions, supported about 12 months."}]'),
  ('integrations.app_status', '{"meta":{"status":"unknown","note":null},"tiktok":{"status":"unknown","note":null},"shopify":{"status":"unknown","note":null}}')
on conflict (key) do nothing;

-- ───────────── §18 Email & lifecycle ─────────────
-- A hard bounce on an Owner's address raises a banner in the workspace until mail to it is delivered again.
alter table workspaces add column owner_email_bouncing_at timestamptz;
create or replace function email_owner_bounce(p_email citext, p_bouncing boolean) returns integer
language plpgsql volatile security definer set search_path = public as $$
declare n integer;
begin
  update workspaces w set owner_email_bouncing_at = case when p_bouncing then coalesce(w.owner_email_bouncing_at, now()) end
  where (w.owner_email_bouncing_at is null) = p_bouncing
    and exists (select 1 from memberships m join users u on u.id = m.user_id
                where m.workspace_id = w.id and m.role = 'OWNER' and u.email = p_email);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function email_owner_bounce(citext, boolean) from public;
grant execute on function email_owner_bounce(citext, boolean) to app_rw, system_rw;

-- Complaint rate guard: marketing complaints over marketing sends in the last 30 days. Above the threshold the
-- marketing stream is paused (platform setting email.marketing_paused, read by every send), a platform alert is
-- raised and the system action is audited. Staff resume it from the console.
create or replace function email_marketing_complaint_check(p_threshold numeric default 0.001) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_sent integer;
  v_complaints integer;
  v_rate numeric;
  v_paused boolean;
  v_out jsonb;
begin
  select count(*) filter (where l.provider_id is not null or l.status not in ('queued', 'failed')),
         count(*) filter (where l.status = 'complained' or l.events @> '[{"type":"email.complained"}]')
    into v_sent, v_complaints
    from email_log l where l.stream = 'marketing' and l.created_at > now() - interval '30 days';
  v_rate := case when v_sent > 0 then v_complaints::numeric / v_sent else 0 end;
  v_out := jsonb_build_object('sent', v_sent, 'complaints', v_complaints, 'rate', v_rate, 'threshold', p_threshold);
  select exists (select 1 from platform_settings where key = 'email.marketing_paused' and jsonb_typeof(value) = 'object') into v_paused;
  if v_complaints > 0 and v_rate > p_threshold and not v_paused then
    insert into platform_settings (key, value) values ('email.marketing_paused', v_out || jsonb_build_object('at', now(), 'by', 'system'))
      on conflict (key) do update set value = excluded.value, updated_by = null, updated_at = now();
    insert into platform_alerts (kind, severity, subject_type, subject_id, message, details)
      values ('email.marketing_paused', 'risk', 'email_stream', 'marketing',
              format('Marketing email paused: complaint rate %s%% over 30 days is above %s%%.', round(v_rate * 100, 3), round(p_threshold * 100, 3)), v_out)
      on conflict (kind, subject_type, subject_id) where resolved_at is null do nothing;
    insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, reason, after)
      values (null, '{}', 'system.email.marketing_paused', 'setting', 'email.marketing_paused', 'complaint rate above threshold', v_out);
    return v_out || jsonb_build_object('paused', true);
  end if;
  return v_out || jsonb_build_object('paused', v_paused);
end $$;
revoke all on function email_marketing_complaint_check(numeric) from public;
grant execute on function email_marketing_complaint_check(numeric) to app_rw, system_rw;

-- ───────────── §19 Taxonomy proposals ─────────────
-- Add / rename / deprecate one value of one family. A second staff member reviews; an approved proposal becomes a
-- new taxonomy version (with the full canonical families) and its remap (rename, or deprecate into a replacement)
-- is applied to existing genomes by the worker.
create table taxonomy_proposals (
  id uuid primary key default gen_random_uuid(),
  family text not null check (family in ('angle', 'hook', 'proof', 'treatment')),
  op text not null check (op in ('add', 'rename', 'deprecate')),
  value text not null check (value ~ '^[A-Z][A-Z0-9_]{1,60}$'),
  to_value text check (to_value is null or to_value ~ '^[A-Z][A-Z0-9_]{1,60}$'),
  reason text not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  proposed_by uuid not null,
  reviewed_by uuid,
  review_note text,
  reviewed_at timestamptz,
  version int,
  remap_status text check (remap_status in ('queued', 'done', 'failed', 'none')),
  remap_result jsonb,
  created_at timestamptz not null default now(),
  check (op <> 'rename' or to_value is not null),
  check (op <> 'add' or to_value is null),
  check (reviewed_by is null or reviewed_by <> proposed_by)
);
alter table taxonomy_proposals enable row level security; alter table taxonomy_proposals force row level security;
create policy staff_access on taxonomy_proposals to admin_rw using (true) with check (true);
create policy system_access on taxonomy_proposals to system_rw using (true) with check (true);
do $$ begin execute format('create policy owner_access on taxonomy_proposals to %I using (true) with check (true)', current_user); end $$;
grant select, insert, update on taxonomy_proposals to admin_rw;
grant select on taxonomy_proposals to system_rw;
grant update (remap_status, remap_result) on taxonomy_proposals to system_rw;
insert into table_registry values ('taxonomy_proposals', 'global');

alter table ops_commands drop constraint ops_commands_kind_check;
alter table ops_commands add constraint ops_commands_kind_check
  check (kind in ('job.retry', 'job.bulk_retry', 'job.cancel', 'dlq.requeue', 'eval.run', 'integration.verify_webhooks', 'stripe.reconcile', 'taxonomy.remap'));

-- ───────────── §22 Service heartbeats ─────────────
-- Each web and worker process reports in about once a minute (with its storage error count since the last beat).
create table service_heartbeats (
  service text not null check (service in ('web', 'worker', 'admin')),
  instance text not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  detail jsonb not null default '{}',
  primary key (service, instance)
);
alter table service_heartbeats enable row level security; alter table service_heartbeats force row level security;
create policy staff_read on service_heartbeats for select to admin_rw using (true);
create policy system_access on service_heartbeats to system_rw using (true) with check (true);
do $$ begin execute format('create policy owner_access on service_heartbeats to %I using (true) with check (true)', current_user); end $$;
grant select on service_heartbeats to admin_rw;
grant select, insert, update, delete on service_heartbeats to system_rw;
insert into table_registry values ('service_heartbeats', 'global');
-- The web and admin apps report through a narrow function (the app role can't read or edit other rows).
create or replace function service_heartbeat(p_service text, p_instance text, p_detail jsonb) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if p_service not in ('web', 'admin') then raise exception 'service_heartbeat: web and admin only' using errcode = 'insufficient_privilege'; end if;
  insert into service_heartbeats (service, instance, detail) values (p_service, left(p_instance, 120), coalesce(p_detail, '{}'))
  on conflict (service, instance) do update set last_seen_at = now(), detail = excluded.detail;
end $$;
revoke all on function service_heartbeat(text, text, jsonb) from public;
grant execute on function service_heartbeat(text, text, jsonb) to app_rw, admin_rw, system_rw;
