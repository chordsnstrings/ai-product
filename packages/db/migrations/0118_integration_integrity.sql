-- 0118 · Integration integrity (standard §27–§31, §42, §45, §47; plan 02 §3 layer 8; plan 06 Phase 5 #1).

-- ───────────── One Shopify id form, one SKU per Shopify product (§42 "Duplicate import") ─────────────
-- The storefront JSON (URL import) carries the bare numeric id, the Admin GraphQL API the global id. Both now
-- store the gid; existing numeric ids are converted so a later store sync finds the URL-imported SKU.
update skus set shopify_product_id = 'gid://shopify/Product/' || shopify_product_id where shopify_product_id ~ '^\d+$';
-- Duplicates that the mismatch already created keep the oldest SKU as the product's match (the others stay,
-- unlinked, for the merchant to merge or archive).
update skus s set shopify_product_id = null
where shopify_product_id is not null and exists (
  select 1 from skus o where o.workspace_id = s.workspace_id and o.shopify_product_id = s.shopify_product_id
    and (o.created_at, o.id) < (s.created_at, s.id));
create unique index skus_shopify_product on skus (workspace_id, shopify_product_id) where shopify_product_id is not null;

-- Variant ids the same way (a gid twin from a store sync already exists → the numeric row is left to lapse).
update sku_variants v set external_id = 'gid://shopify/ProductVariant/' || v.external_id
where v.source = 'shopify' and v.external_id ~ '^\d+$'
  and not exists (select 1 from sku_variants t where t.workspace_id = v.workspace_id and t.sku_id = v.sku_id and t.source = 'shopify'
                  and t.external_id = 'gid://shopify/ProductVariant/' || v.external_id);

-- ───────────── Adapter versioning (§47 "API schema change") ─────────────
alter table performance_observations add column adapter_version text;

-- ───────────── Granted scopes and token expiry through the account picker (§27, plan 05 §16) ─────────────
alter table pending_connections add column scopes text[] not null default '{}';
alter table pending_connections add column token_expires_at timestamptz;

-- ───────────── Freshness and expiry notices (Appendix B DATA_FRESHNESS_CHANGED; §31) ─────────────
-- When the connection was last announced stale (reset by a successful sync), and when its token expiry warning
-- went out (reset when a new token is saved): each notice goes out once.
alter table integrations add column stale_notified_at timestamptz;
alter table integrations add column expiry_warned_at timestamptz;

-- ───────────── Shopify store transfer (plan 02 §3 layer 8; plan 06 Phase 5 #1) ─────────────
-- A workspace that connects a store routed to another workspace may request a transfer. The current owner
-- workspace approves (or rejects); staff may approve after 14 days when the requester proved control of the store
-- with a fresh Shopify OAuth. The row is visible to both workspaces: the requester (workspace_id) and the current
-- owner (from_workspace_id).
create table shop_transfer_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  from_workspace_id uuid not null references workspaces(id) on delete cascade,
  shop_domain text not null,
  requested_by uuid not null,
  requester_email text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled','expired')),
  -- What the requester proved at request time: a completed Shopify OAuth for this shop (never the token).
  proof jsonb not null default '{}',
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create unique index shop_transfer_pending on shop_transfer_requests (shop_domain, workspace_id) where status = 'pending';
create index shop_transfer_from on shop_transfer_requests (from_workspace_id, status);
alter table shop_transfer_requests enable row level security;
alter table shop_transfer_requests force row level security;
-- Both parties read the request; only the current owner's workspace records a decision on it.
create policy tenant_isolation on shop_transfer_requests for select to app_rw
  using (workspace_id = arkiv_current_workspace() or from_workspace_id = arkiv_current_workspace());
create policy owner_decides on shop_transfer_requests for update to app_rw
  using (from_workspace_id = arkiv_current_workspace()) with check (from_workspace_id = arkiv_current_workspace());
create policy staff_access on shop_transfer_requests to admin_rw using (true) with check (true);
create policy system_access on shop_transfer_requests to system_rw using (true) with check (true);
do $$ begin execute format('create policy owner_access on shop_transfer_requests to %I using (true) with check (true)', current_user); end $$;
-- The app inserts only through shop_transfer_request() below; it updates status when a party decides.
grant select on shop_transfer_requests to app_rw;
grant update (status, decided_by, decided_at, decision_note) on shop_transfer_requests to app_rw;
grant select, insert, update on shop_transfer_requests to admin_rw, system_rw;
insert into table_registry values ('shop_transfer_requests', 'tenant');

-- Who owns the store now, masked for the requester (plan 02: "owner a•••@brand.com"): the first owner's address.
create or replace function shop_owner_hint(p_shop text) returns text
language sql stable security definer set search_path = public as $$
  select left(split_part(u.email, '@', 1), 1) || '•••@' || split_part(u.email, '@', 2)
  from shopify_shops s
  join memberships m on m.workspace_id = s.workspace_id and m.role = 'OWNER'
  join users u on u.id = m.user_id and u.deleted_at is null
  where s.shop_domain = p_shop and s.workspace_id <> arkiv_current_workspace()
  order by m.created_at limit 1
$$;

-- File a transfer request from the current workspace and queue the owner-approval email in the owning workspace.
-- Security definer: the requester can neither see the owning workspace nor write its outbox.
create or replace function shop_transfer_request(p_shop text, p_requested_by uuid, p_requester_email text, p_proof jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_to uuid := arkiv_current_workspace();
  v_from uuid;
  v_id uuid;
begin
  select workspace_id into v_from from shopify_shops where shop_domain = p_shop;
  if v_from is null or v_from = v_to then return null; end if;
  select id into v_id from shop_transfer_requests where shop_domain = p_shop and workspace_id = v_to and status = 'pending';
  if v_id is not null then return v_id; end if;
  insert into shop_transfer_requests (workspace_id, from_workspace_id, shop_domain, requested_by, requester_email, proof)
  values (v_to, v_from, p_shop, p_requested_by, p_requester_email, coalesce(p_proof, '{}'::jsonb))
  returning id into v_id;
  insert into outbox (workspace_id, queue, payload, singleton_key)
  values (v_from, 'send-email', jsonb_build_object('template', 'shop_transfer_request', 'requestId', v_id, 'workspaceId', v_from), 'shop-transfer:' || v_id::text)
  on conflict do nothing;
  return v_id;
end $$;
revoke all on function shop_owner_hint, shop_transfer_request from public;
grant execute on function shop_owner_hint, shop_transfer_request to app_rw;
