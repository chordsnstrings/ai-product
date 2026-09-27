-- 0126 · Product Brain, Visual Fingerprint, Brand Brain and Claims Vault depth (standard §15–§17, §19, §42).
-- New tables: RLS enabled + forced with explicit policies per role (arkiv_tenant_table), registered in table_registry.

-- ───────────── ProductFact.brand_id (standard §16 "id, workspace_id, brand_id, sku_id …") ─────────────
-- Every SKU belongs to a brand: SKUs created without one (store sync, provisional moves) get the workspace's first.
update skus s set brand_id = (select b.id from brands b where b.workspace_id = s.workspace_id order by b.created_at limit 1)
where s.brand_id is null and exists (select 1 from brands b where b.workspace_id = s.workspace_id);

alter table product_facts add column brand_id uuid;
alter table product_facts add constraint product_facts_brand_fk foreign key (workspace_id, brand_id) references brands(workspace_id, id);
-- brand_id is not part of the observation (arkiv_product_fact_guard): it follows the SKU's brand.
update product_facts f set brand_id = s.brand_id from skus s where s.id = f.sku_id and s.workspace_id = f.workspace_id and s.brand_id is not null;
create index on product_facts (workspace_id, brand_id, normalized_key) where status <> 'SUPERSEDED';

-- A preview's SKUs move into the account with the account's brand (their facts follow): the provisional brand stays
-- behind, so the facts' brand is cleared before the workspace moves and set to the new brand after.
create or replace function move_provisional_skus(p_from uuid, p_to uuid, p_user uuid) returns integer
language plpgsql volatile security definer set search_path = public as $$
declare v_state text; v_role text; s record; v_no int; v_brand uuid; n int := 0;
begin
  if p_from = p_to then raise exception 'nothing to move' using errcode = 'P0002'; end if;
  select m.role into v_role from memberships m join workspaces w on w.id = m.workspace_id
   where m.workspace_id = p_to and m.user_id = p_user and w.state not in ('PROVISIONAL', 'PURGE_SCHEDULED', 'PURGED');
  if v_role is null or v_role not in ('OWNER', 'ADMIN', 'MEMBER') then raise exception 'forbidden' using errcode = '42501'; end if;
  select state into v_state from workspaces where id = p_from for update;
  if v_state is distinct from 'PROVISIONAL' then raise exception 'nothing to move' using errcode = 'P0002'; end if;
  select id into v_brand from brands where workspace_id = p_to order by created_at limit 1;
  for s in select id from skus where workspace_id = p_from order by catalogue_no loop
    update workspaces set next_catalogue_no = next_catalogue_no + 1 where id = p_to returning next_catalogue_no - 1 into v_no;
    update product_facts set brand_id = null where sku_id = s.id and workspace_id = p_from;
    update skus set brand_id = null where id = s.id;
    update skus set workspace_id = p_to, catalogue_no = v_no, brand_id = v_brand where id = s.id;
    update product_facts set brand_id = v_brand where sku_id = s.id and workspace_id = p_to;
    n := n + 1;
  end loop;
  update workspaces set state = 'PURGE_SCHEDULED', purge_at = now() + interval '1 hour', provisional_token_hash = null where id = p_from;
  return n;
end $$;
revoke all on function move_provisional_skus(uuid, uuid, uuid) from public;
grant execute on function move_provisional_skus(uuid, uuid, uuid) to app_rw, system_rw;

-- ───────────── Claims: one claim per meaning (standard §17 canonical_meaning, preferred_wording) ─────────────
-- The same claim read from the page and from the label ("24h hydration" / "hydrates for 24 hours") is one claim
-- with one status; the other wordings it was found in are kept with it.
alter table claims add column alt_wordings text[] not null default '{}';
create index on claims (workspace_id, sku_id, canonical_meaning);

-- ───────────── Claim decision history (standard §15 "decision history must remain auditable") ─────────────
-- Every change of a claim's wording, status, scope or qualifier is a new immutable version, whichever path made it
-- (merchant, staff console, compliance review, evidence-expiry sweep), so a creative can be traced to the claim
-- version it used. Written by the claims trigger below; the writer names the change, reason and actor through
-- transaction-local settings (arkiv.claim_change / arkiv.claim_reason / arkiv.claim_actor).
create table claim_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  claim_id uuid not null,
  version int not null,
  status text not null,
  preferred_wording text not null,
  alt_wordings text[] not null default '{}',
  mandatory_qualifier text,
  allowed_markets text[] not null,
  allowed_platforms text[] not null,
  merchant_approved boolean not null,
  block_reason text,
  compliance_note text,
  change text not null,
  reason text,
  actor text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (claim_id, version),
  foreign key (workspace_id, claim_id) references claims(workspace_id, id) on delete cascade on update cascade
);
create index on claim_versions (workspace_id, claim_id, version desc);
select arkiv_tenant_table('claim_versions', append_only => true); insert into table_registry values ('claim_versions', 'tenant');

