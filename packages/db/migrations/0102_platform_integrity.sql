-- 0102 · Platform integrity: lifecycle restore, Brand Brain versions, claim scope normalisation, learning
-- revision, production resume/outage bookkeeping, and RLS for global tables that carry tenant rows.

-- ───────────── Workspace lifecycle (plan 02 §2, §7) ─────────────
-- Cancelling a scheduled deletion returns the workspace to the state it had before (not always CANCELLED).
-- (0101 adds the same column for the staff console's cancel-purge; whichever runs first creates it.)
alter table workspaces add column if not exists state_before_purge text check (state_before_purge in
  ('PROVISIONAL','ACTIVE_FREE','ACTIVE_PAID','PAST_DUE','CANCELLED'));

-- ───────────── Claim scope (standard §17, §43) ─────────────
-- Web and staff approvals stored lowercase shorthands ('meta', 'tiktok', …) while the render check compares
-- canonical platform codes, so approved claims never matched. Normalise to upper-case canonical values and
-- expand shorthands (META = Instagram Reels + Facebook feed). Markets are upper-case codes.
update claims c set allowed_platforms = coalesce((
    select array_agg(distinct x order by x) from (
      select unnest(case upper(btrim(p))
        when 'META' then array['INSTAGRAM_REELS', 'FACEBOOK_FEED']
        when 'INSTAGRAM' then array['INSTAGRAM_REELS']
        when 'REELS' then array['INSTAGRAM_REELS']
        when 'FACEBOOK' then array['FACEBOOK_FEED']
        when 'FEED' then array['FACEBOOK_FEED']
        when 'YOUTUBE_SHORTS' then array['YOUTUBE']
        else array[upper(btrim(p))] end) as x
      from unnest(c.allowed_platforms) p) s), '{}')
  where exists (select 1 from unnest(c.allowed_platforms) p
                where p <> upper(btrim(p)) or upper(btrim(p)) in ('META','INSTAGRAM','REELS','FACEBOOK','FEED','YOUTUBE_SHORTS'));
update claims c set allowed_markets = array(select distinct upper(btrim(m)) from unnest(c.allowed_markets) m)
  where exists (select 1 from unnest(c.allowed_markets) m where m <> upper(btrim(m)));

-- ───────────── Brand Brain versions (standard §15, §16 "Brand Brain") ─────────────
-- Brand Brain edits used to overwrite brands.brain in place. Each edit is now an immutable version with its
-- actor and reason; brands.brain stays the current copy and current_version_id points at its version.
create table brand_brain_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  brand_id uuid not null,
  version int not null,
  name text not null,
  brain jsonb not null,
  diff jsonb not null default '{}',
  reason text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (brand_id, version),
  foreign key (workspace_id, brand_id) references brands(workspace_id, id) on delete cascade on update cascade
);
-- Versions are history: never edited (deleted only with the brand, or by a workspace purge).
create trigger brand_brain_versions_immutable before update on brand_brain_versions for each row execute function arkiv_forbid_mutation();
select arkiv_tenant_table('brand_brain_versions'); insert into table_registry values ('brand_brain_versions','tenant');

alter table brands add column current_version_id uuid;
-- Generated work records which Brand Brain it was made with (provenance, §15).
alter table concepts add column brand_brain_version_id uuid;
alter table storyboards add column brand_brain_version_id uuid;

insert into brand_brain_versions (workspace_id, brand_id, version, name, brain, reason, created_by)
  select workspace_id, id, 1, name, brain, 'initial version (backfill)', 'system:migration' from brands;
update brands b set current_version_id = v.id from brand_brain_versions v where v.brand_id = b.id and v.version = 1;

-- Every new brand starts with version 1, whichever path created it.
create or replace function arkiv_brand_initial_version() returns trigger language plpgsql as $$
declare v uuid;
begin
  insert into brand_brain_versions (workspace_id, brand_id, version, name, brain, reason, created_by)
    values (new.workspace_id, new.id, 1, new.name, new.brain, 'created', 'system:brand') returning id into v;
  update brands set current_version_id = v where id = new.id;
  return new;
end $$;
create trigger brands_initial_version after insert on brands for each row execute function arkiv_brand_initial_version();

-- ───────────── Production resume and outage pause (standard §25, §35, §39, §44) ─────────────
-- A provider outage pauses a production (NEEDS_USER_ACTION) with its reservation held; this records which task
-- is waiting, since when and how many resume attempts were made, so a sweep can resume it with backoff.
alter table projects add column outage jsonb;
create index projects_paused_outage on projects (workspace_id) where outage is not null;

-- ───────────── RLS for global tables that carry tenant rows (plan 02 §3 layer 2, §8.1) ─────────────
-- stripe_customers, shopify_shops, email_log and workspace_slug_history were registered 'global' although each
-- row belongs to a workspace, and app_rw could read (and for email_log update) every tenant's rows. They become
-- tenant tables with the standard policies; the few legitimate cross-tenant reads go through narrow
-- SECURITY DEFINER functions. stripe_events (raw payloads with customer PII) is no longer readable by app_rw.

