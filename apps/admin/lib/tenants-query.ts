import type { Tx } from '@arkiv/db';
import { RISK_BAND_MIN, RISK_WEIGHTS } from '@arkiv/core';
import { COST_LIMITS, PLANS } from '@arkiv/shared';
import { integrationFresh } from './sql';

/**
 * Tenant list query (plan 05 §2.1), shared by the page and its CSV export so both apply the same filters.
 * Metadata only — no tenant content.
 */
export const TENANT_FILTER_KEYS = ['q', 'state', 'plan', 'risk', 'integration', 'from', 'to', 'filter', 'test'] as const;
export type TenantFilters = Partial<Record<(typeof TENANT_FILTER_KEYS)[number], string>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Keep only known filter keys with non-empty values (also what a saved view stores). */
export function tenantFilters(raw: Record<string, string | string[] | undefined>): TenantFilters {
  const out: TenantFilters = {};
  for (const k of TENANT_FILTER_KEYS) {
    const v = raw[k];
    const s = (Array.isArray(v) ? v[0] : v)?.trim();
    if (s) out[k] = s.slice(0, 200);
  }
  if (out.from && !DATE.test(out.from)) delete out.from;
  if (out.to && !DATE.test(out.to)) delete out.to;
  return out;
}

/**
 * 30-day COGS cap per workspace (the "over COGS cap" filter): each Creative Test in the plan and each paid
 * one-time ad may cost up to the standard test ceiling (standard §5); a workspace without a paid plan gets the
 * free-preview and storyboard caps per SKU.
 */
export function cogsCap30(w: { plan: string | null; paying: boolean; oneTimePaid30: number; skus: number; freeCapMicros?: number }): number {
  const ceiling = COST_LIMITS.CREATIVE_TEST_CEILING;
  const planTests = w.paying && w.plan && w.plan in PLANS ? PLANS[w.plan as keyof typeof PLANS].creativeTestsPerMonth : 0;
  const free = w.paying ? 0 : w.skus * ((w.freeCapMicros ?? COST_LIMITS.FREE_PREVIEW_CAP) + COST_LIMITS.STORYBOARD_CAP);
  return planTests * ceiling + w.oneTimePaid30 * ceiling + free;
}

