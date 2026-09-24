-- 0123 · Platform edges (standard §48, plan 06 Phase 0).

-- Product-fidelity inspector 1.2.0: checks the product's own colour and flags people who may appear under 18
-- (standard §48 "shade materially altered", "synthetic talent appears under 18"). A route staff moved elsewhere
-- (a rollback or another version) is left alone.
update model_routes set prompt_version = 'fidelity@1.2.0' where task = 'qa.fidelity' and prompt_version = 'fidelity@1.1.0';

-- Organic and affiliate delivery the merchant imports gets its own measurement contexts (standard §48 "organic or
-- affiliate creative has no paid-spend context": separate context, not interchangeable with paid CPA/ROAS).
alter table performance_observations drop constraint performance_observations_measurement_context_check;
alter table performance_observations add constraint performance_observations_measurement_context_check
  check (measurement_context in ('META_PAID_ATTRIBUTED', 'TIKTOK_PAID_ATTRIBUTED', 'TIKTOK_GMV_MAX_TOTAL', 'SHOPIFY_BLENDED_ORDER',
                                 'MERCHANT_IMPORTED_META', 'MERCHANT_IMPORTED_TIKTOK',
                                 'META_ORGANIC', 'TIKTOK_ORGANIC', 'META_AFFILIATE', 'TIKTOK_AFFILIATE'));

-- Provider version drift goes through the regression policy (standard §48 "route changed versions through
-- regression/canary policy before becoming default"): the gateway queues the route's golden-set eval as the system
-- (no staff requester), and a route whose drift policy is 'hold' stops dispatching until staff re-pin it.
alter table model_routes add column drift_policy text not null default 'alert' check (drift_policy in ('alert', 'hold'));
alter table eval_runs alter column created_by drop not null;
alter table ops_commands alter column requested_by drop not null;
grant insert on eval_runs, ops_commands to system_rw;
