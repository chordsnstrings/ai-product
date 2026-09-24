-- 0106 · Platform hardening: exactly-once Stripe processing, atomic job and invite de-duplication, event refs,
-- job heartbeats, recommendation rationale, fact immutability, analysis ETAs and product variants.

-- ───────────── Stripe events: claim before processing (plan 02 B1/B2, standard §35/§38) ─────────────
-- The webhook route, the worker poller and an admin replay may all start the same event. A caller first claims
-- it (status → processing with a random claim token); the tenant transaction that applies the event marks it
-- processed as its last statement, under the same claim, so side effects and the mark commit together.
alter table stripe_events drop constraint stripe_events_status_check;
alter table stripe_events add constraint stripe_events_status_check
  check (status in ('received','processing','processed','unmatched','ignored','failed'));
alter table stripe_events add column claimed_at timestamptz;
alter table stripe_events add column claim_token uuid;
create index stripe_events_pending on stripe_events (received_at) where status in ('received','processing','unmatched');

-- Called from inside the tenant transaction (app_rw has no rights on stripe_events). Only the holder of the
-- current claim can complete it; the event is attributed to the tenant whose context applied it.
create or replace function stripe_event_complete(p_id text, p_claim uuid) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v text;
begin
  update stripe_events
     set status = 'processed', processed_at = now(), workspace_id = arkiv_current_workspace(), error = null, claim_token = null
   where id = p_id and status = 'processing' and claim_token = p_claim
  returning id into v;
  return v is not null;
end $$;
revoke all on function stripe_event_complete from public;
grant execute on function stripe_event_complete to app_rw, system_rw;

-- ───────────── Outbox singleton keys (standard §35, §39) ─────────────
-- At most one undispatched job per (queue, singleton key), enforced by the database so concurrent enqueues
-- cannot both insert. Existing duplicates (from the old select-then-insert) are folded into the oldest row.
update outbox o set dispatched_at = now()
  from (select id, row_number() over (partition by queue, singleton_key order by created_at, id) as rn
          from outbox where singleton_key is not null and dispatched_at is null) d
 where o.id = d.id and d.rn > 1;
create unique index outbox_singleton_pending on outbox (queue, singleton_key)
  where singleton_key is not null and dispatched_at is null;
-- Sweeps enqueue a reminder once per key ever (dispatched rows included).
create index outbox_singleton on outbox (workspace_id, queue, singleton_key) where singleton_key is not null;

-- ───────────── Invites: one live invite per address (plan 02 §4, §5) ─────────────
update invites i set revoked_at = now()
  from (select id, row_number() over (partition by workspace_id, email order by created_at desc, id) as rn
          from invites where accepted_at is null and revoked_at is null) d
 where i.id = d.id and d.rn > 1;
create unique index invites_one_live on invites (workspace_id, email) where accepted_at is null and revoked_at is null;