-- History is never edited: only the workspace may move with its SKU (provisional preview merged into an account).
create or replace function arkiv_claim_version_guard() returns trigger language plpgsql as $$
begin
  if (new.id, new.claim_id, new.version, new.status, new.preferred_wording, new.alt_wordings, new.mandatory_qualifier, new.allowed_markets,
      new.allowed_platforms, new.merchant_approved, new.block_reason, new.compliance_note, new.change, new.reason, new.actor, new.created_at)
     is distinct from
     (old.id, old.claim_id, old.version, old.status, old.preferred_wording, old.alt_wordings, old.mandatory_qualifier, old.allowed_markets,
      old.allowed_platforms, old.merchant_approved, old.block_reason, old.compliance_note, old.change, old.reason, old.actor, old.created_at) then
    raise exception 'claim_versions is append-only' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger claim_versions_guard before update on claim_versions for each row execute function arkiv_claim_version_guard();

create or replace function arkiv_claim_version() returns trigger language plpgsql as $$
declare v int;
begin
  if tg_op = 'UPDATE' and (new.status, new.preferred_wording, new.alt_wordings, new.mandatory_qualifier, new.allowed_markets, new.allowed_platforms,
                           new.merchant_approved, new.block_reason, new.compliance_note)
       is not distinct from (old.status, old.preferred_wording, old.alt_wordings, old.mandatory_qualifier, old.allowed_markets, old.allowed_platforms,
                             old.merchant_approved, old.block_reason, old.compliance_note) then
    return new;
  end if;
  select coalesce(max(version), 0) + 1 into v from claim_versions where claim_id = new.id and workspace_id = new.workspace_id;
  insert into claim_versions (workspace_id, claim_id, version, status, preferred_wording, alt_wordings, mandatory_qualifier, allowed_markets,
                              allowed_platforms, merchant_approved, block_reason, compliance_note, change, reason, actor)
  values (new.workspace_id, new.id, v, new.status, new.preferred_wording, new.alt_wordings, new.mandatory_qualifier, new.allowed_markets,
          new.allowed_platforms, new.merchant_approved, new.block_reason, new.compliance_note,
          coalesce(nullif(current_setting('arkiv.claim_change', true), ''), case when tg_op = 'INSERT' then 'created' else 'updated' end),
          nullif(current_setting('arkiv.claim_reason', true), ''),
          coalesce(nullif(current_setting('arkiv.claim_actor', true), ''), new.approved_by, 'system'));
  return new;
end $$;
create trigger claims_versioned after insert or update on claims for each row execute function arkiv_claim_version();

-- Claims made before this start their history at their current state.
insert into claim_versions (workspace_id, claim_id, version, status, preferred_wording, alt_wordings, mandatory_qualifier, allowed_markets,
                            allowed_platforms, merchant_approved, block_reason, compliance_note, change, reason, actor, created_at)
select workspace_id, id, 1, status, preferred_wording, alt_wordings, mandatory_qualifier, allowed_markets, allowed_platforms, merchant_approved,
       block_reason, compliance_note, 'backfill', 'history starts here', coalesce(approved_by, 'system:migration'), coalesce(reviewed_at, created_at)
from claims;

-- ───────────── Visual Fingerprint (standard §16) ─────────────
-- "approved front/side/back views, label crops, … package type and geometry, … critical regions": each reference
-- photo's view, the merchant-approved views, the label crop and the package geometry; `reason` says why a version was
-- made (first analysis, added views, packaging refresh).
alter table visual_fingerprints add column views jsonb not null default '{}';
alter table visual_fingerprints add column approved_view_ids uuid[] not null default '{}';
alter table visual_fingerprints add column label_crop_asset_id uuid;
alter table visual_fingerprints add column geometry jsonb not null default '{}';
alter table visual_fingerprints add column reason text;

-- §42 "Packaging refresh — historical creatives remain tied to prior packaging": the fingerprint version a storyboard
-- was drawn for, each scene attempt was checked against and each creative was made with.
alter table storyboards add column visual_fingerprint_id uuid;
alter table scene_versions add column visual_fingerprint_id uuid;
alter table creatives add column visual_fingerprint_id uuid;

-- Brand Brain visual references (standard §16 "visual references") are brand assets, not a SKU's.
alter table assets drop constraint assets_kind_check;
alter table assets add constraint assets_kind_check check (kind in ('product_photo','cutout','reference_view','label_crop','storyboard_frame',
  'scene_render','voiceover','final_export','creator_footage','evidence_doc','brand_logo','brand_reference','historical_creative','thumbnail','captions'));

-- ───────────── Prompt versions (§41 "prompt changes are software changes") ─────────────
-- extract-product@1.3.0: each photo's view, label/closure boxes, package geometry, usage directions and each claim's
-- canonical meaning. genome@1.1.0: the full Creative Genome families (strategy, hook, body, production, compliance).
update model_routes set prompt_version = 'extract-product@1.3.0' where task = 'extract.product_facts' and prompt_version in ('extract-product@1.0.0', 'extract-product@1.1.0', 'extract-product@1.2.0');
update model_routes set prompt_version = 'genome@1.1.0' where task = 'genome.extract' and prompt_version = 'genome@1.0.0';
