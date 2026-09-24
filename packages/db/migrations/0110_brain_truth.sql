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
