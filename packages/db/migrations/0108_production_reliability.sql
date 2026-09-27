-- 0108 · Production reliability: customer-safe failure codes and queue ETAs, route hygiene, provider job
-- reconciliation metadata, cancellation, AI-content disclosure and a background-removal route.

-- ───────────── Customer-safe failure reasons (plan 03 P9, standard §8) ─────────────
-- The project stores a reason *code*; customer copy is mapped from it in core, so an internal error message can
-- never reach the funnel. failure_reason keeps the mapped (customer-safe) text for older readers.
alter table projects add column failure_code text;
-- Staff's estimate of when an open circuit closes again: shown to customers as the queue ETA ("Your place is held").
alter table model_routes add column circuit_until timestamptz;

-- ───────────── Model routes the code never calls (plan 05 §10) ─────────────
-- Claims are extracted with the product facts and the Visual Fingerprint is computed deterministically; the
-- whole-creative implied-claim scan has no caller yet. Routes for them made console route changes and circuit
-- toggles silently do nothing. A test keeps gateway tasks and routes 1:1.
delete from model_routes where task in ('extract.claims', 'vision.fingerprint', 'qa.implied_claims')
  and not exists (select 1 from model_routes f where f.fallback_task = model_routes.task);

-- ───────────── Provider jobs: raw response metadata and reconciliation (standard §39) ─────────────
-- "Provider request IDs, callbacks and raw provider response metadata are persisted": the provider's own
-- response envelope (request id, usage breakdown, status payload) without media bytes or signed URLs, plus the
-- planned cost line the call was priced with, so a job a crashed worker left open can be closed at its real cost.
alter table provider_jobs add column raw_meta jsonb;
-- Jobs left `dispatched` by a crashed worker are found and reconciled by provider request id.
create index provider_jobs_dispatched on provider_jobs (created_at) where status = 'dispatched';

-- ───────────── Cancellation (standard §25 retry policy, §35, §38 "cancel semantics depend on dispatch state") ─────
-- A cancel (customer, staff job cancel, or a refund of the order) that arrives while a run is producing is recorded
-- here; the run stops at its next checkpoint and settles it. Who asked and why stay with the request.
alter table projects add column cancel_requested_at timestamptz;
alter table projects add column cancel_request jsonb;

-- ───────────── AI-generated media disclosure (standard §40) ─────────────
-- Whether a scene shows people (hands, skin, faces): those people are AI-generated in generated scenes, which may
-- never speak as customers. A creative records whether it contains AI-generated media and AI-generated people, so
-- delivery shows each platform's disclosure steps and exports carry it in their metadata.
alter table scenes add column shows_human_skin boolean not null default false;
alter table creatives add column ai_generated boolean not null default false;
alter table creatives add column synthetic_people boolean not null default false;
-- The storyboard prompt now tells the Creative Director that generated people never speak as customers.
update model_routes set prompt_version = 'storyboard@1.1.0' where task = 'creative_director.storyboard' and prompt_version = 'storyboard@1.0.0';

-- ───────────── Background removal for the product cut-out (plan 06 Phase 1 #6, design M3) ─────────────
-- Decision: a Seedream image edit puts the product on a flat backdrop; the worker keys the backdrop and applies
-- the mask to the merchant's own photo, so the cut-out never carries generated pixels. Priced as one image; staff
-- route, pin or trip it like any other task. Used only when border keying can't separate the product.
insert into model_routes (task, provider, model, prompt_version) values ('vision.cutout', 'byteplus', 'seedream-5-0-pro', 'cutout@1.0.0')
  on conflict (task) do nothing;

-- ───────────── Funnel: one upload start per visitor attempt (standard §7, plan 04 §1 S2) ─────────────
-- Upload intent is recorded when the visitor first adds a photo or link (a beacon), and again when the form is
-- submitted — whichever comes first counts, once per visitor per window. app_rw may only insert funnel events,
-- so the "already recorded?" check runs here, serialized per visitor and type.
create or replace function record_funnel_once(p_type text, p_visitor text, p_window_secs int, p_workspace uuid, p_page text,
                                              p_variant text, p_utm jsonb, p_props jsonb) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if p_visitor is null then
    insert into funnel_events (type, visitor_id, workspace_id, page, variant, utm, props) values (p_type, null, p_workspace, p_page, p_variant, p_utm, coalesce(p_props, '{}'));
    return true;
  end if;
  perform pg_advisory_xact_lock(hashtext('funnel-once:' || p_type || ':' || p_visitor));
  if exists (select 1 from funnel_events where type = p_type and visitor_id = p_visitor and at > now() - make_interval(secs => p_window_secs)) then
    return false;
  end if;
  insert into funnel_events (type, visitor_id, workspace_id, page, variant, utm, props) values (p_type, p_visitor, p_workspace, p_page, p_variant, p_utm, coalesce(p_props, '{}'));
  return true;
end $$;
revoke all on function record_funnel_once from public;
grant execute on function record_funnel_once to app_rw, system_rw;
create index funnel_events_visitor_type on funnel_events (visitor_id, type, at) where visitor_id is not null;
