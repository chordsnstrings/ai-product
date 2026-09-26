-- 0111 · Billing integrity: purchases bound to the storyboard they paid for, fraud-flagged purchases, staff-created
-- subscriptions.

-- ───────────── One-off purchases (plan 02 M9, plan 03 P8) ─────────────
-- A checkout pays for one storyboard. The payment webhook approves that storyboard (restoring it if the project
-- moved on while checkout was open), never whichever storyboard happens to be current.
alter table purchases add column storyboard_id uuid;

-- Plan 02 B9: "the asset stays accessible … unless fraud-flagged". Set when a payment is refunded as fraudulent;
-- the download route refuses the project's exports while it is set.
alter table purchases add column fraud_flagged_at timestamptz;

-- ───────────── Subscriptions (plan 02 B11) ─────────────
-- A subscription staff create in the Stripe dashboard (with workspace_id metadata) has no in-app auto-renew
-- consent: the customer agreed with staff, outside the app. Checkout-created subscriptions still carry theirs.
alter table subscriptions alter column consent_record_id drop not null;
alter table subscriptions add column source text not null default 'checkout' check (source in ('checkout', 'stripe'));
