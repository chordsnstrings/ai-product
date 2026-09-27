-- 0130 · Web app surfaces: compliant alternatives on claims, paused billing collection on hold (standard §43;
-- plan 03 A3/A5, plan 02 §2).
-- No new tables: every change extends a table already registered with forced RLS and explicit policies.

-- ───────────── Claims: the compliant alternative the rules propose ─────────────
-- A claim the rules block or restrict is shown with a factual / appearance-oriented alternative (§43 "Merchant
-- insists on blocked claim": explain the restriction and propose alternatives). Stored with the claim so the
-- Claims Vault can offer it next to the reason, as the wording the merchant can use instead.
alter table claims add column suggested_alternative text;

-- ───────────── Subscriptions: collection paused while the workspace is suspended ─────────────
-- Plan 02 §2: SUSPENDED → "Billing: Paused". When Stripe collection is paused (pause_collection, invoices voided)
-- and when it was resumed are mirrored here so the console and the billing page can say so.
alter table subscriptions add column collection_paused_at timestamptz;
