import type { Tx } from '@arkiv/db';
import { raiseAlert } from './alerts';
import { JOB_HOLD_STATES } from './holds';
import { logger } from '@arkiv/shared/log';

const log = logger('production');

/** Plan 03 P9 edge: a production running longer than this gets a proactive email and a staff alert. */
export const PRODUCTION_DELAY_MINUTES = 20;

/** The render-to-delivery states a customer is waiting through (plan 03 P9). */
const PRODUCING = ['RENDER_RESERVED', 'RENDERING', 'QA_RUNNING', 'COMPOSING', 'PLATFORM_VARIANTS', 'FINAL_QA'];

/**
 * Productions past PRODUCTION_DELAY_MINUTES since their render was reserved (plan 03 P9 "exceeds 20 min → a
 * proactive email plus a staff alert (05-admin §12 stuck detector)"): the owners get one `production_delayed` email
 * per project (ever), and staff get one open Pulse alert per project. Workspaces on hold are paused, not late.
 * System role: every predicate ties rows to their own workspace (system_rw sees every tenant).
 */
export async function sweepDelayedProductions(tx: Tx): Promise<{ projectId: string; workspaceId: string; minutes: number }[]> {
  const rows = await tx`
    select p.id, p.workspace_id, s.name,
           floor(extract(epoch from now() - coalesce(a.created_at, p.updated_at)) / 60)::int as minutes
    from projects p
    join skus s on s.id = p.sku_id and s.workspace_id = p.workspace_id
    left join cost_authorizations a on a.id = p.authorization_id and a.workspace_id = p.workspace_id
    where p.state = any(${PRODUCING})
      and coalesce(a.created_at, p.updated_at) < now() - make_interval(mins => ${PRODUCTION_DELAY_MINUTES})
      and not exists (select 1 from workspaces w where w.id = p.workspace_id and w.state = any(${[...JOB_HOLD_STATES]}))
    limit 200`;
  const out: { projectId: string; workspaceId: string; minutes: number }[] = [];
  for (const r of rows) {
    const ws = r.workspace_id as string;
    const key = `delayed:${r.id as string}`;
    // Once per project, ever: the singleton key stays on the dispatched outbox row.
    const [queued] = await tx`insert into outbox (workspace_id, queue, payload, singleton_key)
                              select ${ws}, 'send-email', ${tx.json({ template: 'production_delayed', projectId: r.id, minutes: r.minutes, workspaceId: ws } as never)}, ${key}
                              where not exists (select 1 from outbox where workspace_id = ${ws} and queue = 'send-email' and singleton_key = ${key})
                              on conflict (workspace_id, queue, singleton_key) where singleton_key is not null and dispatched_at is null do nothing
                              returning id`;
    await raiseAlert(tx, {
      kind: 'production_delayed',
      severity: 'risk',
      subject: { type: 'project', id: r.id as string },
      message: `Production for ${r.name as string} has run ${r.minutes as number} minutes (over ${PRODUCTION_DELAY_MINUTES}). The customer was emailed.`,
      details: { workspaceId: ws, minutes: r.minutes },
    });
    if (queued) {
      log.warn('production delayed', { projectId: r.id, workspaceId: ws, minutes: r.minutes });
      out.push({ projectId: r.id as string, workspaceId: ws, minutes: r.minutes as number });
    }
  }
  return out;
}
