-- The platform user who authorised a pending connection (Meta's app-scoped user id), carried to the integrations
-- the merchant picks so a deauthorize / data-deletion webhook for that user can find them.
alter table pending_connections add column platform_user_id text;
