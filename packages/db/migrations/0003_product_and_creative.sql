-- 0003 · Product Brain, Claims Vault, Customer Language, Creative, Projects, Storyboards, Experiments.
-- Parents expose unique (workspace_id, id) and children use composite FKs, so rows can never be linked
-- across tenants even through a bug (plan 02 §3 layer 3).

create table brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  brain jsonb not null default '{}',   -- logo asset, colors, fonts, tone, prohibited aesthetics, disclosures, CTA vocab
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
select arkiv_tenant_table('brands'); insert into table_registry values ('brands','tenant');

create table uploads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null,
  status text not null default 'pending' check (status in ('pending','quarantined','accepted','rejected')),
  quarantine_key text not null,
  declared_mime text,
  bytes bigint,
  reject_reason text,
  asset_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);
select arkiv_tenant_table('uploads'); insert into table_registry values ('uploads','tenant');

create table skus (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid,
  catalogue_no int not null,
  name text not null default 'Untitled product',
  status text not null default 'analyzing' check (status in ('analyzing','active','out_of_stock','archived','rejected')),
  reject_reason text,
  category text,
  source_url text,
  source_kind text check (source_kind in ('url','photos','shopify','manual')),
  shopify_product_id text,
  maturity text not null default 'COLD' check (maturity in ('COLD','DEVELOPING','MATURE')),
  fidelity_confidence numeric,
  analysis jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, catalogue_no),
  foreign key (workspace_id, brand_id) references brands(workspace_id, id)
);
create trigger skus_touch before update on skus for each row execute function arkiv_touch_updated_at();
select arkiv_tenant_table('skus'); insert into table_registry values ('skus','tenant');

create table assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  sku_id uuid,
  kind text not null check (kind in ('product_photo','cutout','reference_view','label_crop','storyboard_frame',
    'scene_render','voiceover','final_export','creator_footage','evidence_doc','brand_logo','historical_creative','thumbnail')),
  storage_key text not null unique,
  mime text not null,
  bytes bigint not null,
  width int, height int, duration_ms int,
  checksum_sha256 text not null,
  source text not null check (source in ('upload','generated','import','composed')),
  rights_attested_by uuid,
  rights_attested_at timestamptz,
  rights_expires_at timestamptz,
  origin jsonb not null default '{}',
  lineage jsonb not null default '{}',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
create index on assets (workspace_id, sku_id, kind);
select arkiv_tenant_table('assets'); insert into table_registry values ('assets','tenant');

