-- 0123 · Platform edges (standard §48, plan 06 Phase 0).

-- Product-fidelity inspector 1.2.0: checks the product's own colour and flags people who may appear under 18
-- (standard §48 "shade materially altered", "synthetic talent appears under 18"). A route staff moved elsewhere
-- (a rollback or another version) is left alone.
update model_routes set prompt_version = 'fidelity@1.2.0' where task = 'qa.fidelity' and prompt_version = 'fidelity@1.1.0';
