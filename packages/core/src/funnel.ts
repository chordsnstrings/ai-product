import { globalTx, type Tx } from '@arkiv/db';
import type { EventType } from '@arkiv/shared';

/** Server-side funnel events (plan 04 §1) — the source of truth; client analytics are secondary. */
export async function recordFunnel(
  type: EventType,
  data: {
    visitorId?: string | null;
    workspaceId?: string | null;
    page?: string | null;
    variant?: string | null;
    utm?: Record<string, string> | null;
    props?: Record<string, unknown>;
  },
  tx?: Tx,
): Promise<void> {
  const run = (t: Tx) => t`
    insert into funnel_events (type, visitor_id, workspace_id, page, variant, utm, props)
    values (${type}, ${data.visitorId ?? null}, ${data.workspaceId ?? null}, ${data.page ?? null},
            ${data.variant ?? null}, ${data.utm ? t.json(data.utm) : null}, ${t.json((data.props ?? {}) as never)})`;
  if (tx) await run(tx);
  else await globalTx(run);
}

/**
 * The anonymous visitor whose free preview created this project's SKU (skus.origin_visitor_id). Later funnel
 * stages carry it, so a preview merged into an existing account (moveProvisionalSkus) keeps its first-touch
 * attribution instead of inheriting the target workspace's.
 */
export async function projectVisitor(tx: Tx, workspaceId: string, projectId: string): Promise<string | null> {
  const [r] = await tx`select s.origin_visitor_id from projects p join skus s on s.id = p.sku_id and s.workspace_id = p.workspace_id
                       where p.id = ${projectId} and p.workspace_id = ${workspaceId}`;
  return (r?.origin_visitor_id as string | null) ?? null;
}

/** Workspace-level stages (a subscription) go to the most recent previewed SKU's visitor, when there is one. */
export async function workspaceVisitor(tx: Tx, workspaceId: string): Promise<string | null> {
  const [r] = await tx`select origin_visitor_id from skus where workspace_id = ${workspaceId} and origin_visitor_id is not null order by created_at desc limit 1`;
  return (r?.origin_visitor_id as string | null) ?? null;
}

export const FUNNEL_SLICES = ['page', 'variant', 'utm_source', 'utm_campaign', 'utm_content', 'in_app'] as const;
export type FunnelSlice = (typeof FUNNEL_SLICES)[number];

/**
 * Unique visitors per stage, attributed to the slice of each visitor's first landing view (plan 05 §4). An event
 * without a visitor falls back to the earliest visitor seen on its workspace. Test workspaces are excluded
 * unless asked for (§2.3).
 */
export async function funnelBySlice(tx: Tx, opts: { by: FunnelSlice; days: number; includeTest?: boolean }) {
  const { by, days } = opts;
  const rows = await tx`
    with first_touch as (
      select distinct on (visitor_id) visitor_id,
        case ${by} when 'page' then coalesce(page, '(none)') when 'variant' then coalesce(variant, '(none)')
          when 'in_app' then coalesce(props->>'inApp', 'false') else coalesce(utm->>${by}, '(none)') end as slice
      from funnel_events where type = 'LP_VIEWED' and at > now() - make_interval(days => ${days}) and visitor_id is not null order by visitor_id, at),
    ws_visitor as (select distinct on (workspace_id) workspace_id, visitor_id from funnel_events where visitor_id is not null and workspace_id is not null order by workspace_id, at),
    ev as (
      select f.type, coalesce(f.visitor_id, wv.visitor_id) as vid from funnel_events f left join ws_visitor wv on wv.workspace_id = f.workspace_id
      where f.at > now() - make_interval(days => ${days})
        and (${!!opts.includeTest} or f.workspace_id is null or f.workspace_id not in (select id from workspaces where is_test)))
    select coalesce(ft.slice, '(unattributed)') as slice, ev.type, count(distinct ev.vid)::int as n
    from ev left join first_touch ft on ft.visitor_id = ev.vid group by 1, 2`;
  return rows.map((r) => ({ slice: r.slice as string, type: r.type as EventType, n: Number(r.n) }));
}
