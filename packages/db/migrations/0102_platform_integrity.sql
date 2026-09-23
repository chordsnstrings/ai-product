-- 0102 · Platform integrity: lifecycle restore, Brand Brain versions, claim scope normalisation, learning
-- revision, production resume/outage bookkeeping, and RLS for global tables that carry tenant rows.

-- ───────────── Workspace lifecycle (plan 02 §2, §7) ─────────────
-- Cancelling a scheduled deletion returns the workspace to the state it had before (not always CANCELLED).
alter table workspaces add column state_before_purge text check (state_before_purge in
  ('PROVISIONAL','ACTIVE_FREE','ACTIVE_PAID','PAST_DUE','CANCELLED'));
