-- 0104 · Production integrity: approved fallback routes, scene-version lineage and input hashes, and the
-- composition manifest a creative was assembled from.

-- ───────────── Approved fallback routes (standard §34 Voice, §44 provider outage; plan 05 §10) ─────────────
-- When a route's provider fails or its circuit is open, the gateway may use the route named here — with its own
-- provider job, rate line and wire model — instead of pausing. Only routes staff approved as a fallback.
alter table model_routes add column fallback_task text references model_routes(task) on update cascade on delete set null;
alter table model_routes add constraint model_routes_fallback_not_self check (fallback_task is null or fallback_task <> task);
update model_routes set fallback_task = 'tts.voiceover_fallback'
  where task = 'tts.voiceover' and exists (select 1 from model_routes f where f.task = 'tts.voiceover_fallback');

-- Product-free environment plates for strict product composites (§23 "generate environment/hands separately
-- where possible"). Same image route as storyboard frames until staff route it separately.
insert into model_routes (task, provider, model, prompt_version)
  select 'image.environment_plate', provider, model, 'plate@1.0.0' from model_routes where task = 'image.storyboard_frame'
  on conflict (task) do nothing;

-- ───────────── Scene versions (standard §24, §41) ─────────────
-- Lineage of each version (cutout / plate / render inputs) and, for renders, a hash of the inputs that produced
-- it: a retry reuses an accepted render whose inputs are unchanged instead of paying for it again (§35).
alter table scene_versions add column lineage jsonb not null default '{}';
alter table scene_versions add column input_hash text;
create index scene_versions_input_hash on scene_versions (workspace_id, scene_id, input_hash) where kind = 'render';

-- ───────────── Composition manifest (standard §24 "composition is reproducible from scene versions") ─────────
-- What a creative was assembled from: scene versions, on-screen and spoken text per scene, voice-over segments,
-- end card and exports. Hook variants reuse the master's manifest and experiment-integrity QA diffs them.
alter table creatives add column composition jsonb;
