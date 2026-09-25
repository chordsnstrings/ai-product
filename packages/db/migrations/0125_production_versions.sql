-- Production versions and QA records (standard §24 scene model, §25 QA, plan 06 Phase 3 #6).

-- §25.3: qa_report.impliedClaims is the array of implied-claim flags the compliance queue lists. Rows written while
-- it held the whole scan object keep their flags.
update projects
   set qa_report = jsonb_set(qa_report, '{impliedClaims}', coalesce(qa_report->'impliedClaims'->'impliedClaims', '[]'::jsonb))
 where jsonb_typeof(qa_report->'impliedClaims') = 'object';

-- Plan 06 Phase 3 #6 "captions (burned-in + SRT)": the SRT of a finished ad is its own downloadable asset.
alter table assets drop constraint assets_kind_check;
alter table assets add constraint assets_kind_check check (kind in ('product_photo','cutout','reference_view','label_crop','storyboard_frame',
  'scene_render','voiceover','final_export','creator_footage','evidence_doc','brand_logo','historical_creative','thumbnail','captions'));
alter table creatives add column captions_asset_id uuid;

-- §24 "independently versioned scenes": a 'script' version records a scene's words, timing and visual plan each
-- time they change (edits, frame redraws, post-delivery text edits), so a composition is reproducible from versions.
alter table scene_versions drop constraint scene_versions_kind_check;
alter table scene_versions add constraint scene_versions_kind_check check (kind in ('frame','render','script'));
alter table scene_versions add column script jsonb;

-- §24 scene fields: the model and prompt version the storyboard was planned with, and per-scene approval state.
alter table storyboards add column prompt_version text;
alter table storyboards add column model text;
alter table scenes add column approved_at timestamptz;
alter table scenes add column approved_by text;