-- ProductFact (§16). Raw observations are never edited: corrections insert DECIDED facts that supersede.
create table product_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  fact_type text not null,
  normalized_key text not null,
  value_text text, value_number numeric, value_json jsonb,
  source_type text not null check (source_type in ('product_page','json_ld','shopify','photo_ocr','vision','merchant','staff','import')),
  source_id text, source_url text,
  observed_at timestamptz not null default now(),
  confidence numeric not null default 1,
  merchant_confirmed boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  supersedes_fact_id uuid,
  state text not null check (state in ('OBSERVED','INFERRED','DECIDED')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUPERSEDED','DISPUTED')),
  created_by text not null,
  unique (workspace_id, id),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
create index on product_facts (workspace_id, sku_id, normalized_key) where status <> 'SUPERSEDED';
select arkiv_tenant_table('product_facts'); insert into table_registry values ('product_facts','tenant');

create table visual_fingerprints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  version int not null,
  active boolean not null default true,
  reference_asset_ids uuid[] not null default '{}',
  cutout_asset_id uuid,
  label_text text,
  brand_text text,
  package_type text,
  closure text,
  dominant_colors jsonb not null default '[]',
  liquid_color text,
  transparency text,
  critical_regions jsonb not null default '[]',
  thresholds jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (workspace_id, sku_id, version),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('visual_fingerprints'); insert into table_registry values ('visual_fingerprints','tenant');

-- Claims Vault (§17).
create table claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  canonical_meaning text not null,
  preferred_wording text not null,
  claim_category text not null,
  risk_level text not null check (risk_level in ('low','medium','high','prohibited')),
  status text not null check (status in ('VERIFIED','VERIFIED_WITH_QUALIFIER','MERCHANT_REVIEW_REQUIRED','RESTRICTED','BLOCKED','INFERRED_ONLY')),
  allowed_markets text[] not null default '{US}',
  allowed_platforms text[] not null default '{TIKTOK,INSTAGRAM_REELS,FACEBOOK_FEED}',
  mandatory_qualifier text,
  merchant_approved boolean not null default false,
  approved_by text,
  reviewed_at timestamptz,
  origin text not null check (origin in ('extracted','merchant','staff','review_signal')),
  source_text text,
  block_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
create trigger claims_touch before update on claims for each row execute function arkiv_touch_updated_at();
select arkiv_tenant_table('claims'); insert into table_registry values ('claims','tenant');

create table claim_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  claim_id uuid not null,
  evidence_type text not null,
  source_asset_id uuid,
  source_location text,
  supplied_by text not null,
  applicability text,
  evidence_strength text check (evidence_strength in ('weak','moderate','strong')),
  expiry_date date,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, claim_id) references claims(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('claim_evidence'); insert into table_registry values ('claim_evidence','tenant');

-- Customer Language Engine (§18). Raw signals are never rewritten.
create table customer_signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  source text not null check (source in ('review','qa','comment','support','survey','page')),
  source_ref text,
  text text not null,
  rating numeric,
  author_hash text,
  observed_at timestamptz,
  imported_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('customer_signals'); insert into table_registry values ('customer_signals','tenant');

create table customer_themes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  label text not null,
  signal_type text not null check (signal_type in ('objection','benefit','question','usage','sentiment')),
  prevalence numeric not null,
  intensity numeric not null,
  sample_size int not null,
  trend text not null default 'flat' check (trend in ('rising','flat','falling')),
  relevance numeric not null default 1,
  snippet_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('customer_themes'); insert into table_registry values ('customer_themes','tenant');

-- Creatives (historical, generated, creator) with genome (§19).
create table creatives (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  secondary_sku_ids uuid[] not null default '{}',
  origin text not null check (origin in ('generated','imported','creator')),
  parent_creative_id uuid,
  project_id uuid,
  platform_refs jsonb not null default '{}',
  genome jsonb,
  genome_version int,
  final_asset_ids uuid[] not null default '{}',
  content_hash text,
  source_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('creatives'); insert into table_registry values ('creatives','tenant');

-- Experiments (§20).
create table experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  hypothesis text not null,
  rationale text,
  primary_variable text not null,
  controlled_variables text[] not null default '{}',
  control_variant_id uuid,
  primary_metric text not null default 'ctr',
  leading_metrics text[] not null default '{hold_rate,cvr}',
  expected_learning text,
  if_test_fails text,
  mode text not null check (mode in ('CONTROLLED','EXPLORATORY')),
  state text not null default 'DRAFT' check (state in ('DRAFT','RECOMMENDED','APPROVED','PRODUCING','READY_TO_RUN',
    'GATHERING_SIGNAL','DIRECTIONAL','ACTIONABLE','ARCHIVED','INCONCLUSIVE','INVALIDATED','OPERATIONALLY_CONFOUNDED')),
  portfolio_slot text check (portfolio_slot in ('EXPLOIT','EXPAND','EXPLORE')),
  recommendation_id uuid,
  genes jsonb not null default '{}',
  created_by text not null,
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
create trigger experiments_touch before update on experiments for each row execute function arkiv_touch_updated_at();
select arkiv_tenant_table('experiments'); insert into table_registry values ('experiments','tenant');

create table variants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  experiment_id uuid not null,
  label text not null,
  role text not null check (role in ('control','variant')),
  creative_id uuid,
  project_id uuid,
  changed_variables text[] not null default '{}',
  held_constant text[] not null default '{}',
  genes jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, experiment_id) references experiments(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('variants'); insert into table_registry values ('variants','tenant');

-- Creative projects follow the §35 state machine.
create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  experiment_id uuid,
  variant_id uuid,
  kind text not null check (kind in ('preview','taste','standalone','creative_test')),
  state text not null default 'PRODUCT_UPLOADED' check (state in ('PRODUCT_UPLOADED','PRODUCT_ANALYZED','BRIEF_READY',
    'CONCEPTS_READY','CONCEPT_SELECTED','STORYBOARD_READY','STORYBOARD_APPROVED','RENDER_RESERVED','RENDERING','QA_RUNNING',
    'COMPOSING','PLATFORM_VARIANTS','FINAL_QA','COMPLETE','NEEDS_USER_ACTION','BLOCKED_COMPLIANCE','PROVIDER_FAILED',
    'REFUNDED','CANCELLED')),
  state_version int not null default 1,
  selected_concept_id uuid,
  storyboard_id uuid,
  purchase_id uuid,
  authorization_id uuid,
  final_creative_id uuid,
  failure_reason text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
create trigger projects_touch before update on projects for each row execute function arkiv_touch_updated_at();
select arkiv_tenant_table('projects'); insert into table_registry values ('projects','tenant');

create table concepts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  project_id uuid not null,
  batch int not null default 1,
  idx text not null check (idx in ('A','B','C')),
  proposal jsonb not null,
  is_pick boolean not null default false,
  pick_reason text,
  gate_results jsonb not null default '{}',
  prompt_version text not null,
  model text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, project_id, batch, idx),
  foreign key (workspace_id, project_id) references projects(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('concepts'); insert into table_registry values ('concepts','tenant');

create table storyboards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  concept_id uuid not null,
  version int not null default 1,
  status text not null default 'generating' check (status in ('generating','ready','approved','superseded','failed')),
  total_ms int not null default 15000,
  hook_text text,
  cta_text text,
  approved_at timestamptz,
  approved_by text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references projects(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('storyboards'); insert into table_registry values ('storyboards','tenant');

create table scenes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  storyboard_id uuid not null,
  position int not null,
  purpose text not null,
  duration_ms int not null,
  visual_plan text not null,
  product_behavior text,
  spoken_line text,
  overlay_text text,
  claim_ids uuid[] not null default '{}',
  source_asset_ids uuid[] not null default '{}',
  production_mode text not null check (production_mode in ('STRICT_COMPOSITE','GENERATIVE_INTERACTION','HYBRID','REAL_ASSET_REMIX','CREATOR_PACK')),
  locked boolean not null default false,
  current_version_id uuid,
  free_regenerations_used int not null default 0,
  unique (workspace_id, id),
  unique (workspace_id, storyboard_id, position),
  foreign key (workspace_id, storyboard_id) references storyboards(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('scenes'); insert into table_registry values ('scenes','tenant');

create table scene_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  scene_id uuid not null,
  version int not null,
  kind text not null check (kind in ('frame','render')),
  asset_id uuid,
  prompt_version text,
  model text,
  technique text,
  cost_micros bigint not null default 0,
  qa jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','succeeded','failed','qa_failed','accepted')),
  created_at timestamptz not null default now(),
  unique (workspace_id, scene_id, kind, version),
  foreign key (workspace_id, scene_id) references scenes(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('scene_versions'); insert into table_registry values ('scene_versions','tenant');

-- Recommendations (§20) and Creator Packs (§26).
create table recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  sku_id uuid not null,
  week_of date not null,
  slot text not null check (slot in ('EXPLOIT','EXPAND','EXPLORE')),
  proposal jsonb not null,
  score numeric not null,
  score_breakdown jsonb not null,
  gates jsonb not null default '{}',
  basis text not null check (basis in ('performance','context_limited','cold_start')),
  status text not null default 'open' check (status in ('open','accepted','dismissed','expired')),
  dismiss_reason text,
  experiment_id uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, sku_id) references skus(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('recommendations'); insert into table_registry values ('recommendations','tenant');

create table creator_packs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  experiment_id uuid not null,
  content jsonb not null,
  share_token_hash text unique,
  expires_at timestamptz,
  revoked_at timestamptz,
  views int not null default 0,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, experiment_id) references experiments(workspace_id, id) on delete cascade on update cascade
);
select arkiv_tenant_table('creator_packs'); insert into table_registry values ('creator_packs','tenant');

create or replace function find_creator_pack(p_token_hash text)
returns table (id uuid, workspace_id uuid, content jsonb, expires_at timestamptz, revoked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select id, workspace_id, content, expires_at, revoked_at from creator_packs where share_token_hash = p_token_hash
$$;
revoke all on function find_creator_pack from public;
grant execute on function find_creator_pack to app_rw;
