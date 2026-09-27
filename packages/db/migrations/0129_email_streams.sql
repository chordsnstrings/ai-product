-- 0129 · Email streams, suppression model, digest preferences, purge anonymization and export archives
-- (plan 05 §18, plan 03 A10, plan 02 §2/§7, standard §34).

-- ───────────── Suppressions: one row per (address, stream, reason) ─────────────
-- An unsubscribe (marketing), a hard bounce (all streams) and a complaint (the stream it came from) are separate
-- facts. Clearing a bounce must not silently re-subscribe someone who unsubscribed from marketing, and a complaint
-- on a marketing email must not stop receipts. Existing rows keep their stream and reason.
alter table email_suppressions drop constraint email_suppressions_pkey;
alter table email_suppressions add primary key (email, stream, reason);
alter table email_suppressions add constraint email_suppressions_stream_check check (stream in ('all', 'marketing', 'transactional'));

-- ───────────── email_log_open: record every outcome, one marketing send per address at a time ─────────────
-- p_blocked: the sender decided not to send ('suppressed' or 'paused'); the attempt is still logged so staff, the
-- tenant and the inviter can see it. A marketing send takes a per-address advisory lock before counting the
-- frequency cap, so two concurrent sends can't both pass it (the lock is held until the caller's short
-- transaction commits the row). The cap counts only sends that went out. An existing row that never went out
-- (queued, failed, suppressed, capped, paused) is re-claimed by a retry under the same key, so a retry after an
-- error or an unsuppression still sends (Resend dedupes the provider call on the same Idempotency-Key).
drop function email_log_open(uuid, citext, text, text, text, jsonb);
create or replace function email_log_open(p_workspace uuid, p_email citext, p_template text, p_stream text, p_key text,
                                          p_data jsonb default null, p_blocked text default null)
returns table (id uuid, outcome text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
  v_day int;
  v_week int;
  v_status text := coalesce(p_blocked, 'queued');
begin
  if p_workspace is not null and p_workspace is distinct from arkiv_current_workspace_or_null() then
    raise exception 'email_log_open: workspace does not match tenant context' using errcode = 'insufficient_privilege';
  end if;
  if p_blocked is not null and p_blocked not in ('suppressed', 'paused') then
    raise exception 'email_log_open: unknown block reason %', p_blocked;
  end if;
  if p_stream = 'marketing' and p_blocked is null then
    perform pg_advisory_xact_lock(hashtext('email-marketing:' || lower(p_email::text)));
    select count(*) filter (where l.created_at > now() - interval '1 day'), count(*) filter (where l.created_at > now() - interval '7 days')
      into v_day, v_week from email_log l
      where l.to_email = p_email and l.stream = 'marketing' and l.idempotency_key <> p_key
        and l.status not in ('suppressed', 'capped', 'paused', 'failed');
    if v_day >= 1 or v_week >= 3 then v_status := 'capped'; end if;
  end if;
  insert into email_log as l (workspace_id, to_email, template, stream, idempotency_key, status, data)
    values (p_workspace, p_email, p_template, p_stream, p_key, v_status, p_data)
    on conflict (idempotency_key) do update
      set status = excluded.status, data = excluded.data, created_at = now(),
          events = l.events || jsonb_build_array(jsonb_build_object('type', 'retry', 'previous', l.status, 'at', now()))
      where l.status in ('queued', 'failed', 'suppressed', 'capped', 'paused')
        and l.workspace_id is not distinct from p_workspace
    returning l.id into v_id;
  if v_id is null then return query select null::uuid, 'duplicate'::text; return; end if;
  return query select v_id, case v_status when 'queued' then 'opened' else v_status end;
end $$;
revoke all on function email_log_open from public;
grant execute on function email_log_open to app_rw, system_rw;

-- The Resend webhook has no tenant context: it looks up which stream a message was sent on.
create or replace function email_log_lookup(p_provider_id text) returns table (stream text, template text, workspace_id uuid)
language sql stable security definer set search_path = public as $$
  select l.stream, l.template, l.workspace_id from email_log l where l.provider_id = p_provider_id limit 1
$$;
revoke all on function email_log_lookup(text) from public;
grant execute on function email_log_lookup(text) to app_rw, system_rw;

-- The complaint rate is complaints over marketing email that actually went out.
create or replace function email_marketing_complaint_check(p_threshold numeric default 0.001) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_sent integer;
  v_complaints integer;
  v_rate numeric;
  v_paused boolean;
  v_out jsonb;
begin
  select count(*) filter (where l.provider_id is not null or l.status not in ('queued', 'failed', 'suppressed', 'capped', 'paused')),
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

-- ───────────── Digest preferences (plan 03 A10 "Weekly" is not transactional) ─────────────
-- A member can stop each weekly digest per workspace (Profile settings, or the signed one-click link in the email).
-- Stored apart from email_suppressions: stopping a digest never touches receipts or security email.
create table notification_prefs (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('weekly_brief', 'signal_update', 'friday_summary', 'day30_review')),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id, kind)
);
select arkiv_tenant_table('notification_prefs');
insert into table_registry values ('notification_prefs', 'tenant');

