import type { Tx } from '@arkiv/db';
import { assertEventEnvelope, assertEventPayload, eventRefs, EVENT_SCHEMA_VERSION, type EventRefs, type EventType } from '@arkiv/shared';
import { actorString, type TenantContext } from './context';

/**
 * Durable domain event (§36). Always written in the same transaction as the mutation it describes. Carries actor,
 * timestamp, tenant, schema version, one subject (its type fixed per event type, EVENT_SUBJECT) and the related
 * object IDs in `refs` (the subject's own id included), so downstream state can be rebuilt from events.
 */
export async function emit(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  type: EventType,
  subject: { type: string; id: string } | null,
  payload: Record<string, unknown> = {},
  refs: EventRefs = {},
): Promise<void> {
  const allRefs = eventRefs(subject, refs);
  // One payload shape, subject type and set of object IDs per type and schema version: tests fail on a mismatch;
  // elsewhere it is logged, never lost.
  try {
    assertEventPayload(type, payload);
    assertEventEnvelope(type, subject, allRefs);
  } catch (e) {
    if (process.env.NODE_ENV === 'test') throw e;
    console.warn(`[events] ${(e as Error).message}`);
  }
  await tx`
    insert into events (workspace_id, type, actor, subject_type, subject_id, payload, refs, schema_version)
    values (${ctx.workspaceId}, ${type}, ${actorString(ctx)}, ${subject?.type ?? null}, ${subject?.id ?? null},
            ${tx.json(payload as never)}, ${tx.json(allRefs)}, ${EVENT_SCHEMA_VERSION})`;
}

export async function recentEvents(tx: Tx, limit = 50, subjectId?: string) {
  return subjectId
    ? tx`select * from events where subject_id = ${subjectId} order by at desc limit ${limit}`
    : tx`select * from events order by at desc limit ${limit}`;
}

/**
 * Events that reference an object (by any ref, not only the subject): the history a projection is rebuilt from.
 * Events written before refs existed are matched by their subject. Ordered by `seq` (write order, also within a
 * transaction, whose events share one timestamp).
 */
export async function eventsFor(tx: Tx, ref: { key: keyof EventRefs & string; id: string }, limit = 500) {
  return tx`select * from events where refs @> ${tx.json({ [ref.key]: ref.id })} or subject_id = ${ref.id} order by seq limit ${limit}`;
}
