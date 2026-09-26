-- 0007 · Narrow cross-tenant lookups for funnel routes. They reveal only a workspace id for an unguessable
-- project id; callers must still prove membership or hold the matching provisional cookie (plan 02 §3 layer 1).
create or replace function project_workspace(p_project uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select workspace_id from projects where id = p_project
$$;
revoke all on function project_workspace from public;
grant execute on function project_workspace to app_rw;

create or replace function sku_workspace(p_sku uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select workspace_id from skus where id = p_sku
$$;
revoke all on function sku_workspace from public;
grant execute on function sku_workspace to app_rw;
