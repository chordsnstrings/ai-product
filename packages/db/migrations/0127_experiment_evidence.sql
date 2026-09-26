-- 0127 · Experiment evidence and creative genome history (standard §19–§22, Appendix C).
-- New tables: RLS enabled + forced with explicit policies per role (arkiv_tenant_table), registered in table_registry.

-- ───────────── Comparisons (§21 "explain that more data is needed", "avoid definitive language") ─────────────
-- One reading per experiment × measurement context × attribution window × metric (rates, CPA, ROAS): its state,
-- leader, relative effect and the explanation shown to the merchant. Recomputed with the results; a comparison whose
-- data was corrected away is removed.
create table experiment_comparisons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  experiment_id uuid not null,
  measurement_context text not null,
  attribution_window text not null default 'default',
  metric text not null check (metric in ('ctr','hold_rate','cvr','cpa','roas')),
  state text not null check (state in ('GATHERING_SIGNAL','DIRECTIONAL','ACTIONABLE','INCONCLUSIVE')),
  leader_variant_id uuid,
  lift numeric,
  explanation text not null,
  computed_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, experiment_id, measurement_context, attribution_window, metric),
  foreign key (workspace_id, experiment_id) references experiments(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('experiment_comparisons'); insert into table_registry values ('experiment_comparisons', 'tenant');

-- ───────────── Recommendation mode (§20 "visible … in user explanations"; plan 03 A1 cards) ─────────────
alter table recommendations add column mode text check (mode in ('CONTROLLED','EXPLORATORY'));
update recommendations set mode = case
  when control_creative_id is not null and coalesce(proposal->>'riskProfile', '') <> 'exploratory' then 'CONTROLLED'
  when proposal->>'primaryVariable' = 'hook' and coalesce(proposal->>'riskProfile', '') <> 'exploratory' then 'CONTROLLED'
  else 'EXPLORATORY' end;

-- ───────────── Creative genome history (§19 "versioned structured genome") ─────────────
-- Every genome a creative has had, append-only: extraction, re-extraction after a taxonomy change, a remap of a
-- renamed value, or the genome of an ad we made. creatives.genome stays the current one.
create table creative_genomes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  creative_id uuid not null,
  taxonomy_version int not null,
  schema_version int,
  genome jsonb not null,
  source text not null check (source in ('extracted','reextracted','remapped','generated','derived')),
  model text,
  prompt_version text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, creative_id) references creatives(workspace_id, id) on delete cascade on update cascade
);
create index on creative_genomes (workspace_id, creative_id, created_at desc);
select arkiv_tenant_table('creative_genomes', append_only => true); insert into table_registry values ('creative_genomes', 'tenant');

-- History is never edited: only the workspace may move with its creative (provisional preview merged into an account).
create or replace function arkiv_creative_genome_guard() returns trigger language plpgsql as $$
begin
  if (new.id, new.creative_id, new.taxonomy_version, new.schema_version, new.genome, new.source, new.model, new.prompt_version, new.created_at)
     is distinct from
     (old.id, old.creative_id, old.taxonomy_version, old.schema_version, old.genome, old.source, old.model, old.prompt_version, old.created_at) then
    raise exception 'creative_genomes is append-only' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger creative_genomes_guard before update on creative_genomes for each row execute function arkiv_creative_genome_guard();

-- The genomes that exist today are each creative's first history row.
insert into creative_genomes (workspace_id, creative_id, taxonomy_version, schema_version, genome, source, model, prompt_version, created_at)
select c.workspace_id, c.id, coalesce(c.genome_version, 1), nullif(c.genome->>'schemaVersion', '')::int, c.genome,
       case c.origin when 'imported' then 'extracted' else 'generated' end,
       null, c.genome #>> '{lineage,promptVersions,genome}', c.created_at
from creatives c where c.genome is not null;
