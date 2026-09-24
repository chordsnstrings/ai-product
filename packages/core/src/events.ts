import type { Tx } from '@arkiv/db';
import { assertEventPayload, EVENT_SCHEMA_VERSION, type EventType } from '@arkiv/shared';
import { actorString, type TenantContext } from './context';

/** Durable domain event (§36). Always written in the same transaction as the mutation it describes. */
export async function emit(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  type: EventType,
  subject: { type: string; id: string } | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  // One payload shape per type and schema version: tests fail on a mismatch; elsewhere it is logged, never lost.
  try {
    assertEventPayload(type, payload);
  } catch (e) {
    if (process.env.NODE_ENV === 'test') throw e;
    console.warn(`[events] ${(e as Error).message}`);
  }
  await tx`
    insert into events (workspace_id, type, actor, subject_type, subject_id, payload, schema_version)
    values (${ctx.workspaceId}, ${type}, ${actorString(ctx)}, ${subject?.type ?? null}, ${subject?.id ?? null},
            ${tx.json(payload as never)}, ${EVENT_SCHEMA_VERSION})`;
}

export async function recentEvents(tx: Tx, limit = 50, subjectId?: string) {
  return subjectId
    ? tx`select * from events where subject_id = ${subjectId} order by at desc limit ${limit}`
    : tx`select * from events order by at desc limit ${limit}`;
}