export function tenantRows(tx: Tx, f: TenantFilters, opts: { limit: number; tz: string; freeCapMicros: number }) {
  const q = f.q ?? '';
  const planTests = tx.json(Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, p.creativeTestsPerMonth])));
  const weights = tx.json(RISK_WEIGHTS);
  const ceiling = COST_LIMITS.CREATIVE_TEST_CEILING;
  const perFreeSku = opts.freeCapMicros + COST_LIMITS.STORYBOARD_CAP;
  return tx`
    with base as (
      select w.id, w.name, w.slug, w.state, w.plan_code, w.created_at, w.is_vip, w.is_test, w.tags, w.stripe_customer_id,
        w.state in ('ACTIVE_PAID','PAST_DUE') and w.plan_code is not null as paying,
        (select max(s.last_seen_at) from sessions s join memberships m on m.user_id = s.user_id where m.workspace_id = w.id) as last_active,
        (select count(*) from skus where workspace_id = w.id)::int as skus,
        (select coalesce(sum(amount), 0) from ledger_entries where workspace_id = w.id and type = 'PROVIDER_COST_RECORDED' and created_at > now() - interval '30 days')::bigint as cogs30,
        (select coalesce(sum(amount_micros), 0) from purchases where workspace_id = w.id and status = 'paid' and paid_at > now() - interval '30 days')::bigint as rev30,
        (select count(*) from purchases where workspace_id = w.id and status = 'paid' and paid_at > now() - interval '30 days')::int as onetime30,
        (select to_char(current_period_start at time zone 'UTC', 'YYYY-MM-DD') from subscriptions where workspace_id = w.id and status in ('active','trialing','past_due') order by created_at desc limit 1) as period,
        (select coalesce(sum(amount), 0) from ledger_entries where workspace_id = w.id and unit = 'creative_test'
           and type in ('CREDIT_GRANTED','CREDIT_RESERVED','CREDIT_RELEASED','CREDIT_REFUNDED','CREDIT_EXPIRED','CREDIT_ADJUSTED'))::int as tests_available,
        (select least(100, coalesce(sum(coalesce((${weights}->>indicator)::int, 10)), 0)) from (select distinct indicator from risk_flags r where r.workspace_id = w.id and r.resolved_at is null) f)::int as risk_score,
        (select coalesce(json_agg(json_build_object('provider', i.provider, 'status', i.status, 'fresh', ${integrationFresh(tx, 'i')}) order by i.provider), '[]')
           from integrations i where i.workspace_id = w.id and i.status <> 'disconnected') as conns
      from workspaces w
      where (${f.test === '1'} or not w.is_test)
        and (${f.state ?? ''} = '' or w.state = ${f.state ?? ''})
        and (${f.plan ?? ''} = '' or w.plan_code = ${f.plan ?? ''})
        and (${f.from ?? ''} = '' or w.created_at >= (${f.from ?? '1970-01-01'}::date)::timestamp at time zone ${opts.tz})
        and (${f.to ?? ''} = '' or w.created_at < ((${f.to ?? '1970-01-01'}::date + 1)::timestamp at time zone ${opts.tz}))
        and (${f.filter !== 'past_due'} or w.state = 'PAST_DUE')
        and (${f.filter !== 'paid_no_export'} or (exists (select 1 from purchases p where p.workspace_id = w.id and p.status = 'paid')
              and not exists (select 1 from events e where e.workspace_id = w.id and e.type = 'ASSET_EXPORTED')))
        and (${q} = '' or w.name ilike ${'%' + q + '%'} or w.slug ilike ${'%' + q + '%'} or w.id::text = ${q}
             or exists (select 1 from memberships m join users u on u.id = m.user_id where m.workspace_id = w.id and u.email = ${q.toLowerCase()})
             or w.stripe_customer_id = ${q}
             or exists (select 1 from integrations i where i.workspace_id = w.id and i.external_account_id in (${q}, ${'act_' + q})))
    ),
    rows as (
      select b.*,
        (select coalesce(sum(amount) filter (where type = 'CREDIT_GRANTED'), 0) from ledger_entries where workspace_id = b.id and unit = 'creative_test' and period_key = b.period)::int as tests_granted,
        (select coalesce(sum(-amount) filter (where type = 'CREDIT_RESERVED'), 0) - coalesce(sum(amount) filter (where type in ('CREDIT_RELEASED','CREDIT_REFUNDED')), 0)
           from ledger_entries where workspace_id = b.id and unit = 'creative_test' and period_key = b.period)::int as tests_used,
        case when b.paying then coalesce((${planTests}->>b.plan_code)::bigint, 0) * ${ceiling} else 0 end
          + b.onetime30 * ${ceiling}
          + case when b.paying then 0 else b.skus * ${perFreeSku} end as cogs_cap30,
        case when b.risk_score >= ${RISK_BAND_MIN.high} then 'high' when b.risk_score >= ${RISK_BAND_MIN.medium} then 'medium' else 'low' end as risk_band
      from base b
    )
    select * from rows
    where (${f.risk ?? ''} = '' or risk_band = ${f.risk ?? ''} or (${f.risk === 'any' || f.risk === '1'} and risk_score > 0))
      and (${f.filter !== 'over_cogs_cap'} or cogs30 > cogs_cap30)
      and (${f.integration ?? ''} = ''
           or (${f.integration === 'none'} and json_array_length(conns) = 0)
           or (${f.integration === 'healthy'} and json_array_length(conns) > 0 and not exists (select 1 from json_array_elements(conns) c where not (c->>'fresh')::boolean))
           or (${f.integration === 'stale'} and exists (select 1 from json_array_elements(conns) c where c->>'status' = 'active' and not (c->>'fresh')::boolean))
           or (${f.integration === 'degraded'} and exists (select 1 from json_array_elements(conns) c where c->>'status' in ('degraded','revoked','paused'))))
    order by created_at desc limit ${opts.limit}`;
}
