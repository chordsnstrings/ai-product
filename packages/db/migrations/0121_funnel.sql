-- 0121: funnel surfaces (plan 03 P2–P10, standard §8, §13, §26). Columns on existing tenant tables only unless
-- noted; new tables are registered with forced RLS below.

-- §8 "The user can choose a goal such as sell the product, UGC-style review, explain the product or premium
-- creative, but the system should default to performance-oriented recommendations."
alter table projects
  add column goal text not null default 'performance' check (goal in ('performance', 'ugc_review', 'explainer', 'premium'));

-- Plan 03 P10 "Not right?" (standard §48 "Customer hates first render: diagnose whether strategy, fidelity or
-- execution failed; preserve storyboard and re-plan"): the diagnosis goes in project_feedback (0114); the re-plan
-- is a new project (projects.revision_of). At most one free re-plan per delivered ad, and only for fidelity.
alter table projects add column revision_free boolean not null default false;
create unique index projects_one_free_revision on projects (workspace_id, revision_of) where revision_free;
create index project_feedback_recent on project_feedback (created_at desc);
