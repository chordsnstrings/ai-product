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

-- ───────────── Event refs (standard §36) ─────────────
-- Object IDs an event relates to (subject included), so downstream state can be rebuilt from events alone.
-- The table stays append-only: rows written before this migration keep refs '{}' and are found by subject_id.
alter table events add column refs jsonb not null default '{}';
create index events_refs on events using gin (refs jsonb_path_ops);
-- Commit order within a transaction: events of one transaction share `at` (now()), so replay orders by seq.
alter table events add column seq bigint generated always as identity;

-- ───────────── Job heartbeats (standard §39) ─────────────
-- A running production records its liveness; each heartbeat also extends its reservation, and the sweeper never
-- releases a reservation whose project heartbeat is recent.
alter table projects add column heartbeat_at timestamptz;

-- ───────────── Recommendation rationale and confidence (standard §38) ─────────────
-- "Response includes rationale IDs and confidence, not raw chain-of-thought": the packet items (customer themes,
-- learnings, approved claims, product facts) a recommendation rests on, and how much evidence stands behind it.
alter table recommendations add column rationale_ids uuid[] not null default '{}';
alter table recommendations add column confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1));
-- The concepts prompt now asks for rationale ids (§41: prompt changes are versioned).
update model_routes set prompt_version = 'concepts@1.1.0' where task = 'creative_director.concepts' and prompt_version = 'concepts@1.0.0';
update model_routes set prompt_version = 'recommendations@1.1.0' where task = 'creative_director.recommendations' and prompt_version = 'recommendations@1.0.0';

-- ───────────── Platform metrics (standard §34 "structured logs + traces + metrics") ─────────────
-- Aggregates only (no tenant identifiers), for the token-protected /api/health/metrics endpoint: queue depth,
-- dead letters, held jobs, Stripe backlog, provider calls, latency and cost.
create or replace function arkiv_platform_metrics()
returns table (name text, labels jsonb, value double precision)
language plpgsql stable security definer set search_path = public as $$
begin
  return query select 'arkiv_outbox_pending'::text, '{}'::jsonb, count(*)::double precision from outbox where dispatched_at is null;
  return query select 'arkiv_outbox_oldest_pending_seconds', '{}'::jsonb,
    coalesce(extract(epoch from now() - min(created_at)), 0)::double precision from outbox where dispatched_at is null and run_after <= now();
  return query select 'arkiv_held_jobs', '{}'::jsonb, count(*)::double precision from held_jobs where released_at is null;
  return query select 'arkiv_stripe_events', jsonb_build_object('status', status), count(*)::double precision
    from stripe_events where status in ('received','processing','unmatched','failed') group by status;
  return query select 'arkiv_provider_calls_15m', jsonb_build_object('task', task, 'status', status), count(*)::double precision
    from provider_jobs where created_at > now() - interval '15 minutes' group by task, status;
  return query select 'arkiv_provider_latency_ms_p95_1h', jsonb_build_object('task', task),
    percentile_cont(0.95) within group (order by latency_ms)::double precision
    from provider_jobs where created_at > now() - interval '1 hour' and latency_ms is not null group by task;
  return query select 'arkiv_provider_cost_micros_1h', jsonb_build_object('task', task), coalesce(sum(actual_micros), 0)::double precision
    from provider_jobs where created_at > now() - interval '1 hour' group by task;
  -- pg-boss lives in its own schema, created by the worker; absent (e.g. a fresh database) → no job metrics.
  if to_regclass('pgboss.job') is not null then
    return query execute $q$
      select 'arkiv_jobs'::text, jsonb_build_object('queue', name, 'state', state::text), count(*)::double precision
      from pgboss.job where state::text in ('created','retry','active') or (state::text = 'failed' and completed_on > now() - interval '1 hour')
      group by name, state $q$;
  end if;
end $$;
revoke all on function arkiv_platform_metrics from public;
grant execute on function arkiv_platform_metrics to app_rw, admin_rw, system_rw;