-- A tenant context that may be absent (never throws): for functions that also serve pre-tenant flows.
create or replace function arkiv_current_workspace_or_null() returns uuid
language sql stable as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

select arkiv_tenant_table('stripe_customers');
revoke update, delete on stripe_customers from app_rw;
update table_registry set kind = 'tenant' where table_name = 'stripe_customers';

select arkiv_tenant_table('shopify_shops');
revoke update on shopify_shops from app_rw;
update table_registry set kind = 'tenant' where table_name = 'shopify_shops';

-- Webhook routing (no tenant context yet) and the "store connected elsewhere" check.
create or replace function workspace_for_shop(p_shop text) returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from shopify_shops where shop_domain = p_shop
$$;
create or replace function shop_connected_elsewhere(p_shop text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from shopify_shops where shop_domain = p_shop and workspace_id <> arkiv_current_workspace())
$$;
revoke all on function workspace_for_shop, shop_connected_elsewhere from public;
grant execute on function workspace_for_shop, shop_connected_elsewhere to app_rw;

select arkiv_tenant_table('workspace_slug_history');
revoke update on workspace_slug_history from app_rw;
update table_registry set kind = 'tenant' where table_name = 'workspace_slug_history';

-- email_log: app_rw may read its own workspace's rows only; writes go through the functions below, which also
-- cover sends that have no workspace (magic links) and the per-address marketing frequency cap.
select arkiv_tenant_table('email_log');
revoke insert, update, delete on email_log from app_rw;
update table_registry set kind = 'tenant' where table_name = 'email_log';

create or replace function email_log_open(p_workspace uuid, p_email citext, p_template text, p_stream text, p_key text)
returns table (id uuid, outcome text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
  v_day int;
  v_week int;
begin
  -- A send may only be logged against the tenant the caller is acting for (or none).
  if p_workspace is not null and p_workspace is distinct from arkiv_current_workspace_or_null() then
    raise exception 'email_log_open: workspace does not match tenant context' using errcode = 'insufficient_privilege';
  end if;
  if p_stream = 'marketing' then
    select count(*) filter (where l.created_at > now() - interval '1 day'), count(*) filter (where l.created_at > now() - interval '7 days')
      into v_day, v_week from email_log l where l.to_email = p_email and l.stream = 'marketing';
    if v_day >= 1 or v_week >= 3 then return query select null::uuid, 'capped'::text; return; end if;
  end if;
  insert into email_log (workspace_id, to_email, template, stream, idempotency_key, status)
    values (p_workspace, p_email, p_template, p_stream, p_key, 'queued')
    on conflict (idempotency_key) do nothing returning email_log.id into v_id;
  return query select v_id, case when v_id is null then 'duplicate' else 'opened' end;
end $$;

create or replace function email_log_mark(p_id uuid, p_status text, p_provider_id text, p_event jsonb)
returns void language sql volatile security definer set search_path = public as $$
  update email_log set status = p_status, provider_id = coalesce(p_provider_id, provider_id),
    events = case when p_event is null then events else events || jsonb_build_array(p_event) end
  where id = p_id
    -- Same rule as email_log_open: a tenant's row is only updated from that tenant's context.
    and (workspace_id is null or workspace_id = arkiv_current_workspace_or_null())
$$;

-- Resend webhook (no tenant context): status/event by provider message id.
create or replace function email_log_event(p_provider_id text, p_status text, p_event jsonb)
returns void language sql volatile security definer set search_path = public as $$
  update email_log set status = p_status, events = events || jsonb_build_array(p_event) where provider_id = p_provider_id
$$;
revoke all on function email_log_open, email_log_mark, email_log_event from public;
grant execute on function email_log_open, email_log_mark, email_log_event to app_rw, system_rw;

-- Stripe: the webhook stores events through a dedupe function; app_rw can no longer read raw payloads.
revoke select, insert, update, delete on stripe_events from app_rw;
create or replace function stripe_event_receive(p_id text, p_type text, p_payload jsonb) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v text;
begin
  insert into stripe_events (id, type, payload) values (p_id, p_type, p_payload) on conflict (id) do nothing returning id into v;
  return v is not null;
end $$;
revoke all on function stripe_event_receive from public;
grant execute on function stripe_event_receive to app_rw, system_rw;

-- ───────────── Learning revision (standard §21, §45, §48) ─────────────
-- Learnings are matched on the variant that led (not just the angle), and a result from an operationally
-- confounded period marks the learning instead of creating or strengthening it.
alter table learnings add column leader_variant_id uuid;
alter table learnings add column confounded boolean not null default false;
