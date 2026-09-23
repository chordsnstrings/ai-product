-- 0102 · Platform integrity: lifecycle restore, Brand Brain versions, claim scope normalisation, learning
-- revision, production resume/outage bookkeeping, and RLS for global tables that carry tenant rows.

-- ───────────── Workspace lifecycle (plan 02 §2, §7) ─────────────
-- Cancelling a scheduled deletion returns the workspace to the state it had before (not always CANCELLED).
alter table workspaces add column state_before_purge text check (state_before_purge in
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
