import type { Tx } from '@arkiv/db';

/**
 * What a result means beyond its numbers (standard §13 Results: "Explain what changed between test variants and
 * what the result does to future recommendations"; plan 03 A6 edge: late conversions → "Updated … with history").
 * Tenant reads (RLS scopes every table to the workspace).
 */

/** How each variant differs from the others: what it changes and what it keeps the same. */
export interface VariantChange {
  variantId: string;
  code: string;
  label: string;
  role: string;
  changed: string[];
  heldConstant: string[];
}

export function variantChanges(variants: readonly Record<string, unknown>[]): VariantChange[] {
  return variants.map((v) => ({
    variantId: v.id as string,
    code: v.code as string,
    label: v.label as string,
    role: v.role as string,
    changed: ((v.changed_variables as string[] | null) ?? []).filter(Boolean),
    heldConstant: ((v.held_constant as string[] | null) ?? []).filter(Boolean),
  }));
}

/** The learnings this test supports or contradicts, and the open or accepted recommendations they shape. */
export async function resultEffects(tx: Tx, experimentId: string) {
  const learnings = await tx`select id, statement, state, confidence, last_revalidated_at,
                                    ${experimentId}::uuid = any(supporting_experiments) as supports
                             from learnings
                             where ${experimentId}::uuid = any(supporting_experiments) or ${experimentId}::uuid = any(contradicting_experiments)
                             order by last_revalidated_at desc limit 20`;
  const ids = learnings.map((l) => l.id as string);
  const recs = ids.length
    ? await tx`select r.id, r.proposal->>'hypothesis' as hypothesis, r.slot, r.status, r.week_of, s.name as sku
               from recommendations r join skus s on s.id = r.sku_id
               where r.rationale_ids && ${ids}::uuid[] and r.status in ('open','accepted') order by r.week_of desc, r.score desc limit 10`
    : [];
  return {
    learnings: learnings.map((l) => ({ id: l.id as string, statement: l.statement as string, state: l.state as string, supports: !!l.supports, revalidatedAt: new Date(l.last_revalidated_at as string) })),
    recommendations: recs.map((r) => ({ id: r.id as string, hypothesis: (r.hypothesis as string | null) ?? '', slot: r.slot as string, status: r.status as string, weekOf: String(r.week_of), sku: r.sku as string })),
  };
}

export interface Revision {
  variantId: string;
  revisedOn: string;
  days: number;
  before: { impressions: number; clicks: number; purchases: number };
  after: { impressions: number; clicks: number; purchases: number };
}

/**
 * Late-conversion revisions of this test's numbers: for each variant and day a revision landed, the replaced
 * rows' totals and the same ad-days as they stand now.
 */
export async function resultRevisions(tx: Tx, variantIds: readonly string[]): Promise<Revision[]> {
  if (!variantIds.length) return [];
  const rows = await tx`
    with old as (
      select o.variant_id, o.platform, o.ad_id, o.date, o.measurement_context, o.attribution_window,
             (o.superseded_at at time zone 'UTC')::date as revised_on, o.impressions, o.clicks, o.purchases
      from performance_observations o
      where o.variant_id = any(${[...variantIds]}::uuid[]) and o.superseded_at is not null
    )
    select old.variant_id, old.revised_on::text as revised_on, count(distinct old.date)::int as days,
           sum(old.impressions)::bigint as b_i, sum(old.clicks)::bigint as b_c, sum(old.purchases)::bigint as b_p,
           coalesce(sum(cur.impressions), 0)::bigint as a_i, coalesce(sum(cur.clicks), 0)::bigint as a_c, coalesce(sum(cur.purchases), 0)::bigint as a_p
    from old
    left join lateral (
      select c.impressions, c.clicks, c.purchases from performance_observations c
      where c.platform = old.platform and c.ad_id = old.ad_id and c.date = old.date and c.measurement_context = old.measurement_context
        and c.attribution_window = old.attribution_window and c.superseded_at is null
      limit 1
    ) cur on true
    group by old.variant_id, old.revised_on
    order by old.revised_on desc, old.variant_id
    limit 50`;
  return rows.map((r) => ({
    variantId: r.variant_id as string,
    revisedOn: r.revised_on as string,
    days: Number(r.days),
    before: { impressions: Number(r.b_i), clicks: Number(r.b_c), purchases: Number(r.b_p) },
    after: { impressions: Number(r.a_i), clicks: Number(r.a_c), purchases: Number(r.a_p) },
  }));
}
