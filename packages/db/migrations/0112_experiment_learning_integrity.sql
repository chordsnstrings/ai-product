-- 0112 · Experiment engine and learning integrity (standard §20, §21, §30, §35, §36).

-- ───────────── Experiment approval (§35 DRAFT → RECOMMENDED → APPROVED → PRODUCING) ─────────────
-- Accepting a recommendation no longer approves spend: the merchant's approval is its own evented step.
alter table experiments add column approved_at timestamptz;
update experiments set approved_at = updated_at where approved_by is not null and approved_at is null;

-- ───────────── Results per attribution window (§30: never pool different measurement bases) ─────────────
-- A 7-day-click and a 1-day-view reading of the same ad are different measurements: each window gets its own
-- comparison instead of being summed into one.
alter table experiment_results add column attribution_window text not null default 'default';
alter table experiment_results drop constraint experiment_results_workspace_id_experiment_id_variant_id_me_key;
alter table experiment_results add constraint experiment_results_window_key
  unique (workspace_id, experiment_id, variant_id, measurement_context, attribution_window, metric);

-- ───────────── What a learning is about (§20 "never pretend it identified which variable caused the result") ──
-- variable: the dimension the compared variants actually differed on (a hook comparison, or master vs control on
-- the declared variable). winner_genes / loser_genes: the values of that dimension that won and lost, so later
-- experiments and recommendations can match the learning by the genes it is about. effect: the shrunk lift of
-- the winner over the runner-up (posterior means, so tiny samples cannot produce a large effect).
alter table learnings add column variable text;
alter table learnings add column winner_genes jsonb not null default '{}';
alter table learnings add column loser_genes jsonb not null default '{}';
alter table learnings add column effect numeric;
alter table learnings add column attribution_window text not null default 'default';
-- Pre-existing learnings compared hook variants (every experiment so far varied only the hook).
update learnings set variable = 'hook', winner_genes = jsonb_build_object('hook', relevant_genes->>'hook')
  where variable is null and relevant_genes ? 'hook';

-- ───────────── Variant codes are unique per workspace (§30 observations attribute to the right variant) ─────────
-- Codes used to restart at A for every experiment on a SKU, so a second experiment reused the first one's codes
-- and ads could link to the wrong experiment. Existing duplicates are re-coded (the oldest experiment keeps its
-- codes; later ones get their sequence number, AK-014-2A), then uniqueness is enforced.
with ranked as (
  select v.id, v.code, e.sku_id, v.workspace_id,
         dense_rank() over (partition by v.workspace_id, e.sku_id order by e.created_at, e.id) as seq
  from variants v join experiments e on e.id = v.experiment_id and e.workspace_id = v.workspace_id
)
update variants v set code = regexp_replace(r.code, '^(AK-\d+-)([A-Z])$', '\1' || r.seq || '\2')
  from ranked r
  where v.id = r.id and r.seq > 1 and r.code ~ '^AK-\d+-[A-Z]$';
create unique index variants_workspace_code on variants (workspace_id, code);

-- ───────────── Gated recommendation candidates (§20 "hard gates happen before scoring") ─────────────
-- A candidate a hard gate refused (a blocked claim in its strategy, a hook the claims scan removed…) is kept with
-- its gate reasons for staff review, never shown to the merchant and never scored above zero.
alter table recommendations drop constraint recommendations_status_check;
alter table recommendations add constraint recommendations_status_check check (status in ('open','accepted','dismissed','expired','gated'));

-- ───────────── Grounding prompts (standard §16 Brand Brain, §18 customer phrases) ─────────────
-- concepts / recommendations / storyboard 1.2.0 receive representative customer phrases as an untrusted part and
-- spell out the Brand Brain rules (product facts win over brand guidance).
update model_routes set prompt_version = 'concepts@1.2.0' where task = 'creative_director.concepts' and prompt_version in ('concepts@1.0.0', 'concepts@1.1.0');
update model_routes set prompt_version = 'recommendations@1.2.0' where task = 'creative_director.recommendations' and prompt_version in ('recommendations@1.0.0', 'recommendations@1.1.0');
update model_routes set prompt_version = 'storyboard@1.2.0' where task = 'creative_director.storyboard' and prompt_version in ('storyboard@1.0.0', 'storyboard@1.1.0');
