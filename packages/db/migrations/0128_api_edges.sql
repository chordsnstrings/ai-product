-- 0128 · API edges: webhook routing and dedupe, provider callbacks, resumable uploads (standard §38, §39, §47, §48;
-- plan 02 §8 item 7, plan 06 Phase 0 D7 / Phase 1 D3 / Phase 3 D3).
-- No new tables: every change extends a table already registered with forced RLS and explicit policies.

-- ───────────── Webhook receipts: an unmatched queue, and provider render callbacks ─────────────
-- A Shopify delivery for a shop no workspace is connected to is kept as 'unmatched' for staff (plan 02 §8 item 7:
-- "unknown → unmatched queue"), never silently acknowledged as processed. Video providers' task callbacks are
-- stored and deduplicated the same way ('byteplus'): the callback is a hint, the worker re-fetches the task.
alter table webhook_receipts drop constraint webhook_receipts_status_check;
alter table webhook_receipts add constraint webhook_receipts_status_check
  check (status in ('pending', 'processing', 'processed', 'failed', 'ignored', 'unmatched'));
alter table webhook_receipts drop constraint webhook_receipts_provider_check;
alter table webhook_receipts add constraint webhook_receipts_provider_check
  check (provider in ('shopify', 'resend', 'meta', 'tiktok', 'byteplus'));
create index webhook_receipts_unmatched on webhook_receipts (received_at desc) where status = 'unmatched';

-- ───────────── Email delivery status is monotonic (standard §47 "Duplicate webhook") ─────────────
-- Provider events arrive late, twice and out of order: a 'delivered' after an 'opened' must not move the status
-- back, and a bounce or complaint is final. An event carrying its delivery id is appended once.
create or replace function email_status_rank(p_status text) returns int
language sql immutable set search_path = public as $$
  select case p_status
    when 'queued' then 0 when 'scheduled' then 0 when 'logged' then 1 when 'sent' then 1
    when 'delivery_delayed' then 2 when 'delivered' then 3 when 'opened' then 4 when 'clicked' then 5
    when 'failed' then 10 when 'bounced' then 10 when 'complained' then 10
    else null end
$$;

create or replace function email_log_event(p_provider_id text, p_status text, p_event jsonb)
returns void language sql volatile security definer set search_path = public as $$
  update email_log set
    status = case
      when email_status_rank(status) >= 10 then status
      when email_status_rank(p_status) is null then status
      when email_status_rank(status) is null or email_status_rank(p_status) > email_status_rank(status) then p_status
      else status end,
    events = case
      when p_event ? 'id' and events @> jsonb_build_array(jsonb_build_object('id', p_event->'id')) then events
      else events || jsonb_build_array(p_event) end
  where provider_id = p_provider_id
$$;
revoke all on function email_log_event from public;
grant execute on function email_log_event to app_rw, system_rw;

-- ───────────── Provider jobs: callbacks and a single settlement (standard §35, §39) ─────────────
-- last_polled_at: the worker waiting on the render is alive and polling (a callback then leaves the job to it).
-- callback_at: the provider called back. settling_at: one process claimed the job to settle it from a callback or
-- the reconciler, so a duplicate callback cannot copy the output twice (the close itself is guarded by status).
alter table provider_jobs add column last_polled_at timestamptz,
  add column callback_at timestamptz,
  add column settling_at timestamptz;

-- ───────────── Resumable uploads (plan 06 Phase 1 D3) ─────────────
-- A large upload is sent in parts straight to quarantine (S3 multipart; the local driver emulates it), so a dropped
-- connection resumes from the parts already stored. 'quarantined' means the parts were assembled.
alter table uploads add column multipart_id text,
  add column part_size int check (part_size > 0),
  add column part_count int check (part_count between 1 and 10000),
  add column filename text;