-- ───────────── Workspace export archives (plan 02 §7) ─────────────
-- The export ZIP gets its own asset kind, so a later export never embeds earlier ones.
alter table assets drop constraint assets_kind_check;
alter table assets add constraint assets_kind_check check (kind in ('product_photo','cutout','reference_view','label_crop','storyboard_frame',
  'scene_render','voiceover','final_export','creator_footage','evidence_doc','brand_logo','brand_reference','historical_creative','thumbnail','captions',
  'export_archive'));
update assets set kind = 'export_archive' where kind = 'evidence_doc' and lineage->>'export' = 'true';

-- ───────────── Purge: staff QA notes go with the tenant (plan 02 §7) ─────────────
grant select, delete on qa_reviews to system_rw;
create policy system_access on qa_reviews to system_rw using (true) with check (true);

-- ───────────── Purge: financial and audit rows kept, personal data removed (plan 02 §2, §7 step 4) ─────────────
-- The append-only tables allow exactly one kind of update: the purge of their own workspace, marked by the
-- transaction-local setting arkiv.purge_workspace that only arkiv_anonymize_workspace() sets. No pool role has
-- UPDATE on these tables, so the setting alone grants nothing; deletes stay forbidden.
create or replace function arkiv_purge_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_setting('arkiv.purge_workspace', true) = old.workspace_id::text
     and new.workspace_id is not distinct from old.workspace_id then
    return new;
  end if;
  raise exception '% is append-only', tg_table_name;
end $$;
drop trigger ledger_append_only on ledger_entries;
create trigger ledger_append_only before update or delete on ledger_entries for each row execute function arkiv_purge_guard();
drop trigger consent_append_only on consent_records;
create trigger consent_append_only before update or delete on consent_records for each row execute function arkiv_purge_guard();

create or replace function arkiv_events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.actor like 'user:%' and old.actor not like 'user:deleted:%' and new.actor like 'user:deleted:%'
     and (new.id, new.workspace_id, new.type, new.subject_type, new.subject_id, new.payload, new.schema_version, new.at)
         is not distinct from (old.id, old.workspace_id, old.type, old.subject_type, old.subject_id, old.payload, old.schema_version, old.at) then
    return new;
  end if;
  -- The purge may rewrite the actor and redact the payload; what happened, to what and when stays.
  if tg_op = 'UPDATE' and current_setting('arkiv.purge_workspace', true) = old.workspace_id::text
     and (new.id, new.workspace_id, new.type, new.subject_type, new.subject_id, new.schema_version, new.at)
         is not distinct from (old.id, old.workspace_id, old.type, old.subject_type, old.subject_id, old.schema_version, old.at) then
    return new;
  end if;
  raise exception '% is append-only', tg_table_name;
end $$;

