-- 0116 · Production truth: variant platform assets, the Production Planner's per-scene record, whole-creative
-- implied-claim and continuity QA routes, and Creator Packs.

-- ───────────── Variant.platform_assets[] (standard §20) ─────────────
-- Each finished variant lists its export per platform placement: [{platform, aspect, assetId}] — TikTok and Reels
-- use the 9:16 export, the Facebook/Instagram feed the 4:5 and the 1:1.
alter table variants add column platform_assets jsonb not null default '[]';
