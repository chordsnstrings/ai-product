-- 0116 · Production truth: variant platform assets, the Production Planner's per-scene record, whole-creative
-- implied-claim and continuity QA routes, and Creator Packs.

-- ───────────── Variant.platform_assets[] (standard §20) ─────────────
-- Each finished variant lists its export per platform placement: [{platform, aspect, assetId}] — TikTok and Reels
-- use the 9:16 export, the Facebook/Instagram feed the 4:5 and the 1:1.
alter table variants add column platform_assets jsonb not null default '[]';

-- ───────────── Production Planner record per scene (standard §23, §24) ─────────────
-- The planner decides each scene's medium from the product and the plan; why, and what the scene is planned to
-- cost, are kept with the scene so the merchant sees them before approving and nothing is downgraded silently.
alter table scenes add column planner_reason text;
alter table scenes add column estimate_micros bigint;

-- ───────────── Whole-creative QA routes (standard §25 check 2–3, §43, §44, §48) ─────────────
-- The implied-claim scan now runs on every finished ad (words and pictures together), and generated people are
-- checked for continuity across scenes. Both are billable model calls, so they have routes (and circuits).
insert into model_routes (task, provider, model, prompt_version) values
  ('qa.implied_claims', 'anthropic', 'claude-opus-5-5', 'implied-claims@1.1.0'),
  ('qa.continuity', 'anthropic', 'claude-opus-5-5', 'continuity@1.0.0')
on conflict (task) do update set prompt_version = excluded.prompt_version;
