-- 0110 · Product Brain truth: customer theme sentiment, versioned prompts for the extraction and theme changes.

-- ───────────── Customer themes (standard §18) ─────────────
-- "Each theme stores signal type, recency-weighted prevalence, sentiment/intensity, sample size, trend direction,
-- SKU relevance…": sentiment is the polarity of what customers say in the theme (-1 … 1); intensity stays how
-- strongly they say it. Themes clustered before this have none.
alter table customer_themes add column sentiment numeric check (sentiment between -1 and 1);

-- The extraction prompt now reads the label's own size and names drug/sunscreen products (standard §1); the theme
-- prompt returns every matching snippet and a polarity. Both are new prompt versions (§22 versioned prompts).
update model_routes set prompt_version = 'extract-product@1.1.0' where task = 'extract.product_facts' and prompt_version = 'extract-product@1.0.0';
update model_routes set prompt_version = 'themes@1.1.0' where task = 'customer_language.themes' and prompt_version = 'themes@1.0.0';

-- ───────────── Claim evidence (standard §43) ─────────────
-- Evidence must be about this product to substantiate a product claim ("do not automatically transfer ingredient
-- evidence to product claim"), and an endorsement needs its exact wording ("Evidence and exact wording required").
-- Rows attached before this carry free-text applicability; they are not re-validated (and do not qualify).
alter table claim_evidence add column substantiated_wording text;
alter table claim_evidence add constraint claim_evidence_applicability
  check (applicability is null or applicability in ('product_specific', 'ingredient_level', 'other_formulation')) not valid;

-- ───────────── Account deletion (plan 02 §7, standard §40) ─────────────
-- "Delete user … anonymizes actor references in events (user:deleted:<hash>)". Events stay append-only: the one
-- permitted change is a user's own actor string becoming the deleted-user form, everything else identical.
create or replace function arkiv_events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.actor like 'user:%' and old.actor not like 'user:deleted:%' and new.actor like 'user:deleted:%'
     and (new.id, new.workspace_id, new.type, new.subject_type, new.subject_id, new.payload, new.schema_version, new.at)
         is not distinct from (old.id, old.workspace_id, old.type, old.subject_type, old.subject_id, old.payload, old.schema_version, old.at) then
    return new;
  end if;
  raise exception '% is append-only', tg_table_name;
end $$;
drop trigger events_append_only on events;
create trigger events_append_only before update or delete on events for each row execute function arkiv_events_guard();

-- Runs as the owner (its own RLS policy), so no pool role needs UPDATE on events.
create or replace function arkiv_anonymize_user_events(p_user uuid, p_actor text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_actor not like 'user:deleted:%' then raise exception 'invalid anonymous actor'; end if;
  update events set actor = p_actor where actor = 'user:' || p_user::text;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function arkiv_anonymize_user_events(uuid, text) from public;
grant execute on function arkiv_anonymize_user_events(uuid, text) to system_rw;
