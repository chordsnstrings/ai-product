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
