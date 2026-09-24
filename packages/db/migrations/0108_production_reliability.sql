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
