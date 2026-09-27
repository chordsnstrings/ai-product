import type { Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { audit, type Staff } from './admin';

/**
 * Platform alerts (plan 05 §1 Pulse "open queues"): raised when the system changed something on its own — an offer
 * auto-paused because its Stripe Price was archived, a pricing experiment auto-stopped by a guardrail, a landing
 * example unpublished when its rights expired, Stripe drifting from our mirror. One open alert per kind and
 * subject (a repeat is a no-op until it's resolved). Each is also written to the audit log as a system action.
 */
export interface AlertInput {
  kind: string;
  severity?: 'info' | 'warn' | 'risk';
  subject: { type: string; id: string };
  message: string;
  details?: Record<string, unknown>;
}

export async function raiseAlert(tx: Tx, a: AlertInput): Promise<string | null> {
  const [row] = await tx`
    insert into platform_alerts (kind, severity, subject_type, subject_id, message, details)
    values (${a.kind}, ${a.severity ?? 'warn'}, ${a.subject.type}, ${a.subject.id}, ${a.message}, ${tx.json((a.details ?? {}) as never)})
    on conflict (kind, subject_type, subject_id) where resolved_at is null do nothing
    returning id`;
  if (!row) return null;
  await tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, reason, after)
           values (null, '{}', ${`system.${a.kind}`}, ${a.subject.type}, ${a.subject.id}, ${a.message}, ${tx.json((a.details ?? {}) as never)})`;
  return row.id as string;
}

export async function resolveAlert(tx: Tx, s: Staff, alertId: string, resolution: string) {
  const [b] = await tx`select kind, subject_type, subject_id, resolved_at from platform_alerts where id = ${alertId} for update`;
  if (!b) throw new DomainError('NOT_FOUND', 'Alert not found');
  if (b.resolved_at) throw new DomainError('CONFLICT', 'Already resolved.');
  await tx`update platform_alerts set resolved_at = now(), resolved_by = ${s.staffId}, resolution = ${resolution} where id = ${alertId}`;
  await audit(tx, s, 'alert.resolve', { type: String(b.subject_type), id: String(b.subject_id) }, { reason: resolution, before: { kind: b.kind, open: true }, after: { open: false } });
}
