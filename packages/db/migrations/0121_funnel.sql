-- 0121: funnel surfaces (plan 03 P2–P10, standard §8, §13, §26). Columns on existing tenant tables only unless
-- noted; new tables are registered with forced RLS below.

-- §8 "The user can choose a goal such as sell the product, UGC-style review, explain the product or premium
-- creative, but the system should default to performance-oriented recommendations."
alter table projects
  add column goal text not null default 'performance' check (goal in ('performance', 'ugc_review', 'explainer', 'premium'));
