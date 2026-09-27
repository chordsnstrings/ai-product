import type { Tx } from '@arkiv/db';

/**
 * Plan 05 §23 "Quarterly access review checklist: every staff member's roles must be re-confirmed or they're removed
 * automatically after 14 days." A review falls due ACCESS_REVIEW_DAYS after the roles were last confirmed (or
 * granted); ACCESS_REVIEW_GRACE_DAYS later, unconfirmed roles are removed and the member's sessions end.
 */
export const ACCESS_REVIEW_DAYS = 90;
export const ACCESS_REVIEW_GRACE_DAYS = 14;

/**
 * System sweep (system role, global staff tables): remove the roles of every active member whose review lapsed,
 * end their sessions, and audit each removal as a system action (no staff id). The account stays, so a SUPER_ADMIN
 * can grant roles again through four-eyes. Returns what was removed.
 */
export async function sweepStaffAccessReview(tx: Tx): Promise<{ staffId: string; email: string; removed: string[] }[]> {
  const lapsed = await tx`
    with due as (
      select id, roles from staff_users
      where active and cardinality(roles) > 0
        and roles_confirmed_at < now() - make_interval(days => ${ACCESS_REVIEW_DAYS + ACCESS_REVIEW_GRACE_DAYS})
      for update)
    update staff_users u set roles = '{}' from due where u.id = due.id
    returning u.id, u.email, due.roles as removed`;
  for (const s of lapsed) {
    await tx`update staff_sessions set revoked_at = now() where staff_id = ${s.id} and revoked_at is null`;
    await tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, reason, before, after)
             values (null, null, 'staff.access_review_removed', 'staff', ${s.id as string},
                     ${`Roles not re-confirmed within ${ACCESS_REVIEW_GRACE_DAYS} days of the quarterly access review`},
                     ${tx.json({ roles: s.removed as string[] })}, ${tx.json({ roles: [] })})`;
  }
  return lapsed.map((s) => ({ staffId: s.id as string, email: s.email as string, removed: s.removed as string[] }));
}
