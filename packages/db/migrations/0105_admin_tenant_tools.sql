-- 0105 · Admin console, tenant tools (plan 05 §2.2, §2.3, §3, §4): ownership transfers confirmed by the customer,
-- the Stripe invoice/dispute mirror, integration rate-limit history, stored email data for resend and preview,
-- intervention playbooks with in-app notices, SKU transfers between workspaces, failed sign-ins with edge geo,
-- and imported ad spend for CAC. Tenant tables use arkiv_tenant_table (RLS forced, app/admin/system policies);
-- staff-only tables follow the staff_users pattern (global, no app_rw read).

-- ───────────── §2.2 Members: ownership transfer with customer email confirmation ─────────────
-- Staff request a transfer (🔐, written reason); the current Owner confirms from a signed link emailed to them,
-- while signed in. Nothing changes until they confirm. One pending request per workspace.
create table ownership_transfers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  to_user_id uuid not null references users(id) on delete cascade,
  requested_by uuid not null,
  staff_name text not null,
  reason text not null,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','confirmed','declined','cancelled')),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by uuid,
  created_at timestamptz not null default now()
);
create unique index ownership_transfers_one_pending on ownership_transfers (workspace_id) where status = 'pending';
select arkiv_tenant_table('ownership_transfers', false); insert into table_registry values ('ownership_transfers','tenant');

-- The emailed link carries a token; the confirm page reads the request before any tenant context exists.
create or replace function find_ownership_transfer(p_token_hash text)
returns table (id uuid, workspace_id uuid, workspace_name text, workspace_slug text, to_user_id uuid, to_email citext,
               to_name text, staff_name text, reason text, status text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.id, t.workspace_id, w.name, w.slug, t.to_user_id, u.email, u.name, t.staff_name, t.reason, t.status, t.expires_at
  from ownership_transfers t join workspaces w on w.id = t.workspace_id join users u on u.id = t.to_user_id
  where t.token_hash = p_token_hash
$$;

-- The Owner's decision, from their own tenant context. Records it on the request and in the staff audit log
-- (plan 05 §0.4: the second step of a staff action is audited like the first). The caller swaps the roles in
-- the same transaction, so a failed swap rolls the decision back.
create or replace function ownership_transfer_decide(p_token_hash text, p_user uuid, p_confirm boolean, p_ip inet, p_user_agent text)
returns table (id uuid, to_user_id uuid, requested_by uuid, reason text)
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare r ownership_transfers%rowtype;
begin
  select * into r from ownership_transfers t where t.token_hash = p_token_hash for update;
  if not found then return; end if;
  if r.workspace_id is distinct from arkiv_current_workspace() then
    raise exception 'ownership_transfer_decide: workspace does not match tenant context' using errcode = 'insufficient_privilege';
  end if;
  if r.status <> 'pending' or r.expires_at <= now() then return; end if;
  update ownership_transfers set status = case when p_confirm then 'confirmed' else 'declined' end, decided_at = now(), decided_by = p_user
    where ownership_transfers.id = r.id;
  insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, workspace_id, reason, before, after, ip, user_agent)
    values (r.requested_by, null, case when p_confirm then 'tenant.transfer_owner_confirmed' else 'tenant.transfer_owner_declined' end,
            'workspace', r.workspace_id::text, r.workspace_id, r.reason, jsonb_build_object('transferId', r.id, 'status', 'pending'),
            jsonb_build_object('transferId', r.id, 'decidedBy', 'user:' || p_user, 'newOwner', r.to_user_id), p_ip, left(p_user_agent, 300));
  return query select r.id, r.to_user_id, r.requested_by, r.reason;
end $$;
revoke all on function find_ownership_transfer, ownership_transfer_decide from public;
grant execute on function find_ownership_transfer, ownership_transfer_decide to app_rw;

-- ───────────── §2.2 / §7 Billing: Stripe invoice and dispute mirror ─────────────
-- Upserted from webhooks (invoice.*, charge.dispute.*), keyed by the Stripe id; last_event_id records which event
-- last wrote the row. Refunds are mirrored in `refunds` (0101); one-time payments in `purchases`.
create table stripe_invoices (
  id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  stripe_subscription_id text,
  status text not null,
  billing_reason text,
  currency text not null default 'usd',
  amount_due_cents bigint not null default 0,
  amount_paid_cents bigint not null default 0,
  amount_remaining_cents bigint not null default 0,
  payment_intent_id text,
  hosted_invoice_url text,
  period_start timestamptz,
  period_end timestamptz,
  stripe_created_at timestamptz,
  last_event_id text,
  updated_at timestamptz not null default now()
);
create index stripe_invoices_ws on stripe_invoices (workspace_id, stripe_created_at desc);
select arkiv_tenant_table('stripe_invoices', false); insert into table_registry values ('stripe_invoices','tenant');

create table stripe_disputes (
  id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  charge_id text,
  payment_intent_id text,
  amount_cents bigint not null default 0,
  currency text not null default 'usd',
  reason text,
  status text not null,
  evidence_due_by timestamptz,
  stripe_created_at timestamptz,
  last_event_id text,
  updated_at timestamptz not null default now()
);
create index stripe_disputes_ws on stripe_disputes (workspace_id, stripe_created_at desc);
select arkiv_tenant_table('stripe_disputes', false); insert into table_registry values ('stripe_disputes','tenant');

-- Coupon applied by FINANCE (plan 05 §2.2 "apply coupon"); Stripe holds the discount itself.
alter table subscriptions add column coupon text;

