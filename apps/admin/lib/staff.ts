import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getStaffSession, normalizeIp, STAFF_COOKIE, type StaffSession } from '@arkiv/auth';
import { staffCan, type Permission, type Staff } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { consolePrefs } from './prefs';

export type StaffUser = Staff & { sessionId: string; reauthAt: Date };

/** Client IP as the proxy reports it (the first X-Forwarded-For hop), or null when unknown or malformed. */
export async function requestMeta() {
  const h = await headers();
  return { ip: normalizeIp(h.get('x-forwarded-for')?.split(',')[0] || h.get('x-real-ip')), userAgent: h.get('user-agent') };
}

const toStaff = (s: StaffSession, m: { ip: string | null; userAgent: string | null }): StaffUser => ({ staffId: s.staffId, email: s.email, name: s.name, roles: s.roles, sessionId: s.sessionId, reauthAt: s.reauthAt, ...m });

/** The signed-in staff member. The session is re-checked against IP policies on every request (plan 05 §0.1). */
export async function currentStaff(): Promise<StaffUser | null> {
  const m = await requestMeta();
  const s = await getStaffSession((await cookies()).get(STAFF_COOKIE)?.value, { ip: m.ip });
  return s ? toStaff(s, m) : null;
}

/** Page guard: no session → login; missing permission → 404 (modules a role can't use don't exist for it). */
export async function requireStaff(perm?: Permission): Promise<StaffUser> {
  const s = await currentStaff();
  if (!s) redirect('/login');
  if (perm && !staffCan(s.roles, perm)) notFound();
  await consolePrefs(); // timezone for this request's date formatting
  return s;
}

/** API guard. */
export async function apiStaff(): Promise<StaffUser> {
  const s = await currentStaff();
  if (!s) throw new DomainError('UNAUTHENTICATED', 'Session expired. Sign in again.');
  return s;
}
