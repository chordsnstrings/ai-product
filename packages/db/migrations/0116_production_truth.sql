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