-- ───────────── §2.2 Integrations: rate-limit history ─────────────
create table integration_rate_limits (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  integration_id uuid not null,
  provider text not null,
  message text,
  retry_after_sec int,
  at timestamptz not null default now(),
  foreign key (workspace_id, integration_id) references integrations(workspace_id, id) on delete cascade
);
create index integration_rate_limits_ws on integration_rate_limits (workspace_id, integration_id, at desc);
select arkiv_tenant_table('integration_rate_limits'); insert into table_registry values ('integration_rate_limits','tenant');
grant usage on sequence integration_rate_limits_id_seq to app_rw, admin_rw, system_rw;

-- ───────────── §2.2 Emails: resend and rendered view ─────────────
-- The template data each email was built from, with single-use links redacted by the sender (never stored).
alter table email_log add column data jsonb;

drop function email_log_open(uuid, citext, text, text, text);
create or replace function email_log_open(p_workspace uuid, p_email citext, p_template text, p_stream text, p_key text, p_data jsonb default null)
returns table (id uuid, outcome text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
  v_day int;
  v_week int;
begin
  -- A send may only be logged against the tenant the caller is acting for (or none).
  if p_workspace is not null and p_workspace is distinct from arkiv_current_workspace_or_null() then
    raise exception 'email_log_open: workspace does not match tenant context' using errcode = 'insufficient_privilege';
  end if;
  if p_stream = 'marketing' then
    select count(*) filter (where l.created_at > now() - interval '1 day'), count(*) filter (where l.created_at > now() - interval '7 days')
      into v_day, v_week from email_log l where l.to_email = p_email and l.stream = 'marketing';
    if v_day >= 1 or v_week >= 3 then return query select null::uuid, 'capped'::text; return; end if;
  end if;
  insert into email_log (workspace_id, to_email, template, stream, idempotency_key, status, data)
    values (p_workspace, p_email, p_template, p_stream, p_key, 'queued', p_data)
    on conflict (idempotency_key) do nothing returning email_log.id into v_id;
  return query select v_id, case when v_id is null then 'duplicate' else 'opened' end;
end $$;
revoke all on function email_log_open from public;
grant execute on function email_log_open to app_rw, system_rw;

-- ───────────── §2.2 Risk / §17: intervention playbooks and in-app notices ─────────────
-- Each started playbook is recorded on its flag: [{ playbook, at, by, emailed, notice }].
alter table risk_flags add column interventions jsonb not null default '[]';

-- In-app messages shown in the workspace until dismissed or expired. The app reads them and may only mark
-- them dismissed; staff and system create them.
create table workspace_notices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null default 'intervention' check (kind in ('intervention')),
  source text,
  title text not null,
  body text not null,
  link_path text check (link_path is null or (link_path like '/%' and link_path not like '//%')),
  link_label text,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  dismissed_at timestamptz,
  dismissed_by uuid
);
create index workspace_notices_active on workspace_notices (workspace_id) where dismissed_at is null;
select arkiv_tenant_table('workspace_notices', false); insert into table_registry values ('workspace_notices','tenant');
grant update (dismissed_at, dismissed_by) on workspace_notices to app_rw;

-- ───────────── §2.3 Transfer SKU to workspace ─────────────
-- One row per staff-requested transfer (the owner's written consent is referenced), completed by one worker
-- job that copies the SKU subtree with new ids. Staff/system only.
create table sku_transfers (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null,
  from_workspace_id uuid not null references workspaces(id),
  to_workspace_id uuid not null references workspaces(id),
  new_sku_id uuid,
  consent_ref text not null,
  reason text not null,
  requested_by uuid not null,
  status text not null default 'queued' check (status in ('queued','completed','failed')),
  counts jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (from_workspace_id <> to_workspace_id)
);
create unique index sku_transfers_one_open on sku_transfers (sku_id) where status = 'queued';
grant select, insert on sku_transfers to admin_rw;
grant select, update on sku_transfers to system_rw;
insert into table_registry values ('sku_transfers', 'global');

-- ───────────── §3 Users: failed sign-ins and session location ─────────────
-- Written by the customer app on each failed sign-in (it cannot read them back); read by staff.
create table login_attempts (
  id bigserial primary key,
  email citext,
  user_id uuid,
  method text not null check (method in ('magic_link','passkey','google','apple')),
  outcome text not null default 'failed' check (outcome in ('failed','locked')),
  reason text,
  ip inet,
  user_agent text,
  geo jsonb,
  at timestamptz not null default now()
);
create index login_attempts_user on login_attempts (user_id, at desc);
create index login_attempts_email on login_attempts (email, at desc);
grant insert on login_attempts to app_rw;
grant usage on sequence login_attempts_id_seq to app_rw;
grant select on login_attempts to admin_rw;
grant select, delete on login_attempts to system_rw;
insert into table_registry values ('login_attempts', 'global');

-- City/region/country from the edge's visitor-location headers, when the edge provides them.
alter table sessions add column geo jsonb;

-- ───────────── §4 CAC: imported ad spend ─────────────
-- Manually imported CSV in V1 (one row per day × source × campaign × ad); a re-import of the same key updates it.
create table ad_spend (
  id bigserial primary key,
  date date not null,
  source text not null,
  campaign text not null default '',
  ad_id text not null default '',
  spend_micros bigint not null check (spend_micros >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  import_batch uuid not null,
  imported_by uuid not null,
  created_at timestamptz not null default now(),
  unique (date, source, campaign, ad_id)
);
grant select, insert, update, delete on ad_spend to admin_rw;
grant usage on sequence ad_spend_id_seq to admin_rw;
insert into table_registry values ('ad_spend', 'global');
