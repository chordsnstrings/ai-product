-- 0113: API surfaces — least-privilege web process, webhooks, render quotes, waitlist, per-platform CSV imports.

-- ───────────── The customer app holds only app_rw (plan 02 §3 layer 2) ─────────────
-- Operations the web process used to run as system_rw are narrow SECURITY DEFINER functions instead, each doing one
-- thing and checking what it needs itself.

-- Save an anonymous preview into an existing account (plan 02 §2.1): only a provisional workspace's SKUs, only into a
-- live workspace where the user can add products. Composite FKs cascade the whole SKU subtree. The provisional
-- workspace is scheduled for purge an hour out; the caller copies the moved objects to the new tenant prefix under
-- the target's own RLS context, and the purge re-homes any object it finds still referenced by another workspace.
create or replace function move_provisional_skus(p_from uuid, p_to uuid, p_user uuid) returns integer
language plpgsql volatile security definer set search_path = public as $$
declare v_state text; v_role text; s record; v_no int; n int := 0;
begin
  if p_from = p_to then raise exception 'nothing to move' using errcode = 'P0002'; end if;
  select m.role into v_role from memberships m join workspaces w on w.id = m.workspace_id
   where m.workspace_id = p_to and m.user_id = p_user and w.state not in ('PROVISIONAL', 'PURGE_SCHEDULED', 'PURGED');
  if v_role is null or v_role not in ('OWNER', 'ADMIN', 'MEMBER') then raise exception 'forbidden' using errcode = '42501'; end if;
  select state into v_state from workspaces where id = p_from for update;
  if v_state is distinct from 'PROVISIONAL' then raise exception 'nothing to move' using errcode = 'P0002'; end if;
  for s in select id from skus where workspace_id = p_from order by catalogue_no loop
    update workspaces set next_catalogue_no = next_catalogue_no + 1 where id = p_to returning next_catalogue_no - 1 into v_no;
    update skus set brand_id = null where id = s.id;
    update skus set workspace_id = p_to, catalogue_no = v_no where id = s.id;
    n := n + 1;
  end loop;
  update workspaces set state = 'PURGE_SCHEDULED', purge_at = now() + interval '1 hour', provisional_token_hash = null where id = p_from;
  return n;
end $$;
revoke all on function move_provisional_skus(uuid, uuid, uuid) from public;
grant execute on function move_provisional_skus(uuid, uuid, uuid) to app_rw, system_rw;

-- Landing page proof line: a platform-wide count, no tenant data.
create or replace function landing_claims_checked_7d() returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from events where type = 'CLAIM_CREATED' and at > now() - interval '7 days'
$$;
revoke all on function landing_claims_checked_7d() from public;
grant execute on function landing_claims_checked_7d() to app_rw, system_rw;

-- Landing example media (plan 05 §5, plan 04 L13): only assets that still qualify as examples — a finished ad, scene
-- or frame of a skincare product in an internal (test) workspace, not deleted, rights live and attested for uploads.
-- Mirrors landingAssetProblems() in packages/core/src/landing.ts (a test keeps the two in step).
create or replace function landing_example_assets(p_ids uuid[]) returns table (id uuid, storage_key text, mime text)
language sql stable security definer set search_path = public as $$
  select a.id, a.storage_key, a.mime
  from assets a join workspaces w on w.id = a.workspace_id
  left join skus s on s.id = a.sku_id and s.workspace_id = a.workspace_id
  where a.id = any(p_ids) and a.deleted_at is null and w.is_test
    and (a.rights_expires_at is null or a.rights_expires_at > now())
    and a.kind in ('final_export', 'scene_render', 'storyboard_frame', 'thumbnail') and a.mime ~ '^(image|video)/'
    and s.category in ('serum', 'cleanser', 'moisturizer', 'eye', 'mask', 'facial_oil', 'toner', 'exfoliant', 'balm', 'skincare')
    and s.status <> 'rejected'
    and not (a.source in ('upload', 'import') and a.rights_attested_at is null)
$$;
revoke all on function landing_example_assets(uuid[]) from public;
grant execute on function landing_example_assets(uuid[]) to app_rw, system_rw;

-- Account deletion (plan 02 §7) from the customer app: re-attribute a deleted user's events. Only for a user row
-- already marked deleted, and only to that user's own stable anonymous actor (computed here, not trusted).
create or replace function arkiv_anonymize_user_events(p_user uuid, p_actor text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_actor is distinct from 'user:deleted:' || left(encode(sha256(convert_to('arkiv-deleted-user:' || p_user::text, 'UTF8')), 'hex'), 16) then
    raise exception 'invalid anonymous actor';
  end if;
  if not exists (select 1 from users where id = p_user and deleted_at is not null) then raise exception 'user is not deleted'; end if;
  update events set actor = p_actor where actor = 'user:' || p_user::text;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function arkiv_anonymize_user_events(uuid, text) from public;
grant execute on function arkiv_anonymize_user_events(uuid, text) to app_rw, system_rw;

-- ───────────── Merchant CSV imports are per platform (standard §48 data contamination, §30) ─────────────
-- A Meta export and a TikTok export for the same variant were pooled into one MERCHANT_IMPORTED result and learned
-- from as "blended". Each platform's rows now have their own context; imported rows are re-labelled from the
-- platform they were stored under, and derived results in the old context are dropped (recomputed on the next run).
alter table performance_observations drop constraint performance_observations_measurement_context_check;
update performance_observations set measurement_context = case platform when 'tiktok' then 'MERCHANT_IMPORTED_TIKTOK' else 'MERCHANT_IMPORTED_META' end
  where measurement_context = 'MERCHANT_IMPORTED';
alter table performance_observations add constraint performance_observations_measurement_context_check
  check (measurement_context in ('META_PAID_ATTRIBUTED', 'TIKTOK_PAID_ATTRIBUTED', 'TIKTOK_GMV_MAX_TOTAL', 'SHOPIFY_BLENDED_ORDER',
                                 'MERCHANT_IMPORTED_META', 'MERCHANT_IMPORTED_TIKTOK'));
delete from experiment_results where measurement_context = 'MERCHANT_IMPORTED';

-- ───────────── Waitlist for out-of-scope products (plan 03 P2 edge cases) ─────────────
-- "We're built for skincare…" / "outside V1 scope" → a waitlist email, no generation spend. Global (pre-account
-- visitors); the app role can only add a row, staff read it.
create table waitlist (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  category text not null check (category in ('non_skincare', 'excluded_category')),
  reason text,
  product_name text,
  visitor_id text,
  consent_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (email, category)
);
alter table waitlist enable row level security;
alter table waitlist force row level security;
create policy staff_read on waitlist for select to admin_rw using (true);
create policy system_access on waitlist to system_rw using (true) with check (true);
do $$ begin execute format('create policy owner_access on waitlist to %I using (true) with check (true)', current_user); end $$;
-- The app joins through waitlist_join() (dedupe without being able to read who else is on the list).
create or replace function waitlist_join(p_email citext, p_category text, p_reason text, p_product text, p_visitor text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v uuid;
begin
  insert into waitlist (email, category, reason, product_name, visitor_id, consent_at)
  values (p_email, p_category, p_reason, p_product, p_visitor, now())
  on conflict (email, category) do nothing returning id into v;
  return v is not null;
end $$;
revoke all on function waitlist_join(citext, text, text, text, text) from public;
grant execute on function waitlist_join(citext, text, text, text, text) to app_rw, system_rw;
grant select on waitlist to admin_rw;
grant select, insert, delete on waitlist to system_rw;
insert into table_registry values ('waitlist', 'global');