-- Personal data inside a JSON document: values under identifying keys, and any string that is an email address.
create or replace function arkiv_redact_pii(p jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  k text;
  v jsonb;
  o jsonb;
begin
  if p is null then return null; end if;
  case jsonb_typeof(p)
    when 'object' then
      o := '{}'::jsonb;
      for k, v in select * from jsonb_each(p) loop
        if lower(k) ~ '^(.*_)?(email|emails|name|phone|address|ip|user_agent|useragent|shipping|shipping_details|billing_details|to|requester)$'
           and jsonb_typeof(v) <> 'null' then
          o := o || jsonb_build_object(k, '[redacted]');
        else
          o := o || jsonb_build_object(k, arkiv_redact_pii(v));
        end if;
      end loop;
      return o;
    when 'array' then
      return coalesce((select jsonb_agg(arkiv_redact_pii(e)) from jsonb_array_elements(p) e), '[]'::jsonb);
    when 'string' then
      if (p #>> '{}') ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' then return to_jsonb('[redacted]'::text); end if;
      return p;
    else
      return p;
  end case;
end $$;

-- The anonymous form of a user actor, the same one account deletion uses.
create or replace function arkiv_anonymous_actor(p_actor text) returns text
language sql immutable set search_path = public as $$
  select case when p_actor ~ '^user:[0-9a-f-]{36}$'
    then 'user:deleted:' || left(encode(sha256(convert_to('arkiv-deleted-user:' || substr(p_actor, 6), 'UTF8')), 'hex'), 16)
    else p_actor end
$$;

create or replace function arkiv_anonymize_workspace(p_ws uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_state text;
  n int;
  v_out jsonb := '{}'::jsonb;
begin
  select state into v_state from workspaces where id = p_ws;
  if v_state is null or v_state not in ('PURGE_SCHEDULED', 'PURGED') then
    raise exception 'arkiv_anonymize_workspace: workspace is not being purged' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('arkiv.purge_workspace', p_ws::text, true);

  update events set actor = arkiv_anonymous_actor(actor), payload = arkiv_redact_pii(payload)
    where workspace_id = p_ws and (actor ~ '^user:[0-9a-f-]{36}$' or payload is distinct from arkiv_redact_pii(payload));
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('events_anonymized', n);

  update ledger_entries set actor = arkiv_anonymous_actor(actor) where workspace_id = p_ws and actor ~ '^user:[0-9a-f-]{36}$';
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('ledger_entries_anonymized', n);

  update consent_records set user_id = null, ip = null, user_agent = null, context = arkiv_redact_pii(context)
    where workspace_id = p_ws and (user_id is not null or ip is not null or user_agent is not null or context is distinct from arkiv_redact_pii(context));
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('consent_records_anonymized', n);

  update stripe_events set payload = arkiv_redact_pii(payload) where workspace_id = p_ws and payload is distinct from arkiv_redact_pii(payload);
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('stripe_events_redacted', n);

  -- Kept financial records lose who did what; amounts, dates and Stripe references stay.
  update purchases set created_by = arkiv_anonymous_actor(created_by) where workspace_id = p_ws and created_by ~ '^user:';
  update refunds set customer_note = null, requested_by = null, approved_by = null where workspace_id = p_ws;
  update stripe_disputes set evidence = arkiv_redact_pii(evidence) where workspace_id = p_ws;

  update email_log set to_email = 'deleted-' || left(encode(sha256(convert_to(lower(to_email::text), 'UTF8')), 'hex'), 16) || '@deleted.invalid',
                       data = null
    where workspace_id = p_ws and to_email::text not like '%@deleted.invalid';
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('email_log_anonymized', n);

  update funnel_events set visitor_id = null, props = '{}'::jsonb, utm = null where workspace_id = p_ws and (visitor_id is not null or props <> '{}'::jsonb or utm is not null);
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('funnel_events_anonymized', n);

  perform set_config('arkiv.purge_workspace', '', true);
  return v_out;
end $$;
revoke all on function arkiv_anonymize_workspace(uuid) from public;
grant execute on function arkiv_anonymize_workspace(uuid) to system_rw;
