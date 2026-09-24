-- 0119 · Billing lifecycle integrity (standard §5, §7, §35, §36, §39, §42; plan 02 §2, §6).

-- ───────────── Out-of-order subscription events (§35, §39) ─────────────
-- Stripe delivers events out of order and concurrently. The subscription row records when (Stripe's event time)
-- its Stripe-side fields were last set by a customer.subscription.* event, and when its status was last set by any
-- event (subscription or invoice payment); an older event never overwrites what a newer one set.
alter table subscriptions add column stripe_event_at timestamptz;
alter table subscriptions add column status_event_at timestamptz;

-- ───────────── Promotional savings (§6) ─────────────
-- A rate table may carry `promo_paid_ppm` (the share of its list price a prepaid package actually costs). Estimates
-- and ceilings keep using the list price; a provider job records its realized cost in actual_micros and the
-- difference to the list price here, so savings are reported, never assumed.
alter table provider_jobs add column savings_micros bigint not null default 0 check (savings_micros >= 0);
